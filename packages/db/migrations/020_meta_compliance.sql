-- Meta's deauthorize and data-deletion callbacks identify people by their
-- app-scoped user id, which is otherwise only inside encrypted credentials.
ALTER TABLE social_credentials ADD COLUMN grant_hash text;
CREATE INDEX social_credentials_grant_hash
  ON social_credentials(grant_hash) WHERE grant_hash IS NOT NULL;

CREATE TABLE meta_data_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_code text NOT NULL UNIQUE,
  user_hash text NOT NULL,
  status text NOT NULL DEFAULT 'COMPLETED' CHECK(status IN ('COMPLETED')),
  accounts_disconnected integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
