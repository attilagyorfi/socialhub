ALTER TABLE approval_workflows ADD COLUMN is_default boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX approval_workflow_default_idx ON approval_workflows(organization_id,client_id) WHERE is_default;
ALTER TABLE approval_requests ADD COLUMN step_kind text NOT NULL DEFAULT 'EXTERNAL' CHECK(step_kind IN ('INTERNAL','EXTERNAL'));
ALTER TABLE approval_requests ADD COLUMN remaining_steps jsonb NOT NULL DEFAULT '[]';
