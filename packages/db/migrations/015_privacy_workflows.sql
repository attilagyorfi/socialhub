ALTER TABLE member_invitations
 DROP CONSTRAINT member_invitations_invited_by_fkey;
ALTER TABLE member_invitations ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE member_invitations
 ADD CONSTRAINT member_invitations_invited_by_fkey
 FOREIGN KEY(invited_by) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE approval_comments
 ADD COLUMN author_user_id uuid REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX approval_comments_author_user_idx
 ON approval_comments(author_user_id,created_at DESC)
 WHERE author_user_id IS NOT NULL;

ALTER TABLE organizations ADD COLUMN retention_last_run_at timestamptz;

CREATE TABLE privacy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_type text NOT NULL CHECK(request_type IN ('USER_ERASURE','ORGANIZATION_ERASURE')),
 status text NOT NULL DEFAULT 'PENDING'
   CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
 organization_id uuid,
 subject_user_id uuid,
 requester_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
 subject_email_hash text CHECK(subject_email_hash IS NULL OR length(subject_email_hash)=64),
 execute_after timestamptz NOT NULL,
 run_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 error_code text,
 metadata jsonb NOT NULL DEFAULT '{}',
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(
   (request_type='USER_ERASURE' AND subject_user_id IS NOT NULL)
   OR
   (request_type='ORGANIZATION_ERASURE' AND organization_id IS NOT NULL)
 )
);

CREATE UNIQUE INDEX privacy_requests_active_user_idx
 ON privacy_requests(subject_user_id,request_type)
 WHERE request_type='USER_ERASURE' AND status IN ('PENDING','RUNNING','FAILED');
CREATE UNIQUE INDEX privacy_requests_active_org_idx
 ON privacy_requests(organization_id,request_type)
 WHERE request_type='ORGANIZATION_ERASURE' AND status IN ('PENDING','RUNNING','FAILED');
CREATE INDEX privacy_requests_due_idx
 ON privacy_requests(run_at,execute_after,created_at)
 WHERE status IN ('PENDING','FAILED');
