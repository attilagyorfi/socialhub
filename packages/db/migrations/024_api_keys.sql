-- Organization API keys for the /api/v1 integration API. Only the SHA-256
-- hash of a key is stored; the raw key is shown once when it is created.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  key_prefix text NOT NULL CHECK(length(key_prefix) BETWEEN 1 AND 20),
  key_hash text NOT NULL CHECK(key_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid REFERENCES "user" ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES "user" ON DELETE SET NULL
);
CREATE UNIQUE INDEX api_keys_key_hash_unique ON api_keys(key_hash);
CREATE INDEX api_keys_organization_idx ON api_keys(organization_id,created_at DESC);
