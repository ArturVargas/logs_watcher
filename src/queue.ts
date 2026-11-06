import type { Pool, PoolClient } from 'pg';
import type { JobRow, JsonRecord, Target } from './types.js';
import { asRecord, asString } from './types.js';
import { scrub } from './scrub.js';

const LOG_KEYS = ['jobId', 'kind', 'sentryIssueId', 'githubIssue', 'pr', 'durationMs', 'proposalId', 'targetId'] as const;

export function log(fields: { level?: string; msg: string } & JsonRecord): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: fields.level ?? 'info',
    msg: fields.msg,
  };
  for (const key of LOG_KEYS) {
    if (fields[key] != null) line[key] = fields[key];
  }
  console.log(JSON.stringify(line));
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err: unknown) {
    try { await client.query('ROLLBACK'); } catch { /* transaction already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

type Db = Pool | PoolClient;

export async function releaseStaleLocks(db: Db): Promise<void> {
  await db.query(`UPDATE jobs SET state = 'dead', locked_at = NULL
    WHERE state = 'running' AND locked_at < now() - interval '5 minutes' AND attempts >= 5`);
  await db.query(`UPDATE jobs SET state = 'queued', locked_at = NULL, run_after = now()
    WHERE state = 'running' AND locked_at < now() - interval '5 minutes' AND attempts < 5`);
}

export async function claimJob(pool: Pool): Promise<JobRow | null> {
  return withTx(pool, async (client) => {
    await releaseStaleLocks(client);
    const { rows } = await client.query<{ id: string; kind: string; attempts: number; payload: unknown }>(
      `SELECT id, kind, attempts, payload FROM jobs
      WHERE state = 'queued' AND run_after <= now()
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const updated = await client.query<{ attempts: number }>(
      `UPDATE jobs SET state = 'running', locked_at = now(), attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [row.id],
    );
    return {
      id: row.id,
      kind: row.kind,
      attempts: updated.rows[0]?.attempts ?? row.attempts,
      payload: asRecord(row.payload),
    };
  });
}

export async function finishJob(
  pool: Pool,
  id: string,
  state: string,
  extra: { lastError?: string | null; runAfter?: Date | null } = {},
): Promise<void> {
  const lastError = extra.lastError == null ? null : scrub(String(extra.lastError)).slice(0, 500);
  await pool.query(
    `UPDATE jobs SET state = $2, locked_at = NULL, last_error = $3, run_after = COALESCE($4, run_after) WHERE id = $1`,
    [id, state, lastError, extra.runAfter ?? null],
  );
}

export async function spentUsd(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ usd: number }>(
    `SELECT COALESCE(SUM(usd), 0)::float8 AS usd FROM cost_ledger WHERE day = (now() AT TIME ZONE 'UTC')::date`,
  );
  return Number(rows[0]?.usd ?? 0);
}

export async function addCost(
  pool: Pool,
  args: { kind: string; inputTokens: number; outputTokens: number; usd: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO cost_ledger (id, day, kind, input_tokens, output_tokens, usd, created_at)
     VALUES (gen_random_uuid(), (now() AT TIME ZONE 'UTC')::date, $1, $2, $3, $4, now())`,
    [args.kind, args.inputTokens, args.outputTokens, args.usd],
  );
}

export function dedupeKey(targetId: string, sentryIssueId: string): string {
  return `classify:${targetId}:${sentryIssueId}`;
}

export async function enqueueReview(
  client: PoolClient,
  args: { target: Pick<Target, 'id'>; deliveryId: string; number: number; sha: string },
): Promise<void> {
  const payload = {
    targetId: args.target.id,
    deliveryId: args.deliveryId,
    number: args.number,
    sha: args.sha,
  };
  await client.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'review_pr', $1, 'queued', now(), $2::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [`review:${args.target.id}:${args.number}:${args.sha}`, JSON.stringify(payload)],
  );
}

export async function enqueueClassify(
  client: PoolClient,
  args: { target: Pick<Target, 'id' | 'issueLanguage'>; sentryIssueId: string; deliveryId: string },
): Promise<{ enqueued: boolean }> {
  await client.query(
    `INSERT INTO groups (target_id, sentry_issue_id, issue_language, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [args.target.id, args.sentryIssueId, args.target.issueLanguage || 'both'],
  );
  const key = dedupeKey(args.target.id, args.sentryIssueId);
  const payload = { targetId: args.target.id, sentryIssueId: args.sentryIssueId, deliveryId: args.deliveryId };
  const inserted = await client.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', $1, 'queued', now(), $2::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [key, JSON.stringify(payload)],
  );
  if ((inserted.rowCount ?? 0) > 0) return { enqueued: true };
  const current = await client.query<{ state: string }>(`SELECT state FROM jobs WHERE dedupe_key = $1`, [key]);
  const state = current.rows[0]?.state;
  if (state === 'queued' || state === 'running') {
    await client.query(
      `UPDATE groups SET dirty = true, updated_at = now() WHERE target_id = $1 AND sentry_issue_id = $2`,
      [args.target.id, args.sentryIssueId],
    );
  } else if (state === 'done') {
    await client.query(
      `UPDATE jobs SET state = 'queued', locked_at = NULL, run_after = now(), payload = $2::jsonb WHERE dedupe_key = $1`,
      [key, JSON.stringify(payload)],
    );
  }
  return { enqueued: false };
}
