ALTER TABLE approval_requests
 ADD COLUMN assigned_to uuid REFERENCES "user"(id) ON DELETE SET NULL,
 ADD COLUMN reminder_sent_at timestamptz,
 ADD COLUMN reminder_count integer NOT NULL DEFAULT 0 CHECK(reminder_count >= 0);

UPDATE approval_requests ar
SET assigned_to=(
 SELECT om.user_id FROM organization_members om
 WHERE om.organization_id=ar.organization_id
   AND om.role IN ('OWNER','ADMIN')
 ORDER BY CASE om.role WHEN 'OWNER' THEN 0 ELSE 1 END,om.created_at
 LIMIT 1
)
WHERE ar.step_kind='INTERNAL' AND ar.assigned_to IS NULL;

CREATE INDEX approval_requests_assignee_pending_idx
 ON approval_requests(organization_id,client_id,assigned_to,expires_at)
 WHERE status='PENDING' AND assigned_to IS NOT NULL;

CREATE OR REPLACE FUNCTION check_approval_assignee_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM organization_members om
   WHERE om.organization_id=NEW.organization_id
     AND om.user_id=NEW.assigned_to
     AND (
       om.role IN ('OWNER','ADMIN')
       OR EXISTS (
         SELECT 1 FROM client_members cm
         WHERE cm.organization_id=NEW.organization_id
           AND cm.client_id=NEW.client_id
           AND cm.user_id=NEW.assigned_to
           AND cm.role IN ('SOCIAL_MANAGER','CLIENT_REVIEWER')
       )
     )
 ) THEN
   RAISE EXCEPTION 'approval assignee must be an eligible reviewer in the same client';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER approval_assignee_scope
 BEFORE INSERT OR UPDATE OF assigned_to,organization_id,client_id
 ON approval_requests
 FOR EACH ROW EXECUTE FUNCTION check_approval_assignee_scope();
