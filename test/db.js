import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../sql/schema.sql'), 'utf8');

export async function openTestDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const name = `t_${process.pid}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${name}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(schemaSql);
  return {
    pool,
    async reset() {
      await pool.query('TRUNCATE inbox, jobs, groups, proposals, cost_ledger');
    },
    async close() {
      await pool.end();
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      await client.end();
    },
  };
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
