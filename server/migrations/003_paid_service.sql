-- Paid service: plans, balances, credit ledger, invite codes, upload links, worker status.

ALTER TABLE accounts
  ADD COLUMN plan text NOT NULL DEFAULT 'waitlist' CHECK (plan IN ('waitlist', 'trial', 'paid', 'internal')),
  ADD COLUMN clerk_user_id text UNIQUE,
  ADD COLUMN email text,
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN balance_micro bigint NOT NULL DEFAULT 0;
-- Every account that exists before this migration was made by the admin CLI for the owner.
UPDATE accounts SET plan = 'internal';

ALTER TABLE jobs
  ADD COLUMN hold_micro bigint,
  ADD COLUMN cost_micro bigint,
  ADD COLUMN upload_id uuid;

CREATE TABLE credit_ledger (
  id                bigserial PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id),
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('purchase', 'trial', 'grant', 'charge', 'refund')),
  amount_micro      bigint NOT NULL,
  job_id            uuid,
  stripe_session_id text,
  note              text,
  created_by        text
);
CREATE UNIQUE INDEX credit_ledger_stripe_session ON credit_ledger (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX credit_ledger_one_charge_per_job ON credit_ledger (job_id) WHERE kind = 'charge';
CREATE UNIQUE INDEX credit_ledger_one_trial ON credit_ledger (account_id) WHERE kind = 'trial';
CREATE INDEX credit_ledger_account ON credit_ledger (account_id, id DESC);

CREATE TABLE invite_codes (
  code        text PRIMARY KEY,
  note        text,
  max_uses    int NOT NULL DEFAULT 1,
  uses        int NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE uploads (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  token_hash       text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('pending', 'receiving', 'received', 'used', 'expired')),
  bundle_path      text,
  bytes            bigint,
  remotion_version text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX uploads_status_created ON uploads (status, created_at);

ALTER TABLE workers
  ADD COLUMN state text,
  ADD COLUMN state_until timestamptz,
  ADD COLUMN state_at timestamptz;
