CREATE TABLE publish_reconciliation_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 publish_job_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'PENDING'
  CHECK(status IN ('PENDING','RUNNING','RETRY','CONFIRMED','UNRESOLVED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 run_at timestamptz NOT NULL DEFAULT now(),
 outcome text CHECK(outcome IN ('MATCHED','NOT_FOUND','AMBIGUOUS','ERROR')),
 matched_remote_id text,
 last_error text,
 started_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,client_id,id),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,publish_job_id)
  REFERENCES publish_jobs(organization_id,client_id,id) ON DELETE CASCADE
);

CREATE INDEX publish_reconciliation_due_idx
 ON publish_reconciliation_jobs(run_at,created_at)
 WHERE status IN ('PENDING','RETRY');

CREATE INDEX publish_reconciliation_scope_idx
 ON publish_reconciliation_jobs(organization_id,client_id,status,updated_at DESC);
