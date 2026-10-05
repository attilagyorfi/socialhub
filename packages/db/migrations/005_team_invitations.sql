CREATE TABLE member_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
 role member_role NOT NULL CHECK (role <> 'OWNER'),
 token_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
 invited_by uuid NOT NULL REFERENCES "user" ON DELETE RESTRICT,
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id)
);
CREATE UNIQUE INDEX member_invitations_pending_email_idx
 ON member_invitations(organization_id,lower(email)) WHERE status='PENDING';
CREATE INDEX member_invitations_expiry_idx
 ON member_invitations(expires_at) WHERE status='PENDING';

CREATE TABLE member_invitation_clients (
 organization_id uuid NOT NULL,
 invitation_id uuid NOT NULL,
 client_id uuid NOT NULL,
 PRIMARY KEY(invitation_id,client_id),
 FOREIGN KEY(organization_id,invitation_id)
  REFERENCES member_invitations(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,client_id)
  REFERENCES clients(organization_id,id) ON DELETE CASCADE
);
