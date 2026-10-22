import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { chooseLanguage } from '../src/issues.js';
import { runOnce } from '../src/worker.js';
import { listen, openTestDb } from './db.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-issue-'));
const repos = [];
const state = { requests: [], issues: new Map(), next: 1, sentryIssue: null, event: null, model: null };
let db;
let stub;
let stubUrl;
let realFetch;

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'lw-repo-'));
  const full = join(repo, 'src/orders.js');
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, 'export function total() {\n  return 1;\n}\n');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
  repos.push(repo);
  return repo;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function writeConfig({ installationId = '77', issueLanguage = 'both' } = {}) {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    targets: [{
      id: 'primary',
      github: { owner: 'acme', name: 'app', installationId },
      sentry: {
        baseUrl: stubUrl,
        org: 'org',
        project: 'proj',
        productionEnvironments: ['production'],
        blockerTransactions: ['/', '/login', '/signup', '/auth/callback'],
      },
      issueLanguage,
    }],
  }));
  process.env.LOGS_WATCHER_CONFIG = file;
}

function truncatedEvent(overrides = {}) {
  return {
    event_id: 'evt-1',
    type: 'error',
    level: 'error',
    environment: 'production',
    title: 'TypeError: orders broke badly',
    culprit: '/api/orders',
    request: { url: 'https://app.example/api/orders' },
    tags: [{ key: 'transaction', value: '/api/orders' }],
    exception: {
      values: [{
        type: 'TypeError',
        value: 'ghp_abcdefghijklmnop broke the orders',
        mechanism: { handled: false, type: 'generic' },
        stacktrace: { frames: [{ filename: 'src/orders.js', function: 'total', lineNo: 2, inApp: true }] },
      }],
    },
    ...overrides,
  };
}

function blocks() {
  return [
    '<!-- logs-watcher-sentry-issue: 42 -->',
    '<!-- logs-watcher-generation: abc -->',
    '<!-- logs-watcher-facts:start -->',
    '- Release: old',
    '<!-- logs-watcher-facts:end -->',
    '<!-- logs-watcher-severity:start -->',
    '- Clase: truncated',
    '<!-- logs-watcher-severity:end -->',
    '<!-- logs-watcher-evidence:start -->',
    '- orders broke badly',
    '<!-- logs-watcher-top-frame: src/orders.js\ttotal -->',
    '<!-- logs-watcher-evidence:end -->',
    '<!-- logs-watcher-progress:start -->',
    '- Estado del fix: detectado',
    '<!-- logs-watcher-progress:end -->',
  ].join('\n');
}

function seed(number, extra = {}) {
  const issue = {
    number,
    state: 'open',
    title: 'old',
    body: blocks(),
    labels: [{ name: 'logs-watcher' }, { name: 'logs-watcher:sentry' }, { name: 'severity:truncated' }, { name: 'priority:p1' }],
    comments: [],
    ...extra,
  };
  state.issues.set(number, issue);
  return issue;
}

async function enqueue(id = '42') {
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'classify_and_file', $2, 'queued', now(), $1::jsonb)
     ON CONFLICT (dedupe_key) DO UPDATE SET state = 'queued', locked_at = NULL, run_after = now(), attempts = 0`,
    [JSON.stringify({ targetId: 'primary', sentryIssueId: id }), `classify:primary:${id}`],
  );
}

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(dir, 'app.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  process.env.SENTRY_AUTH_TOKEN = 'sentry-token';
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      state.requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization || '' });
      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        send(res, 200, {
          choices: [{ message: { content: JSON.stringify(state.model) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
        return;
      }
      if (url.pathname.startsWith('/api/0/issues/') && url.pathname.endsWith('/events/latest/')) {
        send(res, 200, state.event);
        return;
      }
      if (url.pathname.startsWith('/api/0/issues/')) {
        send(res, 200, state.sentryIssue);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/app/installations/77/access_tokens') {
        send(res, 201, { token: 'ghs_test' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/labels') {
        if (state.labelNames.has(body.name)) return send(res, 422, { message: 'already_exists' });
        state.labelNames.add(body.name);
        return send(res, 201, body);
      }
      if (req.method === 'GET' && url.pathname === '/search/issues') {
        const marker = ((url.searchParams.get('q') || '').match(/logs-watcher-sentry-issue: [^"]+/) || [])[0];
        const items = [...state.issues.values()].filter((item) => marker && item.body.includes(marker));
        send(res, 200, { items });
        return;
      }
      const comments = url.pathname.match(/^\/repos\/acme\/app\/issues\/(\d+)\/comments$/);
      if (comments) {
        const issue = state.issues.get(Number(comments[1]));
        if (!issue) return send(res, 404, {});
        if (req.method === 'GET') return send(res, 200, issue.comments);
        issue.comments.push({ body: body.body });
        return send(res, 201, { body: body.body });
      }
      const labels = url.pathname.match(/^\/repos\/acme\/app\/issues\/(\d+)\/labels(?:\/(.+))?$/);
      if (labels) {
        const issue = state.issues.get(Number(labels[1]));
        if (!issue) return send(res, 404, {});
        if (req.method === 'POST') {
          for (const name of body.labels ?? []) {
            if (!issue.labels.some((item) => item.name === name)) issue.labels.push({ name });
          }
          return send(res, 200, issue.labels);
        }
        const name = decodeURIComponent(labels[2]);
        issue.labels = issue.labels.filter((item) => item.name !== name);
        return send(res, 200, {});
      }
      const one = url.pathname.match(/^\/repos\/acme\/app\/issues\/(\d+)$/);
      if (one) {
        const issue = state.issues.get(Number(one[1]));
        if (!issue) return send(res, 404, {});
        if (req.method === 'PATCH') {
          if (body.body != null) issue.body = body.body;
          if (body.state) issue.state = body.state;
          if (body.title) issue.title = body.title;
          return send(res, 200, issue);
        }
        return send(res, 200, issue);
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/issues') {
        const number = state.next;
        state.next += 1;
        const issue = {
          number,
          state: 'open',
          title: body.title,
          body: body.body,
          labels: (body.labels ?? []).map((name) => ({ name })),
          comments: [],
        };
        state.issues.set(number, issue);
        return send(res, 201, issue);
      }
      send(res, 404, { path: url.pathname });
    });
  });
  const port = await listen(stub);
  stubUrl = `http://127.0.0.1:${port}`;
  process.env.LLM_BASE_URL = stubUrl;
  db = await openTestDb();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.github.com')) throw new Error(`live github call ${url}`);
    return realFetch(url, opts);
  };
});

beforeEach(async () => {
  await db.reset();
  state.requests.length = 0;
  state.issues.clear();
  state.labelNames = new Set();
  state.next = 1;
  state.sentryIssue = { id: '42', userCount: 1, count: 10, stats: { '24h': [[0, 3], [1, 4]] } };
  state.event = truncatedEvent();
  state.model = {
    refusal: 'none',
    summary: 'Return the right total',
    evidence: [{ source: 'event', quote: 'orders broke badly' }],
    patches: [{ path: 'src/orders.js', before: 'return 1;', after: 'return 2;' }],
    newTests: [],
  };
  delete process.env.LOGS_WATCHER_DRY_RUN;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.GITHUB_INSTALLATION_ID;
  writeConfig();
});

after(async () => {
  globalThis.fetch = realFetch;
  stub.close();
  await db.close();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

test('chooseLanguage counts whole words and does not flip a saved choice', () => {
  assert.equal(chooseLanguage('both', 'both', 'el fallo de la pagina cuando los usuarios'), 'es');
  assert.equal(chooseLanguage('both', 'both', 'the request failed when the user clicked'), 'en');
  assert.equal(chooseLanguage('both', 'both', "that's an error"), 'es');
  assert.equal(chooseLanguage('both', 'en', 'el fallo de la pagina cuando los usuarios'), 'en');
  assert.equal(chooseLanguage('es', 'both', 'the request failed when the user clicked'), 'es');
});

test('dry run performs no github write unless the flag is exactly false', async () => {
  for (const flag of [undefined, 'true', 'no', 'False']) {
    await db.reset();
    state.requests.length = 0;
    if (flag === undefined) delete process.env.LOGS_WATCHER_DRY_RUN;
    else process.env.LOGS_WATCHER_DRY_RUN = flag;
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl });
    assert.equal(state.requests.some((req) => req.path.startsWith('/app/') || req.path.startsWith('/repos/') || req.path === '/search/issues'), false, String(flag));
    const group = await db.pool.query('SELECT github_issue_number FROM groups');
    assert.equal(group.rows[0].github_issue_number, null);
  }
});

test('false opens one sentry issue and stores its number', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl });
  } finally {
    console.log = original;
  }
  const posts = state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/issues');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, 'Bearer ghs_test');
  const tokenCall = state.requests.find((req) => req.path === '/app/installations/77/access_tokens');
  const payload = JSON.parse(Buffer.from(tokenCall.auth.replace('Bearer ', '').split('.')[1], 'base64url').toString());
  assert.equal(payload.iss, '12345');
  const issue = [...state.issues.values()][0];
  assert.equal(issue.title, '[truncated] TypeError: /api/orders');
  assert.equal(issue.title.includes('ghp_'), false);
  assert.equal(issue.body.includes('ghp_'), false);
  assert.equal(issue.body.includes('[redacted]'), true);
  assert.match(issue.body, /<!-- logs-watcher-sentry-issue: 42 -->/);
  assert.match(issue.body, /Excepción TypeError en \/api\/orders/);
  assert.match(issue.body, /src\/orders\.js:2 total/);
  assert.match(issue.body, /10 en total, 7 en las últimas 24 h/);
  assert.match(issue.body, /Estado del fix: detectado/);
  assert.match(issue.body, /\/organizations\/org\/issues\/42\//);
  assert.deepEqual(issue.labels.map((label) => label.name).sort(), ['logs-watcher', 'logs-watcher:sentry', 'priority:p1', 'severity:truncated']);
  const group = await db.pool.query('SELECT github_issue_number, progress_stale FROM groups');
  assert.equal(group.rows[0].github_issue_number, issue.number);
  assert.equal(group.rows[0].progress_stale, false);
  const job = await db.pool.query('SELECT state FROM jobs');
  assert.equal(job.rows[0].state, 'done');
  assert.match(lines.join('\n'), /issue_filed/);
  assert.equal(lines.join('\n').includes('ghs_test'), false);
  assert.equal(lines.join('\n').includes('PRIVATE'), false);
  assert.equal(state.requests.some((req) => req.path.includes('/pulls')), false);
});

test('a later event updates the same issue, reopens it, and comments once', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  const issue = [...state.issues.values()][0];
  issue.state = 'closed';
  issue.labels.push({ name: 'bug' });
  issue.body = issue.body.replace('<!-- logs-watcher-evidence:end -->', 'HAND\n<!-- logs-watcher-evidence:end -->');
  state.sentryIssue = { ...state.sentryIssue, userCount: 40 };
  state.event = truncatedEvent({ event_id: 'evt-2' });
  state.requests.length = 0;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.equal(issue.state, 'open');
  assert.equal(issue.body.includes('HAND'), true);
  assert.match(issue.body, /Usuarios afectados \(conteo\): 40/);
  assert.equal(issue.labels.some((label) => label.name === 'priority:p0'), true);
  assert.equal(issue.labels.some((label) => label.name === 'priority:p1'), false);
  assert.equal(issue.labels.some((label) => label.name === 'bug'), true);
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].body, /<!-- logs-watcher-update: evt-2 -->/);
  assert.equal(state.requests.some((req) => req.path === '/search/issues'), false);
  assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/issues').length, 0);
  state.requests.length = 0;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.equal(issue.comments.length, 1);
  const group = await db.pool.query('SELECT github_issue_number FROM groups');
  assert.equal(group.rows[0].github_issue_number, issue.number);
});

test('several marker hits keep the lowest number and comment on the rest', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  seed(9);
  seed(4);
  state.next = 10;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.equal(state.issues.size, 2);
  assert.equal(state.requests.some((req) => req.method === 'POST' && req.path === '/repos/acme/app/issues'), false);
  const group = await db.pool.query('SELECT github_issue_number FROM groups');
  assert.equal(group.rows[0].github_issue_number, 4);
  assert.match(state.issues.get(4).body, /Usuarios afectados \(conteo\): 1/);
  assert.equal(state.issues.get(4).body.includes('Release: old'), false);
  assert.match(state.issues.get(9).comments[0].body, /duplicado de #4/);
  assert.equal(state.issues.get(4).state, 'open');
  assert.equal(state.issues.get(9).comments.length, 1);
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.equal(state.issues.get(9).comments.length, 1);
});

test('a broken owned block is not rewritten', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  seed(3, { body: '<!-- logs-watcher-sentry-issue: 42 -->\nedited by a person', labels: [] });
  state.next = 10;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  const issue = state.issues.get(3);
  assert.equal(issue.body, '<!-- logs-watcher-sentry-issue: 42 -->\nedited by a person');
  assert.match(issue.comments[0].body, /no se pueden actualizar/);
  const group = await db.pool.query('SELECT github_issue_number, progress_stale FROM groups');
  assert.equal(group.rows[0].github_issue_number, 3);
  assert.equal(group.rows[0].progress_stale, true);
  assert.equal(state.requests.some((req) => req.method === 'PATCH'), false);
});

test('non-blocking and unclassified issues are filed without a proposal', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  state.event = truncatedEvent({
    event_id: 'evt-nb',
    request: { url: 'https://app.example/checkout' },
    tags: [{ key: 'transaction', value: '/checkout' }],
    contexts: { response: { status_code: 200 } },
    exception: { values: [{ type: 'TypeError', value: 'orders broke badly', mechanism: { handled: true, type: 'generic' } }] },
  });
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  const issue = [...state.issues.values()][0];
  assert.equal(issue.labels.some((label) => label.name === 'auto-fix:no'), true);
  assert.equal(issue.labels.some((label) => label.name === 'severity:non-blocking'), true);
  assert.match(issue.body, /sin-fix-automatico/);
  assert.equal((await db.pool.query('SELECT id FROM proposals')).rowCount, 0);

  await db.reset();
  state.issues.clear();
  state.requests.length = 0;
  state.event = {
    event_id: 'evt-u',
    type: 'error',
    level: 'error',
    environment: 'production',
    title: 'something broke in checkout',
    user: {},
    request: {},
    exception: { values: [{ type: 'Error', value: 'something broke in checkout' }] },
  };
  await enqueue('99');
  await runOnce(db.pool, { githubApi: stubUrl });
  const unclassified = [...state.issues.values()][0];
  assert.match(unclassified.body, /sin prioridad/);
  assert.equal(unclassified.labels.some((label) => label.name.startsWith('priority:')), false);
  assert.equal(unclassified.labels.some((label) => label.name === 'auto-fix:no'), true);
  assert.equal((await db.pool.query('SELECT id FROM proposals')).rowCount, 0);
});

test('both picks english and later text does not change it', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  state.event = truncatedEvent({
    title: 'the request failed when the worker crashed',
    culprit: 'the request failed when the worker crashed',
  });
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  const issue = [...state.issues.values()][0];
  assert.match(issue.body, /## What the error does/);
  assert.match(issue.body, /## Progress/);
  assert.equal(issue.body.includes('Qué hace el error'), false);
  assert.equal((await db.pool.query('SELECT issue_language FROM groups')).rows[0].issue_language, 'en');
  state.event = truncatedEvent({
    event_id: 'evt-es',
    title: 'el fallo de la pagina cuando los usuarios no entran',
    culprit: 'el fallo de la pagina',
  });
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.match(issue.body, /## What the error does/);
  assert.equal(issue.body.includes('Qué hace el error'), false);
  assert.equal((await db.pool.query('SELECT issue_language FROM groups')).rows[0].issue_language, 'en');
});

test('missing installation id does not call github', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  writeConfig({ installationId: '' });
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl });
  assert.equal(state.requests.some((req) => req.path.startsWith('/app/') || req.path.startsWith('/repos/') || req.path === '/search/issues'), false);
  assert.equal((await db.pool.query('SELECT github_issue_number FROM groups')).rows[0].github_issue_number, null);
  assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done');
});

test('a dry-run proposal keeps a null issue number until the flag is exactly false', async () => {
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal((await db.pool.query('SELECT github_issue_number FROM proposals')).rows[0].github_issue_number, null);
  assert.equal(state.requests.some((req) => req.path.startsWith('/repos/')), false);
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  state.requests.length = 0;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  const proposal = await db.pool.query('SELECT github_issue_number, github_pr_number FROM proposals');
  const group = await db.pool.query('SELECT github_issue_number FROM groups');
  assert.equal(proposal.rowCount, 1);
  assert.equal(proposal.rows[0].github_issue_number, group.rows[0].github_issue_number);
  assert.equal(proposal.rows[0].github_pr_number, null);
  assert.equal(state.requests.some((req) => req.path.includes('/pulls')), false);
});

test('a stored proposal records the issue number and does not open a pull', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  const proposal = await db.pool.query('SELECT github_issue_number, github_pr_number FROM proposals');
  const group = await db.pool.query('SELECT github_issue_number FROM groups');
  assert.equal(proposal.rowCount, 1);
  assert.equal(proposal.rows[0].github_issue_number, group.rows[0].github_issue_number);
  assert.equal(proposal.rows[0].github_pr_number, null);
  assert.equal(state.requests.some((req) => req.path.includes('/pulls')), false);
});
