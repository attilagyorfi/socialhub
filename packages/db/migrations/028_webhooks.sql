-- Signed outgoing webhooks of the /api/v1 integration contract. Endpoints
-- belong to an organization; the signing secret is stored only encrypted
-- (packages/core/security.ts) and shown once when created or rotated.
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  url text NOT NULL CHECK(url ~ '^https://' AND length(url) <= 2048),
  secret_ciphertext text NOT NULL,
  secret_prefix text NOT NULL CHECK(length(secret_prefix) BETWEEN 1 AND 20),
  events text[] NOT NULL CHECK(
    cardinality(events) BETWEEN 1 AND 4
    AND events <@ ARRAY['post.approved','post.changes_requested','post.published','post.failed']::text[]
  ),
  created_by_user_id uuid REFERENCES "user" ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  secret_rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES "user" ON DELETE SET NULL,
  UNIQUE(organization_id,id)
);
CREATE INDEX webhook_endpoints_active_idx
  ON webhook_endpoints(organization_id) WHERE revoked_at IS NULL;

-- Outbox of webhook deliveries. Rows are written in the same transaction as
-- the post state change; the worker claims them with FOR UPDATE SKIP LOCKED.
-- Every delivery has its own event_id so receivers can deduplicate retries.
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL,
  client_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  event_type text NOT NULL CHECK(
    event_type IN ('post.approved','post.changes_requested','post.published','post.failed')
  ),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','RUNNING','RETRY','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 12),
  run_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK(last_error IS NULL OR length(last_error) <= 64),
  last_status_code integer,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,endpoint_id)
    REFERENCES webhook_endpoints(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,client_id)
    REFERENCES clients(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries(run_at,created_at)
  WHERE status IN ('PENDING','RETRY');
CREATE INDEX webhook_deliveries_endpoint_idx
  ON webhook_deliveries(endpoint_id,status);
CREATE INDEX webhook_deliveries_organization_status_idx
  ON webhook_deliveries(organization_id,status,updated_at DESC);
