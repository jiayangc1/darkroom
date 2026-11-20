CREATE TABLE accounts (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  webhook_secret text NOT NULL,
  limits         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id),
  prefix       text NOT NULL,
  hash         text NOT NULL UNIQUE,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE workers (
  id           uuid PRIMARY KEY,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  capabilities jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  status           text NOT NULL CHECK (status IN
                     ('uploading','queued','rendering','uploading_output','done','failed','canceled','expired')),
  composition_id   text NOT NULL,
  input_props      jsonb NOT NULL DEFAULT '{}',
  render_options   jsonb NOT NULL DEFAULT '{}',
  remotion_version text,
  bundle_path      text,
  bundle_bytes     bigint,
  output_path      text,
  output_url       text,
  output_bytes     bigint,
  webhook_url      text,
  progress         real NOT NULL DEFAULT 0,
  stage            text,
  attempts         int NOT NULL DEFAULT 0,
  worker_id        uuid REFERENCES workers(id),
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  error            jsonb,
  video            jsonb,
  render_seconds   real,
  video_seconds    real,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz
);
CREATE INDEX jobs_status_created ON jobs (status, created_at);
CREATE INDEX jobs_account_created ON jobs (account_id, created_at DESC);

CREATE TABLE job_events (
  id     bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at     timestamptz NOT NULL DEFAULT now(),
  type   text NOT NULL,
  data   jsonb
);
CREATE INDEX job_events_job ON job_events (job_id, id);

CREATE TABLE webhook_deliveries (
  job_id       uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  event        text NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  gave_up_at   timestamptz,
  last_error   text
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_at)
  WHERE delivered_at IS NULL AND gave_up_at IS NULL;
