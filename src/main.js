import http from 'node:http';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { handleWebhook } from './http.js';
import { log } from './queue.js';
import { runOnce } from './worker.js';

export function createServer(pool) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const run = req.method === 'GET' && path === '/healthz'
      ? healthz(res, pool)
      : handleWebhook(req, res, pool);
    run.catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
}

async function healthz(res, pool) {
  try {
    await pool.query('SELECT 1');
    const body = JSON.stringify({ ok: true, db: 'up' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch {
    const body = JSON.stringify({ ok: false, db: 'down' });
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) process.exit(1);
  loadConfig();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const server = createServer(pool);
  server.listen(8080, '127.0.0.1');
  for (;;) {
    try {
      await runOnce(pool);
    } catch {
      log({ level: 'error', msg: 'job_dead' });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
