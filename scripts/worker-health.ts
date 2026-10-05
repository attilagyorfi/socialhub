import { pool } from "../packages/db";

try {
  const result = await pool.query(
    "SELECT 1 FROM service_heartbeats WHERE service_name='worker' AND last_seen_at>now()-interval '30 seconds' LIMIT 1",
  );
  if (!result.rowCount) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
