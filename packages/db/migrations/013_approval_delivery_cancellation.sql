ALTER TABLE approval_automation_deliveries
 DROP CONSTRAINT approval_automation_deliveries_status_check;

ALTER TABLE approval_automation_deliveries
 ADD CONSTRAINT approval_automation_deliveries_status_check
 CHECK(status IN ('PENDING','SENDING','SENT','FAILED','CANCELLED'));
