import { scrub } from './scrub.js';

const LOG_KEYS = ['jobId', 'kind', 'sentryIssueId', 'githubIssue', 'pr', 'durationMs', 'proposalId', 'targetId'];

export function log(fields) {
  const line = { ts: new Date().toISOString(), level: fields.level || 'info', msg: fields.msg };
  for (const key of LOG_KEYS) {
    if (fields[key] != null) line[key] = fields[key];
  }
  console.log(JSON.stringify(line));
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaction already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseStaleLocks(db) {
  await db.query(`UPDATE jobs SET state = 'dead', locked_at = NULL
    WHERE state = 'running' AND locked_at < now() - interval '5 minutes' AND attempts >= 5`);
  await db.query(`UPDATE jobs SET state = 'queued', locked_at = NULL, run_after = now()
    WHERE state = 'running' AND locked_at < now() - interval '5 minutes' AND attempts < 5`);
}

export async function claimJob(pool) {
  return withTx(pool, async (client) => {
    await releaseStaleLocks(client);
    const { rows } = await client.query(`SELECT id, kind, attempts, payload FROM jobs
      WHERE state = 'queued' AND run_after <= now()
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`);
    if (!rows[0]) return null;
    const updated = await client.query(
      `UPDATE jobs SET state = 'running', locked_at = now(), attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [rows[0].id],
    );
    return { ...rows[0], attempts: updated.rows[0].attempts };
  });
}

export async function finishJob(pool, id, state, extra = {}) {
  const lastError = extra.lastError == null ? null : scrub(String(extra.lastError)).slice(0, 500);
  await pool.query(
    `UPDATE jobs SET state = $2, locked_at = NULL, last_error = $3, run_after = COALESCE($4, run_after) WHERE id = $1`,
    [id, state, lastError, extra.runAfter ?? null],
  );
}

export async function spentUsd(pool) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(usd), 0)::float8 AS usd FROM cost_ledger WHERE day = (now() AT TIME ZONE 'UTC')::date`,
  );
  return Number(rows[0].usd);
}

export async function addCost(pool, { kind, inputTokens, outputTokens, usd }) {
  await pool.query(
    `INSERT INTO cost_ledger (id, day, kind, input_tokens, output_tokens, usd, created_at)
     VALUES (gen_random_uuid(), (now() AT TIME ZONE 'UTC')::date, $1, $2, $3, $4, now())`,
    [kind, inputTokens, outputTokens, usd],
  );
}

export function dedupeKey(targetId, sentryIssueId) {
  return `classify:${targetId}:${sentryIssueId}`;
}

export async function enqueueReview(client, { target, deliveryId, number, sha }) {
  const payload = { targetId: target.id, deliveryId, number, sha };
  await client.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'review_pr', $1, 'queued', now(), $2::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [`review:${target.id}:${number}:${sha}`, JSON.stringify(payload)],
  );
}

export async function enqueueClassify(client, { target, sentryIssueId, deliveryId }) {
  await client.query(
    `INSERT INTO groups (target_id, sentry_issue_id, issue_language, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [target.id, sentryIssueId, target.issueLanguage || 'both'],
  );
  const key = dedupeKey(target.id, sentryIssueId);
  const payload = { targetId: target.id, sentryIssueId, deliveryId };
  const inserted = await client.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', $1, 'queued', now(), $2::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [key, JSON.stringify(payload)],
  );
  if (inserted.rowCount > 0) return { enqueued: true };
  const current = await client.query(`SELECT state FROM jobs WHERE dedupe_key = $1`, [key]);
  const state = current.rows[0]?.state;
  if (state === 'queued' || state === 'running') {
    await client.query(
      `UPDATE groups SET dirty = true, updated_at = now() WHERE target_id = $1 AND sentry_issue_id = $2`,
      [target.id, sentryIssueId],
    );
  } else if (state === 'done') {
    await client.query(
      `UPDATE jobs SET state = 'queued', locked_at = NULL, run_after = now(), payload = $2::jsonb WHERE dedupe_key = $1`,
      [key, JSON.stringify(payload)],
    );
  }
  return { enqueued: false };
}
