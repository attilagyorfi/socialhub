ALTER TABLE approval_workflows
 ADD COLUMN automatic_reminders boolean NOT NULL DEFAULT false,
 ADD COLUMN first_reminder_hours integer NOT NULL DEFAULT 24 CHECK(first_reminder_hours BETWEEN 1 AND 168),
 ADD COLUMN repeat_reminder_hours integer NOT NULL DEFAULT 24 CHECK(repeat_reminder_hours BETWEEN 1 AND 168),
 ADD COLUMN escalate_after_hours integer NOT NULL DEFAULT 72 CHECK(escalate_after_hours BETWEEN 1 AND 168),
 ADD COLUMN max_automatic_reminders integer NOT NULL DEFAULT 2 CHECK(max_automatic_reminders BETWEEN 0 AND 10);

ALTER TABLE approval_requests
 ADD COLUMN automatic_reminders boolean NOT NULL DEFAULT false,
 ADD COLUMN first_reminder_hours integer NOT NULL DEFAULT 24 CHECK(first_reminder_hours BETWEEN 1 AND 168),
 ADD COLUMN repeat_reminder_hours integer NOT NULL DEFAULT 24 CHECK(repeat_reminder_hours BETWEEN 1 AND 168),
 ADD COLUMN escalate_after_hours integer NOT NULL DEFAULT 72 CHECK(escalate_after_hours BETWEEN 1 AND 168),
 ADD COLUMN max_automatic_reminders integer NOT NULL DEFAULT 2 CHECK(max_automatic_reminders BETWEEN 0 AND 10),
 ADD COLUMN automatic_reminder_count integer NOT NULL DEFAULT 0 CHECK(automatic_reminder_count >= 0),
 ADD COLUMN next_reminder_at timestamptz,
 ADD COLUMN escalation_at timestamptz,
 ADD COLUMN escalated_at timestamptz;

CREATE INDEX approval_requests_automation_due_idx
 ON approval_requests(next_reminder_at,escalation_at)
 WHERE status='PENDING' AND automatic_reminders;

CREATE TABLE approval_automation_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 client_id uuid NOT NULL,
 approval_request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('REMINDER','ESCALATION')),
 sequence integer NOT NULL CHECK(sequence > 0),
 recipient_user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
 recipient_email text NOT NULL CHECK(length(recipient_email) BETWEEN 3 AND 320),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 run_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(approval_request_id,kind,sequence,recipient_email),
 UNIQUE(organization_id,client_id,id),
 FOREIGN KEY(organization_id,client_id,approval_request_id)
   REFERENCES approval_requests(organization_id,client_id,id) ON DELETE CASCADE
);

CREATE INDEX approval_automation_deliveries_due_idx
 ON approval_automation_deliveries(run_at,created_at)
 WHERE status IN ('PENDING','FAILED');
