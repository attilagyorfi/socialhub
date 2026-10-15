-- Public requests for access. Sign-up is invitation-only in production, so a
-- visitor asks first and a platform operator approves the request by sending
-- an ordinary team invitation. Requests exist before any organization.
CREATE TABLE access_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
 company text CHECK (company IS NULL OR length(company) <= 160),
 message text CHECK (message IS NULL OR length(message) <= 1000),
 locale text CHECK (locale IS NULL OR locale IN ('hu','en')),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
 handled_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
 handled_at timestamptz,
 organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
 invitation_id uuid REFERENCES member_invitations(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_requests_pending_email_idx
 ON access_requests(lower(email)) WHERE status='PENDING';
CREATE INDEX access_requests_handled_idx
 ON access_requests(updated_at) WHERE status<>'PENDING';
