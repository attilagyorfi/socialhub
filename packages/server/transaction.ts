import { pool } from "../db";
import type { PoolClient } from "pg";
import type { Context } from "./context";
export async function transaction<T>(
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function audit(
  tx: PoolClient,
  c: Context,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.query(
    "INSERT INTO audit_logs(organization_id,client_id,actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [
      c.organizationId,
      c.clientId,
      c.userId,
      action,
      resourceId,
      JSON.stringify(metadata),
    ],
  );
}
