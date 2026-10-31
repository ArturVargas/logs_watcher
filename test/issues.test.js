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
const SOURCE = 'export function total() {\n  return 1;\n}\n';
const BASE = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const HEAD = 'b'.repeat(40);
const state = {
  requests: [], issues: new Map(), next: 1, sentryIssue: null, event: null, model: null,
  pulls: [], files: {}, branches: new Set(), blobs: [], trees: [], commits: [], labelNames: new Set(),
};
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
  writeFileSync(full, SOURCE);
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

function resetGithub() {
  state.requests.length = 0;
  state.issues.clear();
  state.labelNames = new Set();
  state.next = 1;
  state.blobs = [];
  state.trees = [];
  state.commits = [];
  state.branches = new Set();
  state.pulls = [];
  state.files = { 'src/orders.js': SOURCE };
  state.truncatedTree = false;
}

function fixComments(code) {
  const issue = [...state.issues.values()][0];
  const body = `<!-- logs-watcher-fix: ${code} -->\n${code}`;
  return (issue?.comments ?? []).filter((comment) => comment.body === body);
}

function bucket(number) {
  const issue = state.issues.get(number);
  if (issue) return issue;
  const pull = state.pulls.find((item) => item.number === number);
  if (!pull) return null;
  pull.labels ??= [];
  return pull;
}

function writeConfig({ installationId = '77', issueLanguage = 'both', testCommand = null } = {}) {
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
      testCommand,
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
        const issue = bucket(Number(labels[1]));
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
      if (req.method === 'GET' && url.pathname === '/repos/acme/app') return send(res, 200, { default_branch: 'main' });
      const gitRef = url.pathname.match(/^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/);
      if (gitRef && req.method === 'GET') {
        const name = decodeURIComponent(gitRef[1]);
        if (name === 'main') return send(res, 200, { object: { sha: BASE } });
        if (state.branches.has(name)) return send(res, 200, { object: { sha: HEAD } });
        return send(res, 404, {});
      }
      if (req.method === 'GET' && url.pathname === `/repos/acme/app/git/commits/${BASE}`) {
        return send(res, 200, { sha: BASE, tree: { sha: TREE } });
      }
      if (req.method === 'GET' && url.pathname === `/repos/acme/app/git/trees/${TREE}`) {
        return send(res, 200, {
          sha: TREE,
          truncated: Boolean(state.truncatedTree),
          tree: Object.keys(state.files).map((path) => ({ path, type: 'blob', mode: '100644' })),
        });
      }
      const contents = url.pathname.match(/^\/repos\/acme\/app\/contents\/(.+)$/);
      if (contents && req.method === 'GET') {
        const path = contents[1].split('/').map(decodeURIComponent).join('/');
        const text = state.files[path];
        if (text == null) return send(res, 404, {});
        return send(res, 200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/git/blobs') {
        state.blobs.push(body);
        return send(res, 201, { sha: 'd'.repeat(40) });
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/git/trees') {
        state.trees.push(body);
        return send(res, 201, { sha: 'e'.repeat(40) });
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/git/commits') {
        state.commits.push(body);
        return send(res, 201, { sha: HEAD });
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/app/git/refs') {
        const name = String(body.ref || '').replace(/^refs\/heads\//, '');
        if (state.branches.has(name)) return send(res, 422, { message: 'Reference already exists' });
        state.branches.add(name);
        return send(res, 201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (url.pathname === '/repos/acme/app/pulls') {
        if (req.method === 'GET') {
          const head = url.searchParams.get('head');
          const items = state.pulls.filter((item) => !head || head === `acme:${item.head}`);
          return send(res, 200, items.map((item) => ({ ...item, head: { ref: item.head } })));
        }
        if (req.method === 'POST') {
          if (body.draft || body.merge_method || body.auto_merge != null) return send(res, 422, { message: 'not a plain pull' });
          if (state.pulls.some((item) => item.head === body.head)) return send(res, 422, { message: 'A pull request already exists' });
          const number = state.next;
          state.next += 1;
          const pull = {
            number,
            title: body.title,
            body: body.body,
            head: body.head,
            base: body.base,
            html_url: `https://github.com/acme/app/pull/${number}`,
            labels: [],
          };
          state.pulls.push(pull);
          return send(res, 201, pull);
        }
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
  resetGithub();
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
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
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
  assert.equal(state.pulls.length, 0);

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
  assert.equal(state.pulls.length, 0);
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
  assert.equal(proposal.rows[0].github_pr_number, state.pulls[0].number);
  assert.equal(state.pulls.length, 1);
});

test('a stored proposal opens one pull and a second run does not open another', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
    state.requests.length = 0;
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  } finally {
    console.log = original;
  }
  const proposal = await db.pool.query('SELECT github_issue_number, github_pr_number, head_sha, generation_key, payload FROM proposals');
  const group = await db.pool.query('SELECT github_issue_number FROM groups');
  assert.equal(proposal.rowCount, 1);
  assert.equal(proposal.rows[0].github_issue_number, group.rows[0].github_issue_number);
  const pull = state.pulls[0];
  assert.equal(state.pulls.length, 1);
  assert.equal(proposal.rows[0].github_pr_number, pull.number);
  assert.equal(proposal.rows[0].head_sha, HEAD);
  const hex = proposal.rows[0].generation_key.slice(4, 12);
  assert.equal(pull.head, `logs-watcher/fix-primary-42-${hex}`);
  assert.equal(pull.base, 'main');
  assert.equal(pull.title, 'fix: Return the right total');
  const row = await db.pool.query('SELECT id FROM proposals');
  assert.match(pull.body, new RegExp(`<!-- logs-watcher-proposal: ${row.rows[0].id} -->`));
  assert.match(pull.body, /<!-- logs-watcher-generation: [0-9a-f]{64} -->/);
  assert.match(pull.body, /## Qué cambia/);
  assert.match(pull.body, /sin impacto/);
  assert.match(pull.body, /\/logs-watcher approve/);
  assert.equal(pull.body.includes('return 2;'), false);
  assert.equal(pull.body.includes('ghp_'), false);
  assert.equal(state.blobs[0].content, SOURCE.replace('return 1;', 'return 2;'));
  assert.equal(state.blobs[0].encoding, 'utf-8');
  assert.equal(state.trees[0].base_tree, TREE);
  assert.equal(state.commits[0].parents[0], BASE);
  assert.match(state.commits[0].message, /Sentry-Issue: 42/);
  assert.match(state.commits[0].message, /GitHub-Issue: 1/);
  assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/pulls').length, 0);
  assert.equal(state.requests.some((req) => req.path.includes('/merge') || req.body?.merge_method || req.body?.auto_merge != null), false);
  const issue = [...state.issues.values()][0];
  assert.match(issue.body, /Estado del fix: propuesta-abierta/);
  assert.match(issue.body, new RegExp(`https://github.com/acme/app/pull/${pull.number}`));
  assert.equal(pull.labels.some((label) => label.name === 'tests:missing'), true);
  assert.match(lines.join('\n'), /pr_opened/);
  assert.equal(lines.join('\n').includes('return 2;'), false);
  assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done');
});

test('any dry-run value other than false opens nothing', async () => {
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  for (const flag of [undefined, 'true', 'no', 'False', '']) {
    await db.reset();
    resetGithub();
    if (flag === undefined) delete process.env.LOGS_WATCHER_DRY_RUN;
    else process.env.LOGS_WATCHER_DRY_RUN = flag;
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
    const rows = await db.pool.query('SELECT github_pr_number, payload FROM proposals');
    assert.equal(rows.rowCount, 1, String(flag));
    assert.equal(rows.rows[0].github_pr_number, null, String(flag));
    assert.equal(rows.rows[0].payload.dryRun, true, String(flag));
    assert.equal(state.pulls.length, 0, String(flag));
    assert.equal(state.requests.some((req) => req.path.startsWith('/repos/') || req.path.startsWith('/app/') || req.path === '/search/issues'), false, String(flag));
    assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done', String(flag));
  }
});

test('blocker, truncated, and flow-blocked each open one pull', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  const cases = [
    ['blocker', truncatedEvent({
      event_id: 'evt-b',
      culprit: '/login',
      request: { url: 'https://app.example/login' },
      tags: [{ key: 'transaction', value: '/login' }],
    }), 'P0'],
    ['truncated', truncatedEvent(), 'P1'],
    ['flow-blocked', truncatedEvent({
      event_id: 'evt-f',
      culprit: '/checkout',
      request: { url: 'https://app.example/checkout' },
      tags: [{ key: 'transaction', value: '/checkout' }],
      contexts: { response: { status_code: 500 } },
      exception: {
        values: [{
          type: 'TypeError',
          value: 'orders broke badly',
          mechanism: { handled: true, type: 'generic' },
          stacktrace: { frames: [{ filename: 'src/orders.js', function: 'total', lineNo: 2, inApp: true }] },
        }],
      },
    }), 'P2'],
  ];
  for (const [severity, event, priority] of cases) {
    await db.reset();
    resetGithub();
    state.event = event;
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
    const group = await db.pool.query('SELECT class, priority FROM groups');
    assert.equal(group.rows[0].class, severity);
    assert.equal(group.rows[0].priority, priority);
    assert.equal(state.pulls.length, 1, severity);
    assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/pulls').length, 1, severity);
    assert.equal(state.requests.some((req) => req.path.includes('/merge')), false, severity);
    assert.match(state.pulls[0].body, new RegExp(`Clase: ${severity}`));
    assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done', severity);
  }
});

test('a later event keeps the open pull', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  await db.pool.query(`UPDATE proposals SET github_pr_number = NULL`);
  await db.pool.query(`UPDATE jobs SET state = 'queued', locked_at = NULL, run_after = now()`);
  state.requests.length = 0;
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 1);
  assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/pulls').length, 0);
  assert.equal((await db.pool.query('SELECT github_pr_number FROM proposals')).rows[0].github_pr_number, state.pulls[0].number);

  state.event = truncatedEvent({ event_id: 'evt-2' });
  state.requests.length = 0;
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  const rows = await db.pool.query('SELECT github_pr_number FROM proposals');
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.filter((row) => row.github_pr_number != null).length, 1);
  assert.equal(state.pulls.length, 1);
});

test('an english target opens the pull in english', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  writeConfig({ issueLanguage: 'en' });
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.match(state.pulls[0].body, /## What changes/);
  assert.match(state.pulls[0].body, /no impact/);
  assert.equal(state.pulls[0].body.includes('Qué cambia'), false);
  const issue = [...state.issues.values()][0];
  assert.match(issue.body, /Fix state: propuesta-abierta/);
});

test('a patch that is not in the GitHub file does not open a pull', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  state.files['src/orders.js'] = 'export function total() {\n  return 9;\n}\n';
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 0);
  assert.equal((await db.pool.query('SELECT github_pr_number FROM proposals')).rows[0].github_pr_number, null);
  assert.equal(state.branches.size, 0);
  assert.equal(fixComments('fix_does_not_apply').length, 1);
  assert.equal(fixComments('fix_does_not_apply')[0].body.includes('Return the right total'), false);
  assert.equal(fixComments('fix_does_not_apply')[0].body.includes('return 2'), false);
  assert.match([...state.issues.values()][0].body, /Estado del fix: detectado/);
  assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done');
});

test('a repository that already has tests does not open a pull without a new test', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  state.files['src/orders.test.js'] = 'test("total", () => {});\n';
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 0);
  assert.equal((await db.pool.query('SELECT github_pr_number FROM proposals')).rows[0].github_pr_number, null);
  assert.equal(state.branches.size, 0);
  assert.equal(fixComments('fix_does_not_apply').length, 0);
  assert.equal(fixComments('tests_failed').length, 0);
});

test('a failing test command stores the proposal and does not open a pull', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  writeConfig({ testCommand: [process.execPath, '-e', 'process.exit(1)'] });
  const repo = makeRepo();
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
    await enqueue();
    await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  } finally {
    console.log = original;
  }
  assert.equal((await db.pool.query('SELECT github_pr_number FROM proposals')).rows[0].github_pr_number, null);
  assert.equal(state.pulls.length, 0);
  assert.equal(fixComments('tests_failed').length, 1);
  assert.equal(fixComments('tests_failed')[0].body.includes('Return the right total'), false);
  assert.equal(fixComments('tests_failed')[0].body.includes('return 2'), false);
  assert.match(lines.join('\n'), /tests_failed/);
  assert.match([...state.issues.values()][0].body, /Estado del fix: detectado/);
  assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done');
});

test('a passing test command opens the pull when the patched tree hides the model key', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  writeConfig({
    testCommand: [process.execPath, '-e', "const fs=require('fs'); process.exit(fs.readFileSync('src/orders.js','utf8').includes('return 2;') && !process.env.LLM_API_KEY ? 0 : 1)"],
  });
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 1);
  assert.equal(fixComments('tests_failed').length, 0);
  assert.equal((await db.pool.query('SELECT state FROM jobs')).rows[0].state, 'done');
});

test('a local patch that does not apply comments fix_does_not_apply and opens nothing', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  state.model = {
    refusal: 'none',
    summary: 'Return the right total',
    evidence: [{ source: 'event', quote: 'orders broke badly' }],
    patches: [{ path: 'src/orders.js', before: 'return 9;', after: 'return 2;' }],
    newTests: [],
  };
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal((await db.pool.query('SELECT id FROM proposals')).rowCount, 0);
  assert.equal(state.pulls.length, 0);
  assert.equal(fixComments('fix_does_not_apply').length, 1);
  assert.equal(fixComments('fix_does_not_apply')[0].body.includes('return 9'), false);
});

test('dry run does not comment when the local patch does not apply', async () => {
  delete process.env.LOGS_WATCHER_DRY_RUN;
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  state.model = {
    refusal: 'none',
    summary: 'Return the right total',
    evidence: [{ source: 'event', quote: 'orders broke badly' }],
    patches: [{ path: 'src/orders.js', before: 'return 9;', after: 'return 2;' }],
    newTests: [],
  };
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 0);
  assert.equal(fixComments('fix_does_not_apply').length, 0);
  assert.equal(state.requests.some((req) => req.method === 'POST' && req.path.includes('/comments')), false);
  assert.equal((await db.pool.query('SELECT id FROM proposals')).rowCount, 0);
});

test('dry run does not comment when the test command would fail', async () => {
  delete process.env.LOGS_WATCHER_DRY_RUN;
  process.env.LLM_API_KEY = 'llm-key';
  process.env.LLM_MODEL = 'qwen-test';
  writeConfig({ testCommand: [process.execPath, '-e', 'process.exit(1)'] });
  const repo = makeRepo();
  await enqueue();
  await runOnce(db.pool, { githubApi: stubUrl, repoDir: repo });
  assert.equal(state.pulls.length, 0);
  assert.equal(fixComments('tests_failed').length, 0);
  assert.equal(state.requests.some((req) => req.method === 'POST' && req.path.includes('/comments')), false);
  assert.equal((await db.pool.query('SELECT github_pr_number FROM proposals')).rows[0].github_pr_number, null);
});
