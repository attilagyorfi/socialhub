import { pool } from "../packages/db";
import { AppError } from "../packages/core/security";
import { runMetaStagingVerification } from "../packages/server/meta-staging";

try {
  const result = await runMetaStagingVerification();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const failure =
    error instanceof AppError
      ? { code: error.code, status: error.status }
      : { code: "META_STAGING_VERIFICATION_FAILED", status: 500 };
  console.error(JSON.stringify({ ok: false, phase: "live", ...failure }));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
