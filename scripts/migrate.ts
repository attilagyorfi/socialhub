import { readFile } from "node:fs/promises";
import { pool } from "../packages/db";
const conn = await pool.connect();
try {
  await conn.query("BEGIN");
  await conn.query("SELECT pg_advisory_xact_lock(742019)");
  await conn.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of [
    "001_initial.sql",
    "002_auth_uuid_defaults.sql",
    "003_media_integrity.sql",
    "004_approval_steps.sql",
    "005_team_invitations.sql",
    "006_media_processing.sql",
    "007_meta_integration.sql",
    "008_operational_health.sql",
    "009_approval_assignment.sql",
    "010_analytics_queries.sql",
    "011_ai_governance.sql",
    "012_approval_automation.sql",
    "013_approval_delivery_cancellation.sql",
    "014_user_timezones.sql",
    "015_privacy_workflows.sql",
    "016_analytics_sync_jobs.sql",
    "017_social_account_cascade.sql",
    "018_publish_reconciliation.sql",
    "019_locales.sql",
    "020_meta_compliance.sql",
  ]) {
    const exists = await conn.query(
      "SELECT 1 FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (!exists.rowCount) {
      await conn.query(
        await readFile(
          new URL(`../packages/db/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
      await conn.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name,
      ]);
      console.log(`Applied ${name}`);
    }
  }
  await conn.query("COMMIT");
} catch (e) {
  await conn.query("ROLLBACK");
  throw e;
} finally {
  conn.release();
  await pool.end();
}
