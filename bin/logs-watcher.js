#!/usr/bin/env node
import pg from "pg";
import { run } from "../src/cli.js";

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  process.exitCode = await run(process.argv.slice(2), pool);
} finally {
  await pool.end();
}
