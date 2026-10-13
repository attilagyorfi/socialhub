-- Comments on connected Facebook Pages and Instagram accounts, collected by
-- polling published posts and from Meta webhooks, for the shared inbox.
CREATE TABLE social_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  client_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  platform text NOT NULL CHECK(platform IN ('facebook','instagram')),
  remote_id text NOT NULL,
  parent_remote_id text,
  object_remote_id text NOT NULL,
  post_target_id uuid REFERENCES post_targets(id) ON DELETE SET NULL,
  author_name text,
  author_remote_id text,
  message text NOT NULL DEFAULT '',
  from_page boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  like_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DONE')),
  replied_at timestamptz,
  replied_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
  remote_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(social_account_id,remote_id),
  UNIQUE(organization_id,client_id,id),
  FOREIGN KEY(organization_id,client_id,social_account_id)
    REFERENCES social_accounts(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX social_comments_inbox_idx
  ON social_comments(organization_id,client_id,status,remote_created_at DESC)
  WHERE parent_remote_id IS NULL AND NOT deleted;
CREATE INDEX social_comments_thread_idx
  ON social_comments(social_account_id,parent_remote_id);

ALTER TABLE social_accounts
  ADD COLUMN comments_synced_at timestamptz,
  ADD COLUMN webhooks_subscribed_at timestamptz;
