ALTER TABLE media_assets
 ADD COLUMN preview_object_key text,
 ADD COLUMN processing_error text;

CREATE TABLE media_processing_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 media_asset_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','RETRY','DONE','DEAD')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 run_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,client_id,id),
 FOREIGN KEY(organization_id,client_id,media_asset_id)
  REFERENCES media_assets(organization_id,client_id,id) ON DELETE CASCADE
);

CREATE INDEX media_processing_jobs_due_idx
 ON media_processing_jobs(run_at) WHERE status IN ('PENDING','RETRY');
CREATE INDEX media_assets_abandoned_upload_idx
 ON media_assets(created_at) WHERE status='UPLOADING' AND deleted_at IS NULL;
