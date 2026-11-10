-- Optional identifier another system (e.g. Growth Engine) uses for a client,
-- such as `mmi` or `viba-team`. Returned by GET /api/v1/clients; unique within
-- an organization, so the same value may exist in another organization.
ALTER TABLE clients
  ADD COLUMN external_ref text CHECK(external_ref ~ '^[a-z0-9-]{1,64}$');
CREATE UNIQUE INDEX clients_external_ref_unique
  ON clients(organization_id,external_ref) WHERE external_ref IS NOT NULL;
