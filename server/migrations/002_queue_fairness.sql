-- Claim order uses queued_at (reset on every requeue) so a job that keeps getting handed back
-- goes to the back of the line instead of starving everyone else.
ALTER TABLE jobs ADD COLUMN queued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jobs ADD COLUMN requeues int NOT NULL DEFAULT 0;
UPDATE jobs SET queued_at = created_at;
CREATE INDEX jobs_status_queued ON jobs (status, queued_at);
