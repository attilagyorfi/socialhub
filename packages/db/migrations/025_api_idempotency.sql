-- Draft metadata from the /api/v1 integration API. suggested_at is only a
-- proposal: it never schedules anything, so scheduled_at stays separate.
-- media_urls are stored as metadata; nothing is downloaded.
ALTER TABLE posts
  ADD COLUMN suggested_at timestamptz,
  ADD COLUMN pillar text CHECK(length(pillar) BETWEEN 1 AND 100),
  ADD COLUMN source text CHECK(length(source) BETWEEN 1 AND 100),
  ADD COLUMN media_urls jsonb CHECK(media_urls IS NULL OR jsonb_typeof(media_urls)='array');
-- GET /api/v1/posts pages through an organization's posts by (updated_at,id).
CREATE INDEX posts_api_sync_idx ON posts(organization_id,updated_at,id) WHERE deleted_at IS NULL;

-- Stored responses for Idempotency-Key requests. The row is written in the
-- same transaction as the data it describes, and the unique index makes a
-- concurrent retry with the same key wait and then replay this response.
CREATE TABLE api_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys ON DELETE SET NULL,
  key text NOT NULL CHECK(key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer NOT NULL CHECK(response_status BETWEEN 200 AND 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_idempotency_keys_unique ON api_idempotency_keys(organization_id,key);
CREATE INDEX api_idempotency_keys_created_idx ON api_idempotency_keys(created_at);
