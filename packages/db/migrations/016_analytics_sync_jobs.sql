CREATE TABLE analytics_sync_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 social_account_id uuid NOT NULL,
 target_id uuid,
 requested_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('PROFILE','POST')),
 snapshot_day date NOT NULL,
 status text NOT NULL DEFAULT 'PENDING'
   CHECK(status IN ('PENDING','RUNNING','RETRY','DONE','DEAD')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 run_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 completed_at timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(
   (kind='PROFILE' AND target_id IS NULL)
   OR
   (kind='POST' AND target_id IS NOT NULL)
 ),
 UNIQUE(organization_id,client_id,id),
 FOREIGN KEY(organization_id,client_id,social_account_id)
   REFERENCES social_accounts(organization_id,client_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,target_id)
   REFERENCES post_targets(organization_id,client_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX analytics_sync_jobs_profile_day_idx
 ON analytics_sync_jobs(social_account_id,snapshot_day)
 WHERE kind='PROFILE';
CREATE UNIQUE INDEX analytics_sync_jobs_post_day_idx
 ON analytics_sync_jobs(target_id,snapshot_day)
 WHERE kind='POST';
CREATE INDEX analytics_sync_jobs_due_idx
 ON analytics_sync_jobs(run_at,created_at)
 WHERE status IN ('PENDING','RETRY');
CREATE INDEX analytics_sync_jobs_scope_status_idx
 ON analytics_sync_jobs(organization_id,client_id,status,updated_at DESC);

CREATE FUNCTION enforce_analytics_sync_scope() RETURNS trigger AS $$
BEGIN
 IF NEW.kind='POST' AND NOT EXISTS(
   SELECT 1 FROM post_targets t
   WHERE t.organization_id=NEW.organization_id
     AND t.client_id=NEW.client_id
     AND t.id=NEW.target_id
     AND t.social_account_id=NEW.social_account_id
 ) THEN
   RAISE EXCEPTION 'analytics target must belong to the selected social account';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analytics_sync_scope_guard
 BEFORE INSERT OR UPDATE OF organization_id,client_id,social_account_id,target_id,kind
 ON analytics_sync_jobs
 FOR EACH ROW EXECUTE FUNCTION enforce_analytics_sync_scope();
