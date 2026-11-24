import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { can } from "../core/domain";
import { AppError } from "../core/security";
import { pool } from "../db";
import { portalTableExists } from "./client-media-rule";
import type { Context } from "./context";
import {
  completeMediaUpload,
  derivedObjectKeys,
  mediaBucket,
  prepareMediaUpload,
  storageClient,
} from "./media";
import { audit, transaction } from "./transaction";
import type {
  clientMediaDecisionInput,
  clientMediaPrepareInput,
  clientMediaStatus,
} from "./validation";

// Undecided uploads a client can have waiting at the same time.
export const PENDING_UPLOAD_LIMIT = 50;
// Uploads one person can start in any 24 hours, across all their clients.
export const DAILY_UPLOAD_LIMIT = 100;
const PAGE_SIZE = 24;

type UploadStatus = z.infer<typeof clientMediaStatus>;

// Deliberately not part of the `permissions` matrix: uploading on the portal
// gives a reviewer none of the team's "create" actions.
function assertUploader(c: Context) {
  if (c.role !== "CLIENT_REVIEWER") throw forbidden();
}
function assertTeam(c: Context) {
  if (!can(c.role, "create")) throw forbidden();
}
const forbidden = () =>
  new AppError(403, "FORBIDDEN", "You do not have permission for this action.");
const notFound = () => new AppError(404, "NOT_FOUND", "Media not found.");

export async function assertPortalAvailable() {
  if (!(await portalTableExists(pool)))
    throw new AppError(
      503,
      "CLIENT_MEDIA_UNAVAILABLE",
      "Client uploads are not available yet. Try again later.",
    );
}

export async function prepareClientUpload(
  c: Context,
  input: Omit<z.infer<typeof clientMediaPrepareInput>, "clientId">,
) {
  assertUploader(c);
  await assertPortalAvailable();
  return prepareMediaUpload(c, input, {
    // Both locks are held until the new row is committed, so parallel requests
    // are counted one after the other. Always user first, then client.
    before: async (tx) => {
      for (const key of [`user:${c.userId}`, `client:${c.clientId}`])
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('client-media:'||$1,0))",
          [key],
        );
      const daily = await tx.query(
        "SELECT count(*)::int AS total FROM client_media_uploads WHERE uploaded_by=$1 AND created_at>now()-interval '24 hours'",
        [c.userId],
      );
      if (daily.rows[0].total >= DAILY_UPLOAD_LIMIT)
        throw new AppError(
          429,
          "CLIENT_MEDIA_DAILY_LIMIT",
          "You have reached today's upload limit. Try again tomorrow.",
        );
      const pending = await tx.query(
        `SELECT count(*)::int AS total FROM client_media_uploads u
         JOIN media_assets m ON m.id=u.media_asset_id
         WHERE u.organization_id=$1 AND u.client_id=$2 AND u.status='PENDING'
           AND m.deleted_at IS NULL
           AND m.status IN ('UPLOADING','PROCESSING','READY')`,
        [c.organizationId, c.clientId],
      );
      if (pending.rows[0].total >= PENDING_UPLOAD_LIMIT)
        throw new AppError(
          409,
          "CLIENT_MEDIA_PENDING_LIMIT",
          "Too many files are waiting for the team. Try again once they have reviewed some.",
        );
    },
    after: async (tx, id) => {
      await tx.query(
        "INSERT INTO client_media_uploads(media_asset_id,organization_id,client_id,uploaded_by,note) VALUES($1,$2,$3,$4,$5)",
        [id, c.organizationId, c.clientId, c.userId, input.note || null],
      );
    },
  });
}

export async function completeClientUpload(c: Context, id: string) {
  assertUploader(c);
  await assertPortalAvailable();
  const asset = await completeMediaUpload(c, id, true);
  return { id: asset.id as string, status: asset.status as string };
}

// Newest first; the cursor is the last ID of the previous page.
async function page(
  c: Context,
  columns: string,
  filter: string,
  value: string,
  before?: string,
) {
  const rows = (
    await pool.query(
      `SELECT m.id,m.name,m.mime_type,m.size_bytes,m.width,m.height,
              m.status AS asset_status,u.status,u.note,
              u.decision_reason AS reason,u.created_at${columns}
       FROM client_media_uploads u
       JOIN media_assets m ON m.organization_id=u.organization_id
         AND m.client_id=u.client_id AND m.id=u.media_asset_id
         AND m.deleted_at IS NULL
       LEFT JOIN "user" uploader ON uploader.id=u.uploaded_by
       WHERE u.organization_id=$1 AND u.client_id=$2 AND ${filter}
         AND ($4::uuid IS NULL OR (u.created_at,u.media_asset_id)<(
           SELECT p.created_at,p.media_asset_id FROM client_media_uploads p
           WHERE p.organization_id=$1 AND p.client_id=$2 AND p.media_asset_id=$4))
       ORDER BY u.created_at DESC,u.media_asset_id DESC LIMIT $5`,
      [c.organizationId, c.clientId, value, before ?? null, PAGE_SIZE + 1],
    )
  ).rows;
  const items = rows.slice(0, PAGE_SIZE);
  return {
    items,
    nextCursor:
      rows.length > PAGE_SIZE ? (items[items.length - 1].id as string) : null,
  };
}

// The reviewer's own uploads. No team member, storage key or e-mail address.
export async function listOwnUploads(c: Context, before?: string) {
  assertUploader(c);
  await assertPortalAvailable();
  return page(c, "", "u.uploaded_by=$3::uuid", c.userId, before);
}

// What the team sees: everything the client uploaded that can be decided, with
// the uploader's name (never the e-mail address).
export async function listClientUploads(
  c: Context,
  status: UploadStatus,
  before?: string,
) {
  assertTeam(c);
  await assertPortalAvailable();
  const [list, pending] = await Promise.all([
    page(
      c,
      ",uploader.name AS uploader_name",
      "u.status=$3 AND m.status IN ('PROCESSING','READY')",
      status,
      before,
    ),
    pool.query(
      `SELECT count(*)::int AS total FROM client_media_uploads u
       JOIN media_assets m ON m.id=u.media_asset_id
       WHERE u.organization_id=$1 AND u.client_id=$2 AND u.status='PENDING'
         AND m.deleted_at IS NULL AND m.status='READY'`,
      [c.organizationId, c.clientId],
    ),
  ]);
  return { ...list, pending: pending.rows[0].total as number };
}

// Locks an upload for a decision. Everyone locks in this order: the asset,
// then the portal row.
async function lockUpload(
  tx: PoolClient,
  scope: { organizationId: string; clientId: string },
  id: string,
) {
  const values = [scope.organizationId, scope.clientId, id];
  const asset = (
    await tx.query(
      "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE",
      values,
    )
  ).rows[0];
  const upload =
    asset &&
    (
      await tx.query(
        "SELECT * FROM client_media_uploads WHERE organization_id=$1 AND client_id=$2 AND media_asset_id=$3 FOR UPDATE",
        values,
      )
    ).rows[0];
  return upload ? { asset, upload } : undefined;
}

// Run only after lockUpload, as a statement of its own: it then sees every
// post that was saved while the locks were being waited for.
async function usedInPost(
  tx: PoolClient,
  scope: { organizationId: string; clientId: string },
  id: string,
) {
  return Boolean(
    (
      await tx.query(
        `SELECT 1 FROM post_targets t
         JOIN posts p ON p.id=t.post_id AND p.deleted_at IS NULL
         WHERE t.organization_id=$1 AND t.client_id=$2 AND $3=ANY(t.media_ids)
         LIMIT 1`,
        [scope.organizationId, scope.clientId, id],
      )
    ).rowCount,
  );
}
const inUse = () =>
  new AppError(409, "MEDIA_IN_USE", "This file is attached to a post.");

export async function decideClientUpload(
  c: Context,
  input: z.infer<typeof clientMediaDecisionInput>,
) {
  assertTeam(c);
  await assertPortalAvailable();
  const status = input.decision === "accept" ? "ACCEPTED" : "REJECTED";
  return transaction(async (tx) => {
    const locked = await lockUpload(tx, c, input.id);
    if (!locked) throw notFound();
    if (locked.asset.status !== "READY")
      throw new AppError(
        409,
        "CLIENT_MEDIA_NOT_READY",
        "This file is not ready to be reviewed.",
      );
    const previousStatus: UploadStatus = locked.upload.status;
    if (previousStatus !== input.expectedStatus || previousStatus === status)
      throw new AppError(
        409,
        "CLIENT_MEDIA_CONFLICT",
        "Someone else has already decided about this file.",
      );
    if (status === "REJECTED" && (await usedInPost(tx, c, input.id)))
      throw inUse();
    await tx.query(
      `UPDATE client_media_uploads
       SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4,
           updated_at=now() WHERE media_asset_id=$1`,
      [
        input.id,
        status,
        c.userId,
        status === "REJECTED" ? input.reason || null : null,
      ],
    );
    await audit(
      tx,
      c,
      status === "ACCEPTED" ? "client_media.accepted" : "client_media.rejected",
      input.id,
      { previousStatus },
    );
    return { id: input.id, status };
  });
}

// Removes the files like deleteMedia. The row stays (without the note) so that
// a withdrawn upload still counts towards the daily limit.
export async function withdrawClientUpload(c: Context, id: string) {
  assertUploader(c);
  await assertPortalAvailable();
  return transaction(async (tx) => {
    const locked = await lockUpload(tx, c, id);
    if (!locked || locked.upload.uploaded_by !== c.userId) throw notFound();
    const { asset, upload } = locked;
    if (upload.status !== "PENDING")
      throw new AppError(
        409,
        "CLIENT_MEDIA_DECIDED",
        "The team has already decided about this file.",
      );
    // The worker may still be writing its files; they would be left behind.
    if (!["READY", "FAILED"].includes(asset.status))
      throw new AppError(
        409,
        "CLIENT_MEDIA_BUSY",
        "This file is still being uploaded or processed. An unfinished upload expires by itself.",
      );
    if (await usedInPost(tx, c, id)) throw inUse();
    await Promise.all(
      Array.from(
        new Set<string>(
          [
            asset.object_key,
            asset.preview_object_key,
            ...derivedObjectKeys(asset),
            // The signed upload URL may have been used again meanwhile.
            `${c.organizationId}/${c.clientId}/incoming/${id}`,
          ].filter(Boolean),
        ),
      ).map((Key) =>
        storageClient().send(
          new DeleteObjectCommand({ Bucket: mediaBucket(), Key }),
        ),
      ),
    );
    await markDeleted(tx, id);
    await audit(tx, c, "client_media.withdrawn", id);
    return { id };
  });
}

async function markDeleted(tx: PoolClient, id: string) {
  await tx.query(
    "UPDATE media_assets SET status='FAILED',deleted_at=now(),updated_at=now() WHERE id=$1",
    [id],
  );
  await tx.query(
    "UPDATE client_media_uploads SET note=NULL,updated_at=now() WHERE media_asset_id=$1",
    [id],
  );
}

// Privacy hooks. Before migration 032 there is nothing to export or erase.

export async function exportUploads(userId: string) {
  if (!(await portalTableExists(pool))) return [];
  return (
    await pool.query(
      `SELECT u.media_asset_id AS id,u.organization_id,u.client_id,m.name,
              m.mime_type,m.size_bytes,u.note,u.status,
              u.decision_reason,u.created_at,m.deleted_at
       FROM client_media_uploads u
       JOIN media_assets m ON m.id=u.media_asset_id
       WHERE u.uploaded_by=$1 ORDER BY u.created_at,u.media_asset_id`,
      [userId],
    )
  ).rows;
}

export async function eraseUploaderData(tx: PoolClient, userId: string) {
  if (!(await portalTableExists(tx))) return;
  // The same row order as everywhere else, so nothing deadlocks on it.
  await tx.query(
    `SELECT media_asset_id FROM client_media_uploads
     WHERE uploaded_by=$1 OR decided_by=$1 ORDER BY media_asset_id FOR UPDATE`,
    [userId],
  );
  await tx.query(
    "UPDATE client_media_uploads SET note=NULL,uploaded_by=NULL,updated_at=now() WHERE uploaded_by=$1",
    [userId],
  );
  await tx.query(
    "UPDATE client_media_uploads SET decided_by=NULL,updated_at=now() WHERE decided_by=$1",
    [userId],
  );
}

// Soft-deletes long rejected, unused uploads. Each one is checked again under
// its locks, so it cannot collide with a late acceptance. The regular
// retention of deleted media removes the files afterwards.
export async function expireRejectedUploads(
  organizationId: string,
  retentionDays: number,
) {
  if (!(await portalTableExists(pool))) return 0;
  const due =
    "status='REJECTED' AND decided_at<now()-make_interval(days => $2)";
  const candidates = (
    await pool.query(
      `SELECT media_asset_id,client_id FROM client_media_uploads
       WHERE organization_id=$1 AND ${due} ORDER BY media_asset_id`,
      [organizationId, retentionDays],
    )
  ).rows;
  let expired = 0;
  for (const { media_asset_id: id, client_id: clientId } of candidates)
    await transaction(async (tx) => {
      const scope = { organizationId, clientId };
      if (!(await lockUpload(tx, scope, id))) return;
      const still = await tx.query(
        `SELECT 1 FROM client_media_uploads WHERE media_asset_id=$1 AND ${due}`,
        [id, retentionDays],
      );
      if (!still.rowCount || (await usedInPost(tx, scope, id))) return;
      await markDeleted(tx, id);
      await audit(tx, { ...scope, userId: null }, "client_media.expired", id);
      expired++;
    });
  return expired;
}
