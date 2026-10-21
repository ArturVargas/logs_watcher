import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { classify } from '../src/classify.js';
import { createServer } from '../src/main.js';
import { releaseStaleLocks } from '../src/queue.js';
import { runOnce } from '../src/worker.js';
import { listen, openTestDb } from './db.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-cls-'));
const blockers = ['/', '/login', '/signup', '/auth/callback'];
const state = { issueStatus: 200, eventStatus: 200, llmBodies: [], llm: () => ({ status: 200, body: {} }) };
let db;
let stub;
let stubUrl;
let calls;

function event(extra = {}) {
  return {
    type: 'error',
    level: 'error',
    title: 'TypeError: fail',
    environment: 'production',
    tags: [],
    exception: { values: [{ type: 'TypeError', value: 'fail', mechanism: { handled: true, type: 'generic' } }] },
    ...extra,
  };
}

function options(extra = {}) {
  return { blockerTransactions: blockers, productionEnvironments: ['production'], ignoreTitlePatterns: [], userCount: 0, eventCount24h: null, ...extra };
}

const rubric = [
  {
    name: 'uncaught /login',
    event: event({
      user: {},
      tags: [{ key: 'transaction', value: '/login' }],
      exception: { values: [{ type: 'TypeError', value: 'boom', mechanism: { handled: false, type: 'generic' } }] },
    }),
    class: 'blocker',
    priority: 'P0',
  },
  {
    name: 'uncaught /api/orders',
    event: event({
      request: { url: 'https://app.example/api/orders' },
      tags: [{ key: 'transaction', value: '/api/orders' }],
      exception: { values: [{ type: 'TypeError', value: 'orders broke', mechanism: { handled: false, type: 'generic' } }] },
    }),
    class: 'truncated',
    priority: 'P1',
  },
  {
    name: 'captured 500 /checkout',
    event: event({
      request: { url: 'https://app.example/checkout' },
      tags: [{ key: 'transaction', value: '/checkout' }],
      contexts: { response: { status_code: 500 } },
    }),
    class: 'flow-blocked',
    priority: 'P2',
  },
  {
    name: 'captured status under 500',
    event: event({
      request: { url: 'https://app.example/checkout' },
      tags: [{ key: 'transaction', value: '/checkout' }],
      contexts: { response: { status_code: 200 } },
    }),
    class: 'non-blocking',
    priority: 'P3',
  },
  {
    name: 'cron without user, request, or url',
    event: event({ tags: [{ key: 'transaction', value: 'cron.billing' }] }),
    class: 'no-user-impact',
    priority: 'P3',
  },
];

function writeConfig(sentry = {}, limits = {}) {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    targets: [{
      id: 'primary',
      github: { owner: 'acme', name: 'app' },
      sentry: {
        baseUrl: stubUrl,
        org: 'org',
        project: 'proj',
        productionEnvironments: ['production'],
        blockerTransactions: blockers,
        ...sentry,
      },
      phases: { cicd: false },
    }],
    limits: {
      dailyBudgetUsd: 5,
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
      maxFixFiles: 8,
      maxFixChangedLines: 400,
      promptCharCap: 80000,
      maxOutputTokens: 4096,
      ...limits,
    },
  }));
  process.env.LOGS_WATCHER_CONFIG = file;
}

async function enqueue(issueId) {
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', $1, 'queued', now(), $2::jsonb)`,
    [`classify:primary:${issueId}`, JSON.stringify({ targetId: 'primary', sentryIssueId: issueId, deliveryId: `primary:${issueId}` })],
  );
}

function chat(content, status = 200) {
  return {
    status,
    body: {
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    },
  };
}

before(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        state.llmBodies.push(raw);
        const out = state.llm(raw);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(out.raw ?? JSON.stringify(out.body ?? {}));
      });
      return;
    }
    const status = url.pathname.endsWith('/events/latest/') ? state.eventStatus : state.issueStatus;
    const payload = url.pathname.endsWith('/events/latest/') ? state.event : state.issue;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const port = await listen(stub);
  stubUrl = `http://127.0.0.1:${port}`;
  db = await openTestDb();
  process.env.SENTRY_AUTH_TOKEN = 'sentry-token';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  process.env.LLM_BASE_URL = stubUrl;
  delete process.env.LOGS_WATCHER_DRY_RUN;
  const real = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return real(url, opts);
  };
});

beforeEach(async () => {
  await db.reset();
  state.issueStatus = 200;
  state.eventStatus = 200;
  state.llmBodies = [];
  state.issue = { userCount: 0 };
  state.event = event();
  state.llm = () => chat({});
  calls.length = 0;
  writeConfig();
});

after(async () => {
  stub.close();
  await db.close();
});

test('rubric rows classify in code', () => {
  for (const row of rubric) {
    const result = classify(row.event, options());
    assert.equal(result.class, row.class, row.name);
    assert.equal(result.priority, row.priority, row.name);
  }
  const many = classify(rubric[1].event, options({ userCount: 25 }));
  assert.equal(many.class, 'truncated');
  assert.equal(many.priority, 'P0');
  const noisy = classify(rubric[4].event, options({ eventCount24h: 200 }));
  assert.equal(noisy.class, 'no-user-impact');
  assert.equal(noisy.priority, 'P2');
  const quiet = classify(event({ user: null, tags: [{ key: 'transaction', value: 'cron.billing' }] }), options());
  assert.equal(quiet.class, 'no-user-impact');
  const clientError = classify(event({
    user: {},
    tags: [{ key: 'transaction', value: '/api/orders' }],
    contexts: { response: { status_code: 401 } },
  }), options());
  assert.equal(clientError.drop, 'handled_4xx');
  assert.equal(clientError.class, null);
});

test('a worker stores the rubric without a github issue number', async () => {
  let n = 0;
  for (const row of rubric) {
    n += 1;
    state.issue = { id: String(n), userCount: 0 };
    state.event = { ...row.event, event_id: `evt-${n}` };
    await enqueue(String(n));
    await runOnce(db.pool);
    const group = await db.pool.query('SELECT class, priority, github_issue_number, importance, urgency FROM groups WHERE sentry_issue_id = $1', [String(n)]);
    assert.equal(group.rows[0].class, row.class, row.name);
    assert.equal(group.rows[0].priority, row.priority, row.name);
    assert.equal(group.rows[0].github_issue_number, null);
    assert.equal(group.rows[0].importance, null);
    assert.equal(group.rows[0].urgency, null);
  }
  assert.equal(calls.some((url) => url.startsWith('https://api.github.com')), false);
  assert.equal(calls.some((url) => url.includes('api.typesafe.ai')), false);
});

test('a 4xx with the process still running does not classify', async () => {
  state.event = event({
    user: {},
    tags: [{ key: 'transaction', value: '/api/orders' }],
    contexts: { response: { status_code: 404 } },
  });
  await enqueue('4xx');
  await runOnce(db.pool);
  const job = await db.pool.query(`SELECT state, last_error FROM jobs`);
  const groups = await db.pool.query(`SELECT count(*)::int AS n FROM groups WHERE class IS NOT NULL`);
  assert.equal(job.rows[0].state, 'done');
  assert.equal(job.rows[0].last_error, 'handled_4xx');
  assert.equal(groups.rows[0].n, 0);
  assert.equal(state.llmBodies.length, 0);
});

test('a quote that is not in the event is unclassified and stores no proposal', async () => {
  state.event = event({
    user: {},
    title: 'TypeError: missing-bits',
    exception: { values: [{ type: 'TypeError', value: 'missing-bits' }] },
  });
  state.llm = () => chat({
    processTerminated: { value: true, quote: 'invented-quote-text' },
    userCanUseApp: { value: false, quote: 'also-invented-quote' },
    userFlowCompletes: { value: false, quote: 'still-invented-quote' },
  });
  await enqueue('quote');
  await runOnce(db.pool);
  const group = await db.pool.query(`SELECT class, priority FROM groups`);
  const proposals = await db.pool.query('SELECT count(*)::int AS n FROM proposals');
  assert.equal(group.rows[0].class, 'unclassified');
  assert.equal(group.rows[0].priority, null);
  assert.equal(proposals.rows[0].n, 0);
});

test('a rejected response_format is retried once and a literal quote fills the class', async () => {
  state.event = event({
    user: {},
    title: 'TypeError: boom-quote-value',
    exception: { values: [{ type: 'TypeError', value: 'boom-quote-value' }] },
  });
  state.llm = (raw) => {
    if (JSON.parse(raw).response_format) return { status: 400, raw: JSON.stringify({ error: 'response_format unsupported' }) };
    const quote = 'TypeError: boom-quote-value';
    return chat({
      processTerminated: { value: false, quote },
      userCanUseApp: { value: true, quote },
      userFlowCompletes: { value: true, quote },
    });
  };
  await enqueue('fill');
  await runOnce(db.pool);
  const group = await db.pool.query(`SELECT class, priority FROM groups`);
  const cost = await db.pool.query(`SELECT kind FROM cost_ledger`);
  const proposals = await db.pool.query('SELECT count(*)::int AS n FROM proposals');
  assert.equal(group.rows[0].class, 'non-blocking');
  assert.equal(group.rows[0].priority, 'P3');
  assert.equal(proposals.rows[0].n, 0);
  assert.equal(cost.rows.length, 1);
  assert.equal(cost.rows[0].kind, 'classify');
  assert.equal(state.llmBodies.length, 2);
});

test('an empty org is config_missing and does not call out', async () => {
  writeConfig({ org: '' });
  await enqueue('org');
  await runOnce(db.pool);
  const job = await db.pool.query(`SELECT state, last_error FROM jobs`);
  assert.equal(job.rows[0].state, 'done');
  assert.equal(job.rows[0].last_error, 'config_missing');
  assert.equal(calls.length, 0);
});

test('empty productionEnvironments drops the job without a call', async () => {
  writeConfig({ productionEnvironments: [] });
  await enqueue('env');
  await runOnce(db.pool);
  const job = await db.pool.query(`SELECT state, last_error FROM jobs`);
  assert.equal(job.rows[0].state, 'done');
  assert.equal(job.rows[0].last_error, 'production_environments_empty');
  assert.equal(calls.length, 0);
});

test('a second event while the job is running marks dirty and does not insert another key', async () => {
  const server = createServer(db.pool);
  const port = await listen(server);
  process.env.SENTRY_WEBHOOK_SECRET = 'sentry-secret';
  const body = (id) => JSON.stringify({ action: 'created', data: { issue: { id } } });
  const send = (requestId) => {
    const payload = body('77');
    return fetch(`http://127.0.0.1:${port}/webhooks/sentry/primary`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': createHmac('sha256', 'sentry-secret').update(payload).digest('hex'),
        'sentry-hook-resource': 'issue',
        'request-id': requestId,
      },
      body: payload,
    });
  };
  try {
    assert.equal((await send('a')).status, 200);
    await db.pool.query(`UPDATE jobs SET state = 'running', locked_at = now(), attempts = 1`);
    assert.equal((await send('b')).status, 200);
    const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
    const group = await db.pool.query('SELECT dirty FROM groups');
    assert.equal(jobs.rows[0].n, 1);
    assert.equal(group.rows[0].dirty, true);
  } finally {
    server.close();
  }
});

test('a lock older than five minutes returns to queued', async () => {
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, attempts, run_after, locked_at, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', 'classify:primary:old', 'running', 1, now(), now() - interval '6 minutes', '{"targetId":"primary"}'::jsonb),
            (gen_random_uuid(), 'classify_and_file', 'classify:primary:stuck', 'running', 5, now(), now() - interval '6 minutes', '{"targetId":"primary"}'::jsonb)`,
  );
  await releaseStaleLocks(db.pool);
  const rows = await db.pool.query(`SELECT dedupe_key, state FROM jobs ORDER BY dedupe_key`);
  assert.deepEqual(rows.rows, [
    { dedupe_key: 'classify:primary:old', state: 'queued' },
    { dedupe_key: 'classify:primary:stuck', state: 'dead' },
  ]);
});

test('a daily total above 5 USD defers the model call and still stores a blocker', async () => {
  await db.pool.query(
    `INSERT INTO cost_ledger (id, day, kind, input_tokens, output_tokens, usd, created_at)
     VALUES (gen_random_uuid(), (now() AT TIME ZONE 'UTC')::date, 'classify', 1, 1, 5.01, now())`,
  );
  state.event = event({ user: {}, title: 'needs a model', exception: { values: [{ type: 'TypeError', value: 'needs a model' }] } });
  await enqueue('budget-model');
  await runOnce(db.pool);
  const deferred = await db.pool.query(`SELECT state FROM jobs WHERE dedupe_key = 'classify:primary:budget-model'`);
  assert.equal(deferred.rows[0].state, 'deferred_budget');
  assert.equal(state.llmBodies.length, 0);

  state.event = rubric[0].event;
  state.issue = { userCount: 1 };
  await enqueue('budget-blocker');
  await runOnce(db.pool);
  const group = await db.pool.query(`SELECT class, priority, github_issue_number FROM groups WHERE sentry_issue_id = 'budget-blocker'`);
  const job = await db.pool.query(`SELECT state FROM jobs WHERE dedupe_key = 'classify:primary:budget-blocker'`);
  assert.equal(group.rows[0].class, 'blocker');
  assert.equal(group.rows[0].priority, 'P0');
  assert.equal(group.rows[0].github_issue_number, null);
  assert.equal(job.rows[0].state, 'deferred_budget');
  assert.equal(calls.some((url) => url.includes('/chat/completions')), false);
});

test('a token or an email does not leave the process', async () => {
  const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  const email = 'ada@example.com';
  state.event = event({
    user: {},
    title: `TypeError ${token} ${email}`,
    exception: { values: [{ type: 'TypeError', value: `${token} ${email}` }] },
  });
  state.llm = () => chat({
    processTerminated: { value: true, quote: 'not-in-event-quote' },
    userCanUseApp: { value: true, quote: 'not-in-event-quote' },
    userFlowCompletes: { value: false, quote: 'not-in-event-quote' },
  });
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await enqueue('scrub');
    await runOnce(db.pool);
  } finally {
    console.log = original;
  }
  const stored = await db.pool.query(`SELECT coalesce(string_agg(coalesce(last_error, ''), ','), '') AS jobs FROM jobs`);
  const blob = `${state.llmBodies.join('\n')}\n${lines.join('\n')}\n${stored.rows[0].jobs}`;
  assert.equal(blob.includes(token), false);
  assert.equal(blob.includes(email), false);
  assert.match(state.llmBodies[0], /\[redacted\]/);
});

test('a sentry 503 is queued again and is not claimed before its delay', async () => {
  state.issueStatus = 503;
  await enqueue('later');
  await runOnce(db.pool);
  await runOnce(db.pool);
  const job = await db.pool.query(`SELECT state, attempts, run_after FROM jobs`);
  assert.equal(job.rows[0].state, 'queued');
  assert.equal(job.rows[0].attempts, 1);
  assert.ok(new Date(job.rows[0].run_after).getTime() > Date.now());
});

test('a sentry 401 is dead and is not retried', async () => {
  state.issueStatus = 401;
  await enqueue('denied');
  await runOnce(db.pool);
  const job = await db.pool.query(`SELECT state, last_error FROM jobs`);
  assert.equal(job.rows[0].state, 'dead');
  assert.equal(job.rows[0].last_error, 'http_401');
  assert.equal(calls.filter((url) => url.includes('/api/0/issues/')).length, 1);
});
