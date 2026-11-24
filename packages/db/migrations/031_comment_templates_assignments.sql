-- Named reply templates per client; inserted into a comment reply draft.
CREATE TABLE client_reply_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_reply_templates_name_unique
 ON client_reply_templates(organization_id,client_id,lower(name));

-- A comment thread (its top-level comment) has at most one assigned member.
-- Whether that member may still work on it is decided when it is read.
CREATE TABLE comment_assignments (
 comment_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 assigned_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id,comment_id)
  REFERENCES social_comments(organization_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX comment_assignments_user_idx ON comment_assignments(user_id);
CREATE INDEX comment_assignments_scope_idx
 ON comment_assignments(organization_id,client_id,user_id);
