CREATE FUNCTION check_target_media_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF cardinality(NEW.media_ids) <> (SELECT count(DISTINCT a.id) FROM media_assets a WHERE a.organization_id=NEW.organization_id AND a.client_id=NEW.client_id AND a.id=ANY(NEW.media_ids) AND a.deleted_at IS NULL AND a.status='READY') THEN
  RAISE EXCEPTION 'Target media must be ready and belong to the same client' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER post_target_media_scope BEFORE INSERT OR UPDATE OF media_ids,organization_id,client_id ON post_targets FOR EACH ROW EXECUTE FUNCTION check_target_media_scope();

ALTER TABLE mock_receipts ADD COLUMN organization_id uuid, ADD COLUMN client_id uuid;
UPDATE mock_receipts r SET organization_id=j.organization_id,client_id=j.client_id FROM publish_jobs j WHERE j.idempotency_key=r.idempotency_key;
ALTER TABLE mock_receipts ALTER COLUMN organization_id SET NOT NULL, ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE mock_receipts ADD FOREIGN KEY(organization_id,client_id) REFERENCES clients(organization_id,id) ON DELETE CASCADE;
