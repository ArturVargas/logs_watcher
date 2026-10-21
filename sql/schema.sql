CREATE TABLE IF NOT EXISTS inbox (
  delivery_id text PRIMARY KEY,
  source text NOT NULL,
  target_id text,
  received_at timestamptz NOT NULL,
  payload jsonb,
  status text NOT NULL,
  drop_reason text
);

CREATE TABLE IF NOT EXISTS groups (
  target_id text NOT NULL,
  sentry_issue_id text NOT NULL,
  importance text,
  urgency text,
  importance_model text,
  issue_language text NOT NULL,
  github_issue_number integer,
  latest_event_id text,
  class text,
  priority text,
  dirty boolean NOT NULL DEFAULT false,
  progress_stale boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_id, sentry_issue_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY,
  target_id text NOT NULL,
  kind text NOT NULL,
  generation_key text NOT NULL UNIQUE,
  state text NOT NULL,
  sentry_issue_id text,
  github_issue_number integer,
  github_pr_number integer,
  base_sha text,
  head_sha text,
  target_hash text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL,
  locked_at timestamptz,
  last_error text,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (state, run_after);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id uuid PRIMARY KEY,
  day date NOT NULL,
  kind text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  usd numeric(12, 6) NOT NULL,
  created_at timestamptz NOT NULL
);
