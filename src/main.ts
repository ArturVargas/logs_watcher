import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import type { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { handleWebhook } from './http.js';
import { log } from './queue.js';
import { runOnce } from './worker.js';

export function createServer(pool: Pool): http.Server {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
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

async function healthz(res: ServerResponse, pool: Pool): Promise<void> {
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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) process.exit(1);
  loadConfig();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const server = createServer(pool);
  server.listen(Number(process.env.LOGS_WATCHER_PORT || 8080), process.env.LOGS_WATCHER_HOST || '127.0.0.1');
  for (;;) {
    try {
      await runOnce(pool);
    } catch {
      log({ level: 'error', msg: 'job_dead' });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
