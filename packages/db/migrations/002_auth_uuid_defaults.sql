ALTER TABLE "user" ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE session ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE account ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE verification ALTER COLUMN id SET DEFAULT gen_random_uuid();
