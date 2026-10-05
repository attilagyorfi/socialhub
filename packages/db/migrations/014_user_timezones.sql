ALTER TABLE "user"
 ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Budapest'
 CHECK(length(timezone) BETWEEN 1 AND 100);
