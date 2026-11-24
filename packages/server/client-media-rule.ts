import type { PoolClient } from "pg";
import { can } from "../core/domain";
import type { Context } from "./context";

type Db = { query: PoolClient["query"] };
type Scope = { organizationId: string; clientId: string };

// A table never disappears again, so only a positive answer is remembered.
let tableSeen = false;

// False only while migration 032 has not run yet. Without the table no portal
// upload can exist, so everything else keeps working as before. Checked before
// the real query: a missing table would otherwise abort the transaction. Any
// other failure is thrown, so nothing is ever used unchecked.
export async function portalTableExists(db: Db) {
  if (tableSeen) return true;
  const row = (
    await db.query(
      "SELECT to_regclass('client_media_uploads') IS NOT NULL AS ready",
    )
  ).rows[0];
  if (row?.ready === false) return false;
  if (row?.ready === true) tableSeen = true;
  return true;
}

// The one rule: media uploaded on the client portal can be used only once the
// team has accepted it. Media without a portal row is unaffected. `asset` is
// the alias of media_assets in the query the condition is added to.
const usable = (
  asset: string,
) => `NOT EXISTS(SELECT 1 FROM client_media_uploads cu
  WHERE cu.media_asset_id=${asset}.id AND cu.status<>'ACCEPTED')`;

export async function usableMedia(db: Db, asset: string) {
  return (await portalTableExists(db)) ? usable(asset) : "TRUE";
}

// Who may open a file through a signed URL: usable media is open to the whole
// client; the rest only to the team and to the reviewer who uploaded it.
// `userId` is the placeholder of the caller's ID.
export async function viewableMedia(
  db: Db,
  c: Context,
  asset: string,
  userId: string,
): Promise<{ condition: string; values: string[] }> {
  if (!(await portalTableExists(db)) || can(c.role, "create"))
    return { condition: "TRUE", values: [] };
  if (c.role !== "CLIENT_REVIEWER")
    return { condition: usable(asset), values: [] };
  return {
    condition: `(${usable(asset)} OR EXISTS(SELECT 1 FROM client_media_uploads cu
      WHERE cu.media_asset_id=${asset}.id AND cu.uploaded_by::text=${userId}::text))`,
    values: [c.userId],
  };
}

// Audit rows about portal uploads are for the team; a reviewer also sees those
// of their own uploads, VIEWER none. `log` is the alias of audit_logs.
export async function visibleAudit(
  db: Db,
  c: Context,
  log: string,
  userId: string,
): Promise<{ condition: string; values: string[] }> {
  if (!(await portalTableExists(db)) || can(c.role, "create"))
    return { condition: "TRUE", values: [] };
  const own = c.role === "CLIENT_REVIEWER";
  return {
    condition: `NOT EXISTS(SELECT 1 FROM client_media_uploads cu
      WHERE cu.organization_id=${log}.organization_id
        AND cu.client_id=${log}.client_id
        AND cu.media_asset_id::text=${log}.resource_id::text
        ${own ? `AND cu.uploaded_by::text IS DISTINCT FROM ${userId}::text` : ""})`,
    values: own ? [c.userId] : [],
  };
}

// Called before media is attached to a post or a post is scheduled: holds the
// portal rows (nothing else) so that a rejection running at the same time
// either comes first and is seen by the rule, or waits and sees the post.
export async function lockPortalMedia(
  tx: PoolClient,
  scope: Scope,
  mediaIds: string[],
) {
  if (!mediaIds.length || !(await portalTableExists(tx))) return;
  await tx.query(
    `SELECT media_asset_id FROM client_media_uploads
     WHERE organization_id=$1 AND client_id=$2 AND media_asset_id=ANY($3::uuid[])
     ORDER BY media_asset_id FOR SHARE`,
    [scope.organizationId, scope.clientId, mediaIds],
  );
}
