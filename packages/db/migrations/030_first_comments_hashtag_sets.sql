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
 FOREIGN KEY(organization_id,client_id,target_id)
  REFERENCES post_targets(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX first_comment_jobs_due_idx
 ON first_comment_jobs(run_at) WHERE status IN ('PENDING','RETRY');

-- provider_receipts now also records first comments. A foreign key cannot
-- point at either of two tables, so the scope check (same organization and
-- client as the job) and the cascade become triggers.
DO $$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT conname FROM pg_constraint
  WHERE conrelid='provider_receipts'::regclass AND contype='f'
    AND confrelid='publish_jobs'::regclass
 LOOP
  EXECUTE format('ALTER TABLE provider_receipts DROP CONSTRAINT %I', r.conname);
 END LOOP;
END $$;

CREATE FUNCTION provider_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM publish_jobs
   WHERE idempotency_key=NEW.idempotency_key
     AND organization_id=NEW.organization_id AND client_id=NEW.client_id
 ) AND NOT EXISTS (
   SELECT 1 FROM first_comment_jobs
   WHERE idempotency_key=NEW.idempotency_key
     AND organization_id=NEW.organization_id AND client_id=NEW.client_id
 ) THEN
  RAISE EXCEPTION 'provider receipt has no job in this scope'
   USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_receipts_scope
 BEFORE INSERT OR UPDATE ON provider_receipts
 FOR EACH ROW EXECUTE FUNCTION provider_receipt_scope();

CREATE FUNCTION provider_receipt_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM provider_receipts WHERE idempotency_key=OLD.idempotency_key;
 RETURN OLD;
END $$;
CREATE TRIGGER publish_jobs_receipt_cleanup
 AFTER DELETE ON publish_jobs
 FOR EACH ROW EXECUTE FUNCTION provider_receipt_cleanup();
CREATE TRIGGER first_comment_jobs_receipt_cleanup
 AFTER DELETE ON first_comment_jobs
 FOR EACH ROW EXECUTE FUNCTION provider_receipt_cleanup();
