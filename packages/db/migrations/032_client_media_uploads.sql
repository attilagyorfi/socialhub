-- Media uploaded by a client's own reviewer on the client portal. A row marks
-- its media asset as a portal upload; only ACCEPTED ones may be used in posts.
CREATE TABLE client_media_uploads (
 media_asset_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 uploaded_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
 note text CHECK (char_length(note) BETWEEN 1 AND 1000),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
 decided_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
 decided_at timestamptz,
 decision_reason text CHECK (char_length(decision_reason) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,media_asset_id)
  REFERENCES media_assets(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX client_media_uploads_scope_idx
 ON client_media_uploads(organization_id,client_id,status,created_at DESC,media_asset_id);
CREATE INDEX client_media_uploads_uploader_idx
 ON client_media_uploads(uploaded_by,created_at DESC);
CREATE INDEX client_media_uploads_decider_idx
 ON client_media_uploads(decided_by) WHERE decided_by IS NOT NULL;
