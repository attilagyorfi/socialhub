-- Brand profile synced from the Growth Engine through
-- PUT /api/v1/clients/{id}/brand-profile. The Growth Engine owns these
-- columns; `profile` stays the local supplement edited in Social Hub and the
-- API never writes it. synced_hash is the SHA-256 of the normalized profile,
-- so a repeated identical PUT changes nothing.
ALTER TABLE brand_profiles
  ADD COLUMN IF NOT EXISTS synced_profile jsonb,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS synced_source text,
  ADD COLUMN IF NOT EXISTS synced_by_api_key_id uuid REFERENCES api_keys ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS synced_hash text;
