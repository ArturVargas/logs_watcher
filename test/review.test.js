import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { addedLines, defaultAvailable, enclosingSymbol, languageOf, oneCheck, reviewPullRequest } from '../src/review.js';
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
