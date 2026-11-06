import type { Pool } from 'pg';
import { spentUsd } from './queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: logs-watcher jobs list --state <state> | jobs retry <uuid> | budget show';

type OutFn = (line: string) => void;

interface JobListRow {
  id: string;
  kind: string;
  last_error: string | null;
}

export async function run(argv: string[], pool: Pool, out: OutFn = console.log): Promise<number> {
  const [group, action, ...rest] = argv;
  if (group === 'jobs' && action === 'list' && rest[0] === '--state' && rest[1] && rest.length === 2) {
    const { rows } = await pool.query<JobListRow>(
      'SELECT id, kind, last_error FROM jobs WHERE state = $1 ORDER BY run_after, id',
      [rest[1]],
    );
    for (const row of rows) out(`${row.id}\t${row.kind}\t${row.last_error ?? ''}`);
    return 0;
  }
  if (group === 'jobs' && action === 'retry' && rest.length === 1) {
    const id = rest[0];
    if (id === undefined || !UUID.test(id)) { out(USAGE); return 2; }
    const { rowCount } = await pool.query(
      "UPDATE jobs SET state = 'queued', attempts = 0, run_after = now(), locked_at = NULL WHERE id = $1",
      [id],
    );
    if (rowCount === 0) { out(`job not found: ${id}`); return 1; }
    out(`queued ${id}`);
    return 0;
  }
  if (group === 'budget' && action === 'show' && rest.length === 0) {
    out((await spentUsd(pool)).toFixed(6));
    return 0;
  }
  out(USAGE);
  return 2;
}
