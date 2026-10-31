import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { runOnce } from '../src/worker.js';
import { listen, openTestDb } from './db.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-prop-'));
const state = { llmBodies: [], model: null };
let db;
let stub;
let stubUrl;
let calls;
const repos = [];

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
}

function makeRepo(files) {
  const repo = mkdtempSync(join(tmpdir(), 'lw-repo-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(repo, ['init', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
  repos.push(repo);
  return repo;
}

const SOURCE = 'export function total() {\n  return 1;\n}\n';

function writeConfig(limits = {}) {
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
        blockerTransactions: ['/', '/login', '/signup', '/auth/callback'],
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

function truncatedEvent() {
  return {
    event_id: 'evt-1',
    type: 'error',
    level: 'error',
    environment: 'production',
    title: 'TypeError: orders broke badly',
    request: { url: 'https://app.example/api/orders' },
    tags: [{ key: 'transaction', value: '/api/orders' }],
    exception: {
      values: [{
        type: 'TypeError',
        value: 'orders broke badly',
        mechanism: { handled: false, type: 'generic' },
        stacktrace: { frames: [{ filename: 'src/orders.js', function: 'total', lineNo: 2, inApp: true }] },
      }],
    },
  };
}

function model(patch) {
  return {
    refusal: 'none',
    summary: 'Return the right total',
    evidence: [{ source: 'event', quote: 'orders broke badly' }],
    patches: [patch],
    newTests: [],
  };
}

async function enqueue() {
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', 'classify:primary:42', 'queued', now(), $1::jsonb)`,
    [JSON.stringify({ targetId: 'primary', sentryIssueId: '42', deliveryId: 'primary:42' })],
  );
}

before(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        state.llmBodies.push(raw);
        const body = JSON.stringify({
          choices: [{ message: { content: JSON.stringify(state.model) } }],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      });
      return;
    }
    const payload = url.pathname.endsWith('/events/latest/') ? state.event : { id: '42', userCount: 1 };
    res.writeHead(200, { 'content-type': 'application/json' });
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
  state.llmBodies = [];
  state.event = truncatedEvent();
  state.model = model({ path: 'src/orders.js', before: 'return 1;', after: 'return 2;' });
  calls.length = 0;
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  delete process.env.LOGS_WATCHER_DRY_RUN;
  writeConfig();
});

after(async () => {
  stub.close();
  await db.close();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

async function proposals() {
  return db.pool.query('SELECT state, github_pr_number, generation_key, payload FROM proposals');
}

test('no key or no model stores no proposal', async () => {
  delete process.env.LLM_API_KEY;
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rowCount, 0);
  const group = await db.pool.query('SELECT class FROM groups');
  assert.equal(group.rows[0].class, 'truncated');
  assert.equal(state.llmBodies.length, 0);

  process.env.LLM_API_KEY = 'llm-key';
  delete process.env.LLM_MODEL;
  await db.reset();
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rowCount, 0);
  assert.equal(state.llmBodies.length, 0);
});

test('a repeated before, package.json, or an empty catch stores nothing pending', async () => {
  const repeated = makeRepo({ 'src/orders.js': 'return 1;\nreturn 1;\n' });
  state.model = model({ path: 'src/orders.js', before: 'return 1;', after: 'return 2;' });
  await enqueue();
  await runOnce(db.pool, { repoDir: repeated });
  assert.equal((await proposals()).rows.filter((row) => row.state === 'pending').length, 0);

  await db.reset();
  state.llmBodies = [];
  const denied = makeRepo({ 'src/orders.js': SOURCE });
  state.model = model({ path: 'package.json', before: 'return 1;', after: 'return 2;' });
  await enqueue();
  await runOnce(db.pool, { repoDir: denied });
  assert.equal((await proposals()).rows.filter((row) => row.state === 'pending').length, 0);

  await db.reset();
  state.llmBodies = [];
  const caught = makeRepo({ 'src/orders.js': SOURCE });
  state.model = model({ path: 'src/orders.js', before: 'return 1;', after: 'try {\n  return 1;\n} catch (e) {}\n' });
  await enqueue();
  await runOnce(db.pool, { repoDir: caught });
  assert.equal((await proposals()).rows.filter((row) => row.state === 'pending').length, 0);
});

test('a catch written inside a string still stores the proposal', async () => {
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  state.model = model({
    path: 'src/orders.js',
    before: 'return 1;',
    after: 'const label = "catch (e) {}";\nreturn 2;',
  });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rowCount, 1);
});

test('a failed git apply stores nothing pending', async () => {
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  state.model = model({ path: 'src/orders.js', before: 'return 9;', after: 'return 2;' });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rows.filter((row) => row.state === 'pending').length, 0);
});

test('non-blocking stores no proposal', async () => {
  state.event = {
    event_id: 'evt-nb',
    type: 'error',
    level: 'error',
    environment: 'production',
    title: 'TypeError: orders broke badly',
    request: { url: 'https://app.example/checkout' },
    tags: [{ key: 'transaction', value: '/checkout' }],
    contexts: { response: { status_code: 200 } },
    exception: { values: [{ type: 'TypeError', value: 'orders broke badly', mechanism: { handled: true, type: 'generic' } }] },
  };
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rowCount, 0);
  assert.equal(state.llmBodies.length, 0);
});

test('a valid truncated patch is stored and github is not called', async () => {
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await enqueue();
    await runOnce(db.pool, { repoDir: repo });
    process.env.LOGS_WATCHER_DRY_RUN = 'false';
    await db.reset();
    state.llmBodies = [];
    await enqueue();
    await runOnce(db.pool, { repoDir: repo });
  } finally {
    console.log = original;
    delete process.env.LOGS_WATCHER_DRY_RUN;
  }
  const rows = await proposals();
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].state, 'pending');
  assert.equal(rows.rows[0].github_pr_number, null);
  assert.match(rows.rows[0].generation_key, /^fix:[0-9a-f]{64}$/);
  assert.equal(rows.rows[0].payload.dryRun, false);
  assert.equal(calls.some((url) => url.startsWith('https://api.github.com')), false);
  assert.match(lines.join('\n'), /proposal_stored/);
  assert.equal(lines.join('\n').includes('return 2;'), false);
  const cost = await db.pool.query(`SELECT kind FROM cost_ledger`);
  assert.equal(cost.rows.length, 1);
  assert.equal(cost.rows[0].kind, 'propose');
});

test('a missing dry-run flag stores payload.dryRun true and does not call github', async () => {
  delete process.env.LOGS_WATCHER_DRY_RUN;
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  const rows = await proposals();
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].payload.dryRun, true);
  assert.equal(rows.rows[0].github_pr_number, null);
  assert.equal(calls.some((url) => url.startsWith('https://api.github.com')), false);
});

test('the daily cap stops the second model call', async () => {
  writeConfig({ inputUsdPerMillion: 5_000_000, outputUsdPerMillion: 5_000_000 });
  state.model = model({ path: 'src/orders.js', before: 'return 1;', after: 'try {\n  return 1;\n} catch (e) {}\n' });
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  const job = await db.pool.query(`SELECT state FROM jobs`);
  assert.equal(state.llmBodies.length, 1);
  assert.equal(job.rows[0].state, 'deferred_budget');
  assert.equal((await proposals()).rowCount, 0);
});

test('a change over the line cap stores nothing pending', async () => {
  writeConfig({ maxFixChangedLines: 1 });
  const repo = makeRepo({ 'src/orders.js': SOURCE });
  state.model = model({ path: 'src/orders.js', before: 'return 1;', after: 'return 2;\nreturn 3;' });
  await enqueue();
  await runOnce(db.pool, { repoDir: repo });
  assert.equal((await proposals()).rows.filter((row) => row.state === 'pending').length, 0);
});

test('src does not call typesafe, merge a pull, or a log drain', () => {
  const files = readdirSync('src').filter((name) => name.endsWith('.js'));
  const text = files.map((name) => readFileSync(join('src', name), 'utf8')).join('\n');
  assert.equal(text.includes('api.typesafe.ai'), false);
  assert.equal(text.includes('webhooks/logs'), false);
  assert.equal(text.includes('/merge'), false);
  assert.equal(text.includes('auto_merge'), false);
  assert.match(text, /\$\{repo\}\/pulls`/);
});
