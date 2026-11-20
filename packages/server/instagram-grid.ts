import type { PoolClient } from "pg";
import { pool } from "../db";
import {
  buildInstagramGrid,
  type GridMedia,
  type GridSourceRow,
} from "../core/instagram-grid";
import type { Context } from "./context";

type Db = Pick<PoolClient, "query">;
type Scope = { organizationId: string; clientId: string };

export const gridPublishedLimit = 30;
export const gridPlannedLimit = 60;

const targetColumns = `t.post_id AS "postId",t.id AS "targetId",a.platform,
  p.status AS "postStatus",t.status AS "targetStatus",
  p.scheduled_at AS "scheduledAt",t.published_at AS "publishedAt",
  t.caption,t.media_ids AS "mediaIds"`;
const targetJoins = `FROM post_targets t
  JOIN social_accounts a ON a.id=t.social_account_id
    AND a.organization_id=t.organization_id AND a.client_id=t.client_id
    AND a.platform='instagram' AND a.deleted_at IS NULL
  JOIN posts p ON p.id=t.post_id AND p.organization_id=t.organization_id
    AND p.client_id=t.client_id AND p.deleted_at IS NULL`;

export async function hasInstagram(db: Db, scope: Scope) {
  return (
    (
      await db.query(
        `SELECT 1 FROM social_accounts WHERE organization_id=$1 AND client_id=$2
         AND platform='instagram' AND deleted_at IS NULL LIMIT 1`,
        [scope.organizationId, scope.clientId],
      )
    ).rows.length > 0
  );
}

// The newest published Instagram targets of a client.
export async function publishedGridRows(db: Db, scope: Scope, limit: number) {
  return (
    await db.query(
      `SELECT ${targetColumns} ${targetJoins}
       WHERE t.organization_id=$1 AND t.client_id=$2 AND t.status='PUBLISHED'
       ORDER BY coalesce(t.published_at,p.scheduled_at) DESC,t.id LIMIT $3`,
      [scope.organizationId, scope.clientId, limit],
    )
  ).rows as GridSourceRow[];
}

// Instagram targets still on their way to the profile, soonest first.
// Stale ones scheduled more than 30 days ago are left out.
async function plannedGridRows(db: Db, scope: Scope, limit: number) {
  return (
    await db.query(
      `SELECT ${targetColumns} ${targetJoins}
       WHERE t.organization_id=$1 AND t.client_id=$2
         AND t.status NOT IN ('PUBLISHED','FAILED','CANCELLED')
         AND p.status IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','QUEUED','PUBLISHING')
         AND p.scheduled_at>=now()-interval '30 days'
       ORDER BY p.scheduled_at,t.id LIMIT $3`,
      [scope.organizationId, scope.clientId, limit],
    )
  ).rows as GridSourceRow[];
}

// Instagram targets of the given posts, whatever their state.
export async function postGridRows(db: Db, scope: Scope, postIds: string[]) {
  return (
    await db.query(
      `SELECT ${targetColumns} ${targetJoins}
       WHERE t.organization_id=$1 AND t.client_id=$2 AND t.post_id=ANY($3::uuid[])`,
      [scope.organizationId, scope.clientId, postIds],
    )
  ).rows as GridSourceRow[];
}

export type GridAsset = GridMedia & {
  name: string;
  objectKey: string;
  previewKey: string | null;
};

// The first attachment of every row; only it can become a cover.
export async function gridMedia(db: Db, scope: Scope, rows: GridSourceRow[]) {
  const ids = [...new Set(rows.flatMap((row) => row.mediaIds.slice(0, 1)))];
  const assets = ids.length
    ? (
        await db.query(
          `SELECT id,name,mime_type,status,object_key,preview_object_key
           FROM media_assets
           WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])
             AND deleted_at IS NULL`,
          [scope.organizationId, scope.clientId, ids],
        )
      ).rows
    : [];
  return new Map<string, GridAsset>(
    assets.map((asset) => [
      asset.id,
      {
        id: asset.id,
        name: asset.name,
        mimeType: asset.mime_type,
        ready: asset.status === "READY",
        hasPreview: Boolean(asset.preview_object_key),
        objectKey: asset.object_key,
        previewKey: asset.preview_object_key,
      },
    ]),
  );
}

// The agency's view next to the calendar. Covers are media asset references;
// the browser loads them through the app's own signed media URLs.
export async function instagramGrid(c: Context) {
  const scope = { organizationId: c.organizationId, clientId: c.clientId };
  if (!(await hasInstagram(pool, scope)))
    return { hasInstagram: false, items: [] };
  const rows = [
    ...(await publishedGridRows(pool, scope, gridPublishedLimit)),
    ...(await plannedGridRows(pool, scope, gridPlannedLimit)),
  ];
  const media = await gridMedia(pool, scope, rows);
  return {
    hasInstagram: true,
    items: buildInstagramGrid(rows, media).map((item) => {
      const asset = item.cover ? media.get(item.cover.id) : undefined;
      return {
        postId: item.postId,
        state: item.state,
        at: item.at,
        caption: item.caption.slice(0, 300),
        postStatus: item.postStatus,
        mediaCount: item.mediaCount,
        cover: asset
          ? { id: asset.id, name: asset.name, mime_type: asset.mimeType }
          : null,
      };
    }),
  };
}
