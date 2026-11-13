-- Monthly approval bundles: one secret link on which the client reviews every
-- post of a period at once. Like approval_requests, only the SHA-256 hash of
-- the link secret is stored. The bundle holds post IDs, not approval request
-- IDs: decisions always use the post's current pending client review, so a
-- renewed review link keeps working inside the bundle.
CREATE TABLE approval_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  client_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES "user" ON DELETE SET NULL,
  created_by uuid REFERENCES "user" ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_end > period_start),
  CHECK(period_end <= period_start + interval '62 days'),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  UNIQUE(organization_id,client_id,id),
  FOREIGN KEY(organization_id,client_id)
    REFERENCES clients(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX approval_bundles_scope_idx
  ON approval_bundles(organization_id,client_id,created_at DESC);

-- Items of a bundle. `position` is the item's number inside the bundle; the
-- public page refers to posts only by this number, never by their IDs.
CREATE TABLE approval_bundle_posts (
  organization_id uuid NOT NULL,
  client_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  post_id uuid NOT NULL,
  position integer NOT NULL CHECK(position BETWEEN 1 AND 200),
  PRIMARY KEY(bundle_id,post_id),
  UNIQUE(bundle_id,position),
  FOREIGN KEY(organization_id,client_id,bundle_id)
    REFERENCES approval_bundles(organization_id,client_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,client_id,post_id)
    REFERENCES posts(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX approval_bundle_posts_post_idx ON approval_bundle_posts(post_id);
