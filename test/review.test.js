import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { addedLines, checkoutHead, defaultAvailable, enclosingSymbol, languageOf, oneCheck, reviewPullRequest } from '../src/review.js';
import { runOnce } from '../src/worker.js';
import { listen, openTestDb } from './db.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SOURCE = [
  'contract Vault {',
  '    function withdraw() public {',
  '        msg.sender.call("");',
  '    }',
  '    function deposit() public {',
  '        require(true);',
  '    }',
  '}',
].join('\n');
const PATCH = [
  '@@ -1,7 +1,8 @@ function',
  ' contract Vault {',
  '     function withdraw() public {',
  '+        msg.sender.call("");',
  '     }',
  '     function deposit() public {',
  '         require(true);',
  '     }',
  ' }',
].join('\n');
const dir = mkdtempSync(join(tmpdir(), 'lw-review-'));
const keyPath = join(dir, 'app.pem');
const state = { requests: [], comments: [] };
let db;
let stub;
let stubUrl;
let realFetch;

function shape(finding) {
  assert.deepEqual(Object.keys(finding).sort(), ['file', 'line', 'message', 'rule_id', 'severity']);
}

function vaultFile() {
  return { path: 'contracts/Vault.sol', patch: PATCH, content: SOURCE };
}

function slitherStdout() {
  return JSON.stringify({
    results: {
      detectors: [
        {
          check: 'missing-zero-check',
          impact: 'Low',
          description: 'deposit misses a zero check',
          elements: [{ source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [6] } }],
        },
        {
          check: 'reentrancy-eth',
          impact: 'High',
          description: 'withdraw uses ghp_secretvaluehere',
          elements: [{ source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [2] } }],
        },
      ],
    },
  });
}

function target() {
  return { id: 'primary', active: true, github: { owner: 'acme', name: 'app', installationId: '77' } };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function writeConfig() {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    targets: [{
      id: 'primary',
      github: { owner: 'acme', name: 'app', installationId: '77' },
      sentry: { org: 'org', project: 'proj', productionEnvironments: ['production'] },
    }],
  }));
  process.env.LOGS_WATCHER_CONFIG = file;
}

async function enqueue() {
  await db.pool.query(
    `INSERT INTO jobs (id, kind, dedupe_key, state, run_after, payload)
     VALUES (gen_random_uuid(), 'review_pr', $2, 'queued', now(), $1::jsonb)`,
    [JSON.stringify({ targetId: 'primary', number: 7, sha: SHA }), `review:primary:7:${SHA}`],
  );
}

function reviewOpts(run) {
  return {
    githubApi: stubUrl,
    files: [vaultFile()],
    available: (tool) => tool === 'slither',
    run: run ?? (async () => ({ ran: true, stdout: slitherStdout() })),
  };
}

function gitLocal(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
  return result.stdout.trim();
}

test('checkoutHead puts the pull request sha on disk without saving the token', async () => {
  const source = mkdtempSync(join(tmpdir(), 'lw-src-'));
  const dest = mkdtempSync(join(tmpdir(), 'lw-dst-'));
  try {
    gitLocal(source, ['init', '-b', 'main']);
    mkdirSync(join(source, 'web'));
    mkdirSync(join(source, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(source, 'web/app.ts'), 'export function total() {\n  return 1;\n}\n');
    writeFileSync(join(source, 'src.rs'), 'fn demo() {}\n');
    writeFileSync(join(source, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.0.0"\n');
    writeFileSync(join(source, 'Cargo.lock'), '# lock\n');
    writeFileSync(join(source, 'node_modules/.bin/eslint'), '#!/bin/sh\n');
    writeFileSync(join(source, 'node_modules/.bin/tsc'), '#!/bin/sh\n');
    gitLocal(source, ['add', '-A']);
    gitLocal(source, ['commit', '-m', 'init']);
    const sha = gitLocal(source, ['rev-parse', 'HEAD']);
    const token = 'ghs_checkout_secret';
    const ok = await checkoutHead({ owner: 'acme', name: 'app', sha, token, dir: dest, remote: source });
    assert.equal(ok, true);
    assert.equal(readFileSync(join(dest, 'web/app.ts'), 'utf8').includes('function total'), true);
    assert.equal(existsSync(join(dest, 'Cargo.toml')), true);
    assert.equal(existsSync(join(dest, 'Cargo.lock')), true);
    assert.equal(defaultAvailable('eslint', { repoDir: dest }), true);
    assert.equal(defaultAvailable('tsc', { repoDir: dest }), true);
    assert.equal(defaultAvailable('clippy', { repoDir: dest }), spawnSync('which', ['cargo']).status === 0);
    assert.equal(defaultAvailable('cargo-audit', { repoDir: dest }), spawnSync('which', ['cargo-audit']).status === 0);
    assert.equal(defaultAvailable('cargo-deny', { repoDir: dest }), spawnSync('which', ['cargo-deny']).status === 0);
    const config = readFileSync(join(dest, '.git/config'), 'utf8');
    assert.equal(config.includes(token), false);
    assert.equal(config.includes('ghs_'), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('a changed line maps to the enclosing symbol of the watched languages', () => {
  assert.deepEqual([...addedLines(PATCH)], [3]);
  assert.equal(enclosingSymbol(SOURCE, 3, 'solidity').name, 'withdraw');
  assert.equal(enclosingSymbol(SOURCE, 6, 'solidity').name, 'deposit');
  assert.equal(enclosingSymbol(SOURCE, 1, 'solidity').name, 'Vault');
  const rust = 'fn outer() {\n    fn inner() {\n        let x = 1;\n    }\n}\n';
  assert.equal(enclosingSymbol(rust, 3, 'rust').name, 'inner');
  const ts = 'export class Vault {\n  withdraw() {\n    return "{";\n  }\n}\n';
  assert.equal(enclosingSymbol(ts, 3, 'typescript').name, 'withdraw');
  const commented = 'function real() {\n  // function fake() {\n  return 1;\n}\n';
  assert.equal(enclosingSymbol(commented, 3, 'typescript').name, 'real');
  assert.equal(languageOf('contracts/Vault.sol'), 'solidity');
  assert.equal(languageOf('src/lib.rs'), 'rust');
  assert.equal(languageOf('web/App.tsx'), 'typescript');
  assert.equal(languageOf('main.py'), null);
  assert.equal(languageOf('src/app.js'), null);
});

test('one check uses the first tool for that language and no invented linter', async () => {
  const calls = [];
  const run = async (tool, stdout) => {
    calls.push(tool);
    return { ran: true, stdout };
  };
  calls.length = 0;
  let check = await oneCheck({
    language: 'solidity',
    file: 'C.sol',
    available: () => true,
    run: (tool) => run(tool, tool === 'slither' ? '{"results":{"detectors":[{"check":"reentrancy-eth","impact":"High","description":"reentered","elements":[{"source_mapping":{"filename_relative":"C.sol","lines":[3]}}]}]}}' : ''),
  });
  assert.deepEqual(calls, ['slither']);
  shape(check.findings[0]);
  assert.equal(check.findings[0].rule_id, 'reentrancy-eth');
  assert.equal(check.findings[0].severity, 'error');
  assert.equal(check.findings[0].line, 3);

  calls.length = 0;
  check = await oneCheck({
    language: 'solidity',
    file: 'C.sol',
    available: () => true,
    run: async (tool) => {
      calls.push(tool);
      if (tool !== 'aderyn') return { ran: false, stdout: '' };
      return { ran: true, stdout: '{"high_issues":{"issues":[{"detector_name":"delegate-call-in-loop","description":"delegatecall","instances":[{"contract_path":"C.sol","line_no":4}]}]}}' };
    },
  });
  assert.deepEqual(calls, ['slither', 'aderyn']);
  assert.equal(check.findings[0].rule_id, 'delegate-call-in-loop');
  assert.equal(check.findings[0].severity, 'error');

  calls.length = 0;
  check = await oneCheck({
    language: 'solidity',
    file: 'C.sol',
    available: (tool) => tool === 'solhint',
    run: async (tool) => {
      calls.push(tool);
      return { ran: true, stdout: '[{"filePath":"C.sol","errors":[{"line":3,"ruleId":"compiler-version","severity":2,"message":"version"}]}]' };
    },
  });
  assert.deepEqual(calls, ['solhint']);
  assert.equal(check.findings[0].rule_id, 'compiler-version');

  calls.length = 0;
  check = await oneCheck({
    language: 'rust',
    file: 'src/lib.rs',
    available: (tool) => tool !== 'clippy',
    run: async (tool) => {
      calls.push(tool);
      return { ran: true, stdout: '{"vulnerabilities":{"list":[{"advisory":{"id":"RUSTSEC-2020-0001","title":"overflow","severity":"high"}}]}}' };
    },
  });
  assert.deepEqual(calls, ['cargo-audit']);
  assert.deepEqual(check.findings, []);

  calls.length = 0;
  check = await oneCheck({
    language: 'rust',
    file: 'src/lib.rs',
    available: (tool) => tool === 'cargo-deny',
    run: async (tool) => {
      calls.push(tool);
      return { ran: true, stdout: '{"type":"diagnostic","fields":{"code":"A007","severity":"warning","message":"advisory was not encountered","labels":[{"line":4}]}}\n' };
    },
  });
  assert.deepEqual(calls, ['cargo-deny']);
  shape(check.findings[0]);
  assert.equal(check.findings[0].rule_id, 'A007');
  assert.equal(check.findings[0].file, 'src/lib.rs');
  assert.equal(check.findings[0].severity, 'warning');

  calls.length = 0;
  check = await oneCheck({
    language: 'typescript',
    file: 'a.ts',
    available: (tool) => tool === 'eslint',
    run: async (tool) => {
      calls.push(tool);
      return { ran: true, stdout: '[{"filePath":"/repo/a.ts","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"x is unused","line":2}]}]' };
    },
  });
  assert.deepEqual(calls, ['eslint']);
  shape(check.findings[0]);
  assert.equal(check.findings[0].rule_id, 'no-unused-vars');
  assert.equal(check.findings[0].severity, 'error');

  calls.length = 0;
  check = await oneCheck({
    language: 'typescript',
    file: 'a.ts',
    available: (tool) => tool === 'tsc',
    run: async (tool) => {
      calls.push(tool);
      return { ran: true, stdout: 'a.ts(2,1): error TS2322: bad assignment\n' };
    },
  });
  assert.deepEqual(calls, ['tsc']);
  assert.equal(check.findings[0].rule_id, 'TS2322');
  assert.equal(check.findings[0].line, 2);

  let asked = false;
  check = await oneCheck({
    language: languageOf('main.py'),
    file: 'main.py',
    available: () => { asked = true; return true; },
    run: async () => { throw new Error('ran a linter'); },
  });
  assert.equal(check, null);
  assert.equal(asked, false);

  const empty = mkdtempSync(join(tmpdir(), 'lw-eslint-'));
  assert.equal(defaultAvailable('eslint', { repoDir: empty }), false);
  const bin = join(empty, 'node_modules/.bin/eslint');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n');
  assert.equal(defaultAvailable('eslint', { repoDir: empty }), true);
  assert.equal(defaultAvailable('tsc', { repoDir: empty }), false);
  assert.equal(defaultAvailable('made-up-linter', { repoDir: empty }), false);
});

test('dry run keeps the cited finding and does not call GitHub', async () => {
  const real = globalThis.fetch;
  try {
    for (const flag of [undefined, 'true', 'FALSE', 'false ', 'no']) {
      const calls = [];
      globalThis.fetch = async () => { calls.push('fetch'); throw new Error('fetch'); };
      if (flag === undefined) delete process.env.LOGS_WATCHER_DRY_RUN;
      else process.env.LOGS_WATCHER_DRY_RUN = flag;
      const result = await reviewPullRequest({
        target: target(),
        number: 7,
        sha: SHA,
        files: [vaultFile()],
        available: () => true,
        run: async () => ({ ran: true, stdout: slitherStdout() }),
      });
      assert.equal(result.published, false, String(flag));
      assert.equal(calls.length, 0, String(flag));
      shape(result.finding);
      assert.equal(result.finding.file, 'contracts/Vault.sol');
      assert.equal(result.finding.line, 2);
      assert.equal(result.finding.rule_id, 'reentrancy-eth');
      assert.equal(result.finding.message.includes('ghp_'), false);
      assert.equal(result.finding.message.includes('[redacted]'), true);
    }
  } finally {
    globalThis.fetch = real;
  }
  const missed = await reviewPullRequest({
    target: target(),
    number: 7,
    sha: SHA,
    files: [vaultFile()],
    available: (tool) => tool === 'slither',
    run: async () => ({ ran: true, stdout: JSON.stringify({ results: { detectors: [{ check: 'missing-zero-check', impact: 'Low', description: 'elsewhere', elements: [{ source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [6] } }] }] } }) }),
  });
  assert.equal(missed.finding, null);
  const calls = [];
  const other = await reviewPullRequest({
    target: target(),
    number: 7,
    sha: SHA,
    files: [
      { path: 'a.ts', patch: '@@ -0,0 +1,2 @@\n+export function total() {\n+  return 1;\n+}\n', content: 'export function total() {\n  return 1;\n}\n' },
      { path: 'main.py', patch: '@@ -1 +1 @@\n-a\n+b\n', content: 'b\n' },
      vaultFile(),
      { path: 'z.rs', patch: '@@ -1 +1 @@\n-a\n+fn broken() {}\n', content: 'fn broken() {}\n' },
    ],
    available: () => true,
    run: async (tool, input) => {
      calls.push(`${tool}:${input.file}`);
      if (tool === 'slither') return { ran: true, stdout: slitherStdout() };
      return { ran: true, stdout: '[]' };
    },
  });
  assert.deepEqual(calls, ['eslint:a.ts', 'slither:contracts/Vault.sol']);
  assert.equal(other.finding.rule_id, 'reentrancy-eth');
});

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      state.requests.push({ method: req.method, path: url.pathname, body });
      if (req.method === 'POST' && url.pathname === '/app/installations/77/access_tokens') return send(res, 201, { token: 'ghs_test' });
      if (req.method === 'GET' && url.pathname === '/repos/acme/app/pulls/7/files') return send(res, 200, state.files ?? []);
      if (req.method === 'GET' && url.pathname === '/repos/acme/app/contents/contracts/Vault.sol') {
        return send(res, 200, { encoding: 'base64', content: state.content ?? '' });
      }
      if (url.pathname === '/repos/acme/app/pulls/7/comments') {
        if (req.method === 'GET') return send(res, 200, state.comments);
        state.comments.push(body);
        return send(res, 201, body);
      }
      send(res, 404, { path: url.pathname });
    });
  });
  const port = await listen(stub);
  stubUrl = `http://127.0.0.1:${port}`;
  db = await openTestDb();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.github.com')) throw new Error(`live github call ${url}`);
    return realFetch(url, opts);
  };
  writeConfig();
});

beforeEach(async () => {
  await db.reset();
  state.requests.length = 0;
  state.comments = [];
  state.files = [];
  state.content = '';
  delete process.env.LOGS_WATCHER_DRY_RUN;
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  writeConfig();
});

after(async () => {
  globalThis.fetch = realFetch;
  stub.close();
  await db.close();
});

test('a non-false dry run stores the finding and publishes nothing', async () => {
  for (const flag of [undefined, 'true', 'FALSE', 'false ', 'no']) {
    await db.reset();
    state.requests.length = 0;
    if (flag === undefined) delete process.env.LOGS_WATCHER_DRY_RUN;
    else process.env.LOGS_WATCHER_DRY_RUN = flag;
    await enqueue();
    await runOnce(db.pool, reviewOpts());
    assert.equal(state.requests.length, 0, String(flag));
    const job = await db.pool.query(`SELECT state, payload FROM jobs`);
    assert.equal(job.rows[0].state, 'done');
    shape(job.rows[0].payload.finding);
    assert.equal(job.rows[0].payload.finding.rule_id, 'reentrancy-eth');
    assert.equal(job.rows[0].payload.finding.line, 2);
    assert.equal(job.rows[0].payload.finding.message.includes('ghp_'), false);
  }
});

test('false publishes one inline comment that cites the finding', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  await enqueue();
  await runOnce(db.pool, reviewOpts());
  const posts = state.requests.filter((req) => req.method === 'POST' && req.path === '/repos/acme/app/pulls/7/comments');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.path, 'contracts/Vault.sol');
  assert.equal(posts[0].body.line, 3);
  assert.equal(posts[0].body.side, 'RIGHT');
  assert.equal(posts[0].body.commit_id, SHA);
  assert.match(posts[0].body.body, /`contracts\/Vault.sol:2` `reentrancy-eth`/);
  assert.equal(posts[0].body.body.includes('missing-zero-check'), false);
  assert.equal(posts[0].body.body.includes('ghp_'), false);
  assert.equal(state.requests.some((req) => req.method === 'PATCH' || String(req.path).includes('merge') || req.path === '/repos/acme/app/issues'), false);
  const job = await db.pool.query(`SELECT state FROM jobs`);
  assert.equal(job.rows[0].state, 'done');
});

test('no citation publishes no comment', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  await enqueue();
  await runOnce(db.pool, reviewOpts(async () => ({ ran: true, stdout: '{"results":{"detectors":[{"check":"","impact":"High","description":"x","elements":[{"source_mapping":{"filename_relative":"contracts/Vault.sol","lines":[3]}}]}]}}' })));
  assert.equal(state.requests.length, 0);
  const job = await db.pool.query(`SELECT state, payload FROM jobs`);
  assert.equal(job.rows[0].state, 'done');
  assert.equal(job.rows[0].payload.finding, undefined);
});

test('an existing citation is not posted again', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  state.comments = [{ body: '`contracts/Vault.sol:2` `reentrancy-eth`\nalready' }];
  await enqueue();
  await runOnce(db.pool, reviewOpts());
  assert.equal(state.requests.some((req) => req.method === 'GET' && req.path.endsWith('/comments')), true);
  assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/comments')).length, 0);
  assert.equal(state.comments.length, 1);
});

test('the pull request file list is fetched and still publishes one comment', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  state.files = [{ filename: 'contracts/Vault.sol', status: 'modified', patch: PATCH }];
  state.content = Buffer.from(SOURCE).toString('base64');
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    available: (tool) => tool === 'slither',
    run: async () => ({ ran: true, stdout: slitherStdout() }),
  });
  const posts = state.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/comments'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.line, 3);
  assert.match(posts[0].body.body, /`contracts\/Vault.sol:2` `reentrancy-eth`/);
  assert.equal(state.requests.some((req) => req.path === '/repos/acme/app/pulls/7/files'), true);
  assert.equal(state.requests.some((req) => req.method === 'PATCH' || String(req.path).includes('merge')), false);
});

test('typescript and rust tools run in the checked out tree', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  const checkouts = [];
  const runs = [];
  const checkout = async (input) => {
    checkouts.push({ ...input });
    writeFileSync(join(input.dir, 'marker'), 'tree');
    return true;
  };
  const ts = (path, name) => ({
    path,
    content: `export function ${name}() {\n  return 1;\n}\n`,
    patch: `@@ -0,0 +1,3 @@\n+export function ${name}() {\n+  return 1;\n+}\n`,
  });
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    files: [ts('a.ts', 'first'), ts('b.ts', 'second')],
    checkout,
    available: (tool, ctx) => tool === 'eslint' && existsSync(join(ctx.repoDir, 'marker')),
    run: async (tool, ctx) => {
      runs.push({ tool, file: ctx.file, repoDir: ctx.repoDir });
      if (ctx.file === 'a.ts') return { ran: true, stdout: '[]' };
      return { ran: true, stdout: '[{"filePath":"/repo/b.ts","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"x","line":2}]}]' };
    },
  });
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].owner, 'acme');
  assert.equal(checkouts[0].name, 'app');
  assert.equal(checkouts[0].sha, SHA);
  assert.equal(checkouts[0].token, 'ghs_test');
  assert.deepEqual(runs.map((item) => `${item.tool}:${item.file}`), ['eslint:a.ts', 'eslint:b.ts']);
  assert.equal(runs[0].repoDir, checkouts[0].dir);
  assert.equal(runs[1].repoDir, checkouts[0].dir);
  const posts = state.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/comments'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.body, /`b.ts:2` `no-unused-vars`/);

  await db.reset();
  state.requests.length = 0;
  checkouts.length = 0;
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    files: [ts('web/app.ts', 'total')],
    checkout,
    available: (tool, ctx) => tool === 'tsc' && ctx.repoDir === checkouts[0]?.dir,
    run: async (tool, ctx) => {
      assert.equal(tool, 'tsc');
      assert.equal(ctx.repoDir, checkouts[0].dir);
      return { ran: true, stdout: 'web/app.ts(2,3): error TS2322: bad\n' };
    },
  });
  assert.equal(checkouts.length, 1);
  assert.match(state.requests.find((req) => req.method === 'POST' && req.path.endsWith('/comments')).body.body, /`web\/app.ts:2` `TS2322`/);

  await db.reset();
  state.requests.length = 0;
  checkouts.length = 0;
  const rust = {
    path: 'src/lib.rs',
    content: 'fn demo() {\n  let x = 1;\n}\n',
    patch: '@@ -0,0 +1,3 @@\n+fn demo() {\n+  let x = 1;\n+}\n',
  };
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    files: [rust],
    checkout,
    available: (tool, ctx) => tool === 'cargo-deny' && ctx.repoDir === checkouts.at(-1)?.dir,
    run: async (tool, ctx) => {
      assert.equal(tool, 'cargo-deny');
      assert.equal(ctx.repoDir, checkouts[0].dir);
      return { ran: true, stdout: '{"type":"diagnostic","fields":{"code":"A007","severity":"warning","message":"advisory","labels":[{"line":2,"path":"src/lib.rs"}]}}\n' };
    },
  });
  assert.equal(checkouts.length, 1);
  assert.match(state.requests.find((req) => req.method === 'POST' && req.path.endsWith('/comments')).body.body, /`src\/lib.rs:2` `A007`/);
});

test('solidity stays on one file and dry run does not check out', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  let calls = 0;
  await enqueue();
  await runOnce(db.pool, { ...reviewOpts(), checkout: async () => { calls += 1; return true; } });
  assert.equal(calls, 0);
  assert.equal(state.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/comments')).length, 1);

  await db.reset();
  state.requests.length = 0;
  process.env.LOGS_WATCHER_DRY_RUN = 'true';
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    files: [{ path: 'a.ts', content: 'export function first() {\n  return 1;\n}\n', patch: '@@ -0,0 +1,3 @@\n+export function first() {\n+  return 1;\n+}\n' }],
    checkout: async () => { calls += 1; return true; },
    available: () => true,
    run: async () => ({ ran: true, stdout: '[]' }),
  });
  assert.equal(calls, 0);
  assert.equal(state.requests.length, 0);
});

test('another language runs no linter and publishes nothing', async () => {
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  const calls = [];
  await enqueue();
  await runOnce(db.pool, {
    githubApi: stubUrl,
    files: [{ path: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b\n', content: 'b\n' }],
    available: () => true,
    run: async (tool) => { calls.push(tool); return { ran: true, stdout: '' }; },
  });
  assert.deepEqual(calls, []);
  assert.equal(state.requests.length, 0);
});
