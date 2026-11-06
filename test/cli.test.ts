import type { Wire } from '../src/types.js';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { run } from "../src/cli.js";
import { openTestDb } from "./db.js";

let db: Wire;
before(async () => { db = await openTestDb(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.reset(); });

async function call(argv: Wire) {
  const lines: Wire[] = [];
  const code = await run(argv, db.pool, (line: Wire) => lines.push(line));
  return { code, lines };
}

async function insertJob(state: Wire, { attempts = 5, lastError = null, kind = "classify_and_file" } = {}) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, attempts, run_after, locked_at, last_error, payload)
     VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour', now(), $6, '{}')`,
    [id, kind, `k:${id}`, state, attempts, lastError],
  );
  return id;
}

test("jobs list --state dead prints id, kind and last_error of dead jobs only", async () => {
  const dead = await insertJob("dead", { lastError: "http_500" as Wire });
  await insertJob("queued");
  const { code, lines } = await call(["jobs", "list", "--state", "dead"]);
  assert.equal(code, 0);
  assert.deepEqual(lines, [`${dead}\tclassify_and_file\thttp_500`]);
});

test("jobs retry requeues the job with attempts 0 and run_after now", async () => {
  const id = await insertJob("dead", { lastError: "http_500" as Wire });
  const { code } = await call(["jobs", "retry", id]);
  assert.equal(code, 0);
  const { rows } = await db.pool.query("SELECT state, attempts, locked_at, run_after <= now() AS ready FROM jobs WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { state: "queued", attempts: 0, locked_at: null, ready: true });
});

test("jobs retry of an unknown or malformed id changes nothing", async () => {
  const id = await insertJob("dead");
  assert.equal((await call(["jobs", "retry", randomUUID()])).code, 1);
  assert.equal((await call(["jobs", "retry", "not-a-uuid"])).code, 2);
  const { rows } = await db.pool.query("SELECT state FROM jobs WHERE id = $1", [id]);
  assert.equal(rows[0].state, "dead");
});

test("budget show sums only the current UTC day", async () => {
  const insert = (day: Wire, usd: Wire) => db.pool.query(
    `INSERT INTO cost_ledger (id, day, kind, input_tokens, output_tokens, usd, created_at)
     VALUES ($1, ${day}, 'classify', 1, 1, $2, now())`, [randomUUID(), usd]);
  await insert("(now() AT TIME ZONE 'UTC')::date", 0.25);
  await insert("(now() AT TIME ZONE 'UTC')::date", 0.5);
  await insert("(now() AT TIME ZONE 'UTC')::date - 1", 9);
  const { code, lines } = await call(["budget", "show"]);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["0.750000"]);
});

test("unknown commands print usage and exit 2", async () => {
  const { code, lines } = await call(["jobs", "list"]);
  assert.equal(code, 2);
  assert.match(lines[0], /^usage:/);
});
