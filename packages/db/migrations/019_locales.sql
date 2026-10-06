-- Interface language per user (NULL follows the browser's locale cookie,
-- Hungarian by default), and the language of each client's external
-- approval page and client-facing email.
ALTER TABLE "user"
 ADD COLUMN locale text
 CHECK(locale IS NULL OR locale IN ('hu','en'));
ALTER TABLE clients
 ADD COLUMN locale text NOT NULL DEFAULT 'hu'
 CHECK(locale IN ('hu','en'));
