import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { dryRun, loadConfig } from '../src/config.js';
import { createServer } from '../src/main.js';
import { listen } from './db.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-cfg-'));
const servers = [];

function write(name, text) {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test('a file without targets watches nothing', () => {
  const config = loadConfig(write('empty.json', '{ /* none */ "limits": { "dailyBudgetUsd": 5 } }'));
  assert.deepEqual(config.targets, []);
  assert.equal(config.phases.cicd, false);
  assert.equal(config.limits.dailyBudgetUsd, 5);
});

test('an empty owner is inactive and defaults fill in', () => {
  const config = loadConfig(write('owner.json', JSON.stringify({
    targets: [{ id: 'primary', github: { owner: '  ', name: 'app' } }],
  })));
  assert.equal(config.targets[0].active, false);
  assert.equal(config.targets[0].github.owner, '');
  assert.equal(config.targets[0].sentry.baseUrl, 'https://sentry.io');
  assert.equal(config.targets[0].posthog.host, 'https://us.posthog.com');
  assert.equal(config.targets[0].phases.cicd, false);
});

test('a line comment does not eat // inside a string', () => {
  const config = loadConfig(write('comment.json', `{
    "targets": [{
      "id": "primary",
      "github": { "owner": "acme", "name": "app" },
      "sentry": { "baseUrl": "https://sentry.example/a//b" } // keep https://sentry.example/a//b
    }]
  }`));
  assert.equal(config.targets[0].sentry.baseUrl, 'https://sentry.example/a//b');
  assert.equal(config.targets[0].active, true);
});

test('dry run is on unless the variable is exactly false', () => {
  const previous = process.env.LOGS_WATCHER_DRY_RUN;
  delete process.env.LOGS_WATCHER_DRY_RUN;
  assert.equal(dryRun(), true);
  process.env.LOGS_WATCHER_DRY_RUN = 'no';
  assert.equal(dryRun(), true);
  process.env.LOGS_WATCHER_DRY_RUN = 'false';
  assert.equal(dryRun(), false);
  if (previous === undefined) delete process.env.LOGS_WATCHER_DRY_RUN;
  else process.env.LOGS_WATCHER_DRY_RUN = previous;
});

test('phases.cicd is true only when the json says true', () => {
  const absent = loadConfig(write('cicd-absent.json', JSON.stringify({
    targets: [{ id: 'primary', github: { owner: 'acme', name: 'app' } }],
  })));
  assert.equal(absent.targets[0].phases.cicd, false);
  assert.equal(absent.phases.cicd, false);
  const text = loadConfig(write('cicd-text.json', JSON.stringify({
    targets: [{ id: 'primary', github: { owner: 'acme', name: 'app' }, phases: { cicd: 'true' } }],
  })));
  assert.equal(text.targets[0].phases.cicd, false);
  const on = loadConfig(write('cicd-on.json', JSON.stringify({
    targets: [{ id: 'primary', github: { owner: 'acme', name: 'app' }, phases: { cicd: true } }],
  })));
  assert.equal(on.targets[0].phases.cicd, true);
  assert.equal(existsSync('.github/workflows'), false);
});

test('healthz is 200 only when postgres answers', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const server = createServer(pool);
  servers.push(server);
  const port = await listen(server);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return real(url, opts);
  };
  try {
    assert.equal(calls.length, 0);
    const res = await real(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: 'up' });
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = real;
    await pool.end();
  }

  const down = new pg.Pool({
    connectionString: 'postgres://127.0.0.1:1/none',
    connectionTimeoutMillis: 400,
  });
  const bad = createServer(down);
  servers.push(bad);
  const badPort = await listen(bad);
  const failed = await fetch(`http://127.0.0.1:${badPort}/healthz`);
  assert.notEqual(failed.status, 200);
  await down.end();
});
