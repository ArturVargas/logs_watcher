import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createServer } from '../src/main.js';
import { listen, openTestDb } from './db.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-http-'));
let db;
let port;
const serverState = {};

function config(target) {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ targets: [target], limits: { dailyBudgetUsd: 5 } }));
  process.env.LOGS_WATCHER_CONFIG = file;
}

function activeTarget() {
  config({
    id: 'primary',
    github: { owner: 'acme', name: 'app' },
    sentry: { org: 'org', project: 'proj', productionEnvironments: ['production'] },
  });
}

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function post(path, body, headers) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body });
}

before(async () => {
  db = await openTestDb();
  process.env.SENTRY_WEBHOOK_SECRET = 'sentry-secret';
  process.env.GITHUB_WEBHOOK_SECRET = 'github-secret';
  activeTarget();
  serverState.server = createServer(db.pool);
  port = await listen(serverState.server);
});

beforeEach(async () => {
  await db.reset();
  activeTarget();
});

after(async () => {
  serverState.server.close();
  await db.close();
});

test('a bad signature inserts nothing', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return real(url, opts);
  };
  try {
    const body = JSON.stringify({ marker: 'secret-marker-body', action: 'created', data: { issue: { id: '9' } } });
    const sentry = await post('/webhooks/sentry/primary', body, {
      'content-type': 'application/json',
      'sentry-hook-signature': 'deadbeef',
      'sentry-hook-resource': 'issue',
      'request-id': 'bad-1',
    });
    assert.equal(sentry.status, 401);
    const githubBody = JSON.stringify({ zen: 'secret-marker-body' });
    const github = await post('/webhooks/github', githubBody, {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-github-delivery': 'gh-bad',
    });
    assert.equal(github.status, 401);
    const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
    assert.equal(inbox.rows[0].n, 0);
    assert.equal(calls.filter((url) => !url.startsWith('http://127.0.0.1:')).length, 0);
    const logged = lines.join('\n');
    assert.match(logged, /webhook_rejected/);
    assert.equal(logged.includes('deadbeef'), false);
    assert.equal(logged.includes('secret-marker-body'), false);
  } finally {
    console.log = original;
    globalThis.fetch = real;
  }
});

test('a stale sentry timestamp inserts nothing', async () => {
  const body = JSON.stringify({ action: 'created', data: { issue: { id: '9' } } });
  const res = await post('/webhooks/sentry/primary', body, {
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000) - 301),
    'sentry-hook-resource': 'issue',
    'request-id': 'old-1',
  });
  assert.equal(res.status, 401);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  assert.equal(inbox.rows[0].n, 0);
});

test('a body over 1000000 bytes is 413 and inserts nothing', async () => {
  const body = Buffer.alloc(1_000_001, 97);
  const res = await post('/webhooks/sentry/primary', body, {
    'content-type': 'application/octet-stream',
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'request-id': 'big-1',
  });
  assert.equal(res.status, 413);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  assert.equal(inbox.rows[0].n, 0);
});

test('the same request id stores one row and one job', async () => {
  const body = JSON.stringify({ action: 'created', data: { issue: { id: '42' } } });
  const headers = {
    'content-type': 'application/json',
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'sentry-hook-resource': 'issue',
    'request-id': 'req-1',
  };
  assert.equal((await post('/webhooks/sentry/primary', body, headers)).status, 200);
  assert.equal((await post('/webhooks/sentry/primary', body, headers)).status, 200);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(inbox.rows[0].n, 1);
  assert.equal(jobs.rows[0].n, 1);
});

test('a repeated github delivery stores one row and no job', async () => {
  const body = JSON.stringify({ repository: { name: 'app', owner: { login: 'acme' } } });
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${sign(body, 'github-secret')}`,
    'x-github-delivery': 'gh-1',
  };
  assert.equal((await post('/webhooks/github', body, headers)).status, 200);
  assert.equal((await post('/webhooks/github', body, headers)).status, 200);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(inbox.rows[0].n, 1);
  assert.equal(jobs.rows[0].n, 0);
});

test('an unknown target is 404', async () => {
  const body = JSON.stringify({ action: 'created', data: { issue: { id: '1' } } });
  const res = await post('/webhooks/sentry/missing', body, {
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'request-id': 'miss-1',
  });
  assert.equal(res.status, 404);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  assert.equal(inbox.rows[0].n, 0);
});

test('an inactive target stores target_inactive and no job', async () => {
  config({
    id: 'primary',
    github: { owner: '', name: '' },
    sentry: { org: 'org', project: 'proj', productionEnvironments: ['production'] },
  });
  const body = JSON.stringify({ action: 'created', data: { issue: { id: '7' } } });
  const res = await post('/webhooks/sentry/primary', body, {
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'sentry-hook-resource': 'issue',
    'request-id': 'inactive-1',
  });
  assert.equal(res.status, 200);
  const inbox = await db.pool.query(`SELECT status FROM inbox`);
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(inbox.rows[0].status, 'target_inactive');
  assert.equal(jobs.rows[0].n, 0);
});

test('a sentry resource that is not accepted is 204 and creates no job', async () => {
  const body = JSON.stringify({ action: 'resolved', data: { issue: { id: '7' } } });
  const res = await post('/webhooks/sentry/primary', body, {
    'sentry-hook-signature': sign(body, 'sentry-secret'),
    'sentry-hook-resource': 'issue',
    'request-id': 'drop-1',
  });
  assert.equal(res.status, 204);
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(jobs.rows[0].n, 0);
});

test('there is no log-drain route', async () => {
  const res = await post('/webhooks/logs/primary/railway', '{}', {});
  assert.equal(res.status, 404);
});

function githubEvent(body, delivery, event = 'pull_request') {
  const raw = JSON.stringify(body);
  return post('/webhooks/github', raw, {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${sign(raw, 'github-secret')}`,
    'x-github-delivery': delivery,
    'x-github-event': event,
  });
}

function pull(action, sha, repository = { name: 'app', owner: { login: 'acme' } }) {
  return { action, pull_request: { number: 7, head: { sha } }, repository };
}

test('opened, synchronize, and reopened each enqueue one review job', async () => {
  const events = [
    ['opened', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pr-open'],
    ['synchronize', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pr-sync'],
    ['reopened', 'cccccccccccccccccccccccccccccccccccccccc', 'pr-reopen'],
  ];
  for (const [action, sha, delivery] of events) {
    assert.equal((await githubEvent(pull(action, sha), delivery)).status, 200);
  }
  const jobs = await db.pool.query(`SELECT kind, dedupe_key FROM jobs ORDER BY dedupe_key`);
  assert.deepEqual(jobs.rows.map((row) => row.kind), ['review_pr', 'review_pr', 'review_pr']);
  assert.equal(new Set(jobs.rows.map((row) => row.dedupe_key)).size, 3);
});

test('a repeated pull request sha stores two deliveries and one job', async () => {
  const sha = 'dddddddddddddddddddddddddddddddddddddddd';
  assert.equal((await githubEvent(pull('opened', sha), 'pr-same-1')).status, 200);
  assert.equal((await githubEvent(pull('synchronize', sha), 'pr-same-2')).status, 200);
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(inbox.rows[0].n, 2);
  assert.equal(jobs.rows[0].n, 1);
});

test('other github events and unknown repositories enqueue nothing', async () => {
  const sha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  assert.equal((await githubEvent(pull('closed', sha), 'pr-closed')).status, 200);
  assert.equal((await githubEvent(pull('ready_for_review', sha), 'pr-ready')).status, 200);
  assert.equal((await githubEvent(pull('opened', 'abc123'), 'pr-short')).status, 200);
  assert.equal((await githubEvent({ action: 'created', repository: { name: 'app', owner: { login: 'acme' } } }, 'issue-1', 'issue_comment')).status, 200);
  assert.equal((await githubEvent(pull('opened', sha, { name: 'other', owner: { login: 'acme' } }), 'pr-other')).status, 200);
  const jobs = await db.pool.query('SELECT count(*)::int AS n FROM jobs');
  const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox');
  assert.equal(jobs.rows[0].n, 0);
  assert.equal(inbox.rows[0].n, 5);
});
