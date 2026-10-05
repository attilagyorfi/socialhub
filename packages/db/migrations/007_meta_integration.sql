CREATE UNIQUE INDEX publish_jobs_scope_idempotency_unique
 ON publish_jobs(organization_id,client_id,idempotency_key);

CREATE TABLE provider_receipts (
 idempotency_key uuid PRIMARY KEY REFERENCES publish_jobs(idempotency_key) ON DELETE CASCADE,
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 provider text NOT NULL,
 remote_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,idempotency_key)
  REFERENCES publish_jobs(organization_id,client_id,idempotency_key) ON DELETE CASCADE
);

CREATE INDEX provider_receipts_scope_idx
 ON provider_receipts(organization_id,client_id,provider,created_at DESC);

ALTER TABLE webhook_events
 ADD COLUMN social_account_id uuid,
 ADD COLUMN event_type text,
 ADD COLUMN signature_valid boolean NOT NULL DEFAULT true,
 ADD COLUMN processed_at timestamptz,
 ADD COLUMN last_error text,
 ADD FOREIGN KEY(organization_id,client_id,social_account_id)
  REFERENCES social_accounts(organization_id,client_id,id) ON DELETE CASCADE;

CREATE INDEX webhook_events_account_idx
 ON webhook_events(organization_id,client_id,social_account_id,created_at DESC);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);
