-- Named hashtag sets per client; inserted into a caption or first comment.
CREATE TABLE client_hashtag_sets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 hashtags text[] NOT NULL CHECK (cardinality(hashtags) BETWEEN 1 AND 30),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_hashtag_sets_name_unique
 ON client_hashtag_sets(organization_id,client_id,lower(name));

-- Optional first comment per target; part of the approved snapshot.
ALTER TABLE post_targets
 ADD COLUMN first_comment text
 CHECK (first_comment IS NULL OR char_length(first_comment) <= 2200);

-- One durable job per published target. The idempotency key is derived from
-- the target id, so a duplicate enqueue maps to the same job and receipt.
CREATE TABLE first_comment_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 target_id uuid NOT NULL UNIQUE,
 idempotency_key uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING','RETRY','RUNNING','SENT','FAILED','UNCERTAIN')),
 attempts integer NOT NULL DEFAULT 0,
 run_at timestamptz NOT NULL DEFAULT now(),
 remote_id text,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,client_id,idempotency_key),
 FOREIGN KEY(organization_id,client_id,target_id)
  REFERENCES post_targets(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX first_comment_jobs_due_idx
 ON first_comment_jobs(run_at) WHERE status IN ('PENDING','RETRY');

-- Receipts of posted first comments. A separate table, so provider_receipts
-- keeps its foreign keys to publish_jobs unchanged. Same shape and the same
-- guarantees: one receipt per job idempotency key, scoped to the job's
-- organization and client, removed together with the job.
CREATE TABLE first_comment_receipts (
 idempotency_key uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 provider text NOT NULL,
 remote_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id)
  REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,idempotency_key)
  REFERENCES first_comment_jobs(organization_id,client_id,idempotency_key) ON DELETE CASCADE
);
