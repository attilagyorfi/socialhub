import type { PoolClient } from "pg";
import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import { AppError, hashToken, token } from "../core/security";
import { pool } from "../db";
import { applyApprovalDecision } from "./approvals";

// Monthly approval bundles: the agency collects the posts of one client and
// period that wait for client review, and the client decides on all of them
// on one secret link. Decisions go through applyApprovalDecision, the same
// code as the per-post link, so post states, comments, audit logs and
// webhooks stay identical. Only posts whose current revision has a pending,
// unexpired client (EXTERNAL) review are added, so a bundle can never skip
// the internal review step.

export const maxBundlePeriodDays = 62;
export const maxBundleItems = 200;
export const maxBundleExpiryDays = 30;
const dayMs = 24 * 60 * 60 * 1000;

export type BundleItemState =
  | "PENDING"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "UNAVAILABLE";
export type SkipReason =
  | "DRAFT"
  | "INTERNAL_REVIEW"
  | "EXPIRED_REVIEW"
  | "NOT_PENDING";
export type BundleDecision =
  | { action: "approve_all" }
  | { action: "approve" | "changes"; item: number; comment: string };

// Unknown, expired and revoked links all get the same answer.
const invalidLink = () =>
  new AppError(404, "EXPIRED", "This approval link is invalid or expired.");
const decided = () =>
  new AppError(
    409,
    "STALE_APPROVAL",
    "This request has already been decided or the post has changed.",
  );

function requireBundleManager(c: Context) {
  if (!["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(c.role))
    throw new AppError(
      403,
      "FORBIDDEN",
      "A social manager or administrator must manage approval links.",
    );
}

function bundleUrl(secret: string) {
  return `${process.env.APP_URL}/approve/bundle/${secret}`;
}

export async function createApprovalBundle(
  c: Context,
  input: { periodStart: string; periodEnd: string; expiresInDays?: number },
) {
  requireBundleManager(c);
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start ||
    end.getTime() - start.getTime() > maxBundlePeriodDays * dayMs
  )
    throw new AppError(
      422,
      "INVALID_PERIOD",
      `Choose a period of at most ${maxBundlePeriodDays} days that ends after it starts.`,
    );
  const expiresInDays = input.expiresInDays ?? 14;
  if (
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > maxBundleExpiryDays
  )
    throw new AppError(
      422,
      "INVALID_EXPIRY",
      `The link can be valid for 1 to ${maxBundleExpiryDays} days.`,
    );
  return transaction(async (tx) => {
    const posts = (
      await tx.query(
        `SELECT p.id,p.status,
           EXISTS(SELECT 1 FROM approval_requests ar
             WHERE ar.post_id=p.id AND ar.organization_id=p.organization_id
               AND ar.client_id=p.client_id AND ar.revision=p.revision
               AND ar.step_kind='EXTERNAL' AND ar.status='PENDING'
               AND ar.expires_at>now()) AS client_review,
           EXISTS(SELECT 1 FROM approval_requests ar
             WHERE ar.post_id=p.id AND ar.revision=p.revision
               AND ar.step_kind='INTERNAL' AND ar.status='PENDING'
               AND ar.expires_at>now()) AS internal_review
         FROM posts p
         WHERE p.organization_id=$1 AND p.client_id=$2 AND p.deleted_at IS NULL
           AND p.scheduled_at>=$3 AND p.scheduled_at<$4
         ORDER BY p.scheduled_at,p.id`,
        [c.organizationId, c.clientId, start, end],
      )
    ).rows;
    const included: string[] = [];
    const skippedReasons: Record<SkipReason, number> = {
      DRAFT: 0,
      INTERNAL_REVIEW: 0,
      EXPIRED_REVIEW: 0,
      NOT_PENDING: 0,
    };
    for (const post of posts) {
      if (post.status === "PENDING_APPROVAL" && post.client_review)
        included.push(post.id);
      else
        skippedReasons[
          post.status === "DRAFT"
            ? "DRAFT"
            : post.status !== "PENDING_APPROVAL"
              ? "NOT_PENDING"
              : post.internal_review
                ? "INTERNAL_REVIEW"
                : "EXPIRED_REVIEW"
        ]++;
    }
    if (!included.length)
      throw new AppError(
        422,
        "BUNDLE_EMPTY",
        "No post in this period is waiting for client approval.",
      );
    if (included.length > maxBundleItems)
      throw new AppError(
        422,
        "BUNDLE_TOO_LARGE",
        `An approval link can hold at most ${maxBundleItems} posts. Choose a shorter period.`,
      );
    const secret = token();
    const bundle = (
      await tx.query(
        `INSERT INTO approval_bundles(
           organization_id,client_id,period_start,period_end,token_hash,
           expires_at,created_by
         ) VALUES($1,$2,$3,$4,$5,now()+make_interval(days => $6),$7)
         RETURNING id,expires_at`,
        [
          c.organizationId,
          c.clientId,
          start,
          end,
          hashToken(secret),
          expiresInDays,
          c.userId,
        ],
      )
    ).rows[0];
    await tx.query(
      `INSERT INTO approval_bundle_posts(
         organization_id,client_id,bundle_id,post_id,position
       )
       SELECT $1,$2,$3,item.post_id,item.position::integer
       FROM unnest($4::uuid[]) WITH ORDINALITY AS item(post_id,position)`,
      [c.organizationId, c.clientId, bundle.id, included],
    );
    const skipped = posts.length - included.length;
    await audit(tx, c, "approval_bundle.created", bundle.id, {
      items: included.length,
      skipped,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    });
    return {
      id: bundle.id as string,
      url: bundleUrl(secret),
      expiresAt: bundle.expires_at as Date,
      items: included.length,
      skipped,
      skippedReasons,
    };
  });
}

type ItemRow = {
  bundle_id: string;
  post_id: string;
  position: number;
  scheduled_at: Date | null;
  caption: string;
  link: string | null;
  deleted: boolean;
  post_status: string;
  post_revision: number;
  request_id: string | null;
  step_kind: string | null;
  request_status: string | null;
  request_revision: number | null;
  request_live: boolean | null;
};

// Every item with the latest review of its post, in calendar order. The
// item's state is derived from that review, so a decision made on the
// per-post link shows up here as well.
async function itemRows(db: Pick<PoolClient, "query">, bundleIds: string[]) {
  return (
    await db.query(
      `SELECT bp.bundle_id,bp.post_id,bp.position,p.scheduled_at,p.caption,
              p.link,p.deleted_at IS NOT NULL AS deleted,
              p.status AS post_status,p.revision AS post_revision,
              ar.id AS request_id,ar.step_kind,ar.status AS request_status,
              ar.revision AS request_revision,ar.expires_at>now() AS request_live
       FROM approval_bundle_posts bp
       JOIN posts p ON p.id=bp.post_id AND p.organization_id=bp.organization_id
         AND p.client_id=bp.client_id
       LEFT JOIN LATERAL (
         SELECT r.* FROM approval_requests r
         WHERE r.post_id=bp.post_id
         ORDER BY r.created_at DESC,r.id DESC LIMIT 1
       ) ar ON true
       WHERE bp.bundle_id=ANY($1::uuid[])
       ORDER BY p.scheduled_at NULLS LAST,bp.position`,
      [bundleIds],
    )
  ).rows as ItemRow[];
}

export function itemState(row: ItemRow): BundleItemState {
  if (row.deleted || !row.request_id || row.step_kind !== "EXTERNAL")
    return "UNAVAILABLE";
  if (row.request_status === "APPROVED") return "APPROVED";
  if (row.request_status === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  return row.request_status === "PENDING" &&
    row.request_live &&
    row.post_status === "PENDING_APPROVAL" &&
    row.request_revision === row.post_revision
    ? "PENDING"
    : "UNAVAILABLE";
}

function summarize(rows: ItemRow[]) {
  const summary = {
    total: rows.length,
    approved: 0,
    changesRequested: 0,
    pending: 0,
    unavailable: 0,
  };
  for (const row of rows) {
    const state = itemState(row);
    if (state === "APPROVED") summary.approved++;
    else if (state === "CHANGES_REQUESTED") summary.changesRequested++;
    else if (state === "PENDING") summary.pending++;
    else summary.unavailable++;
  }
  return summary;
}

// Bundles of one client for the agency. The link secret is never stored, so
// it cannot be listed again; only creation returns it.
export async function listApprovalBundles(c: Context, id?: string) {
  requireBundleManager(c);
  const bundles = (
    await pool.query(
      `SELECT b.id,b.period_start,b.period_end,b.expires_at,b.revoked_at,
              b.created_at,u.name AS created_by_name,
              b.expires_at>now() AS live
       FROM approval_bundles b
       LEFT JOIN "user" u ON u.id=b.created_by
       WHERE b.organization_id=$1 AND b.client_id=$2
         AND ($3::uuid IS NULL OR b.id=$3)
       ORDER BY b.created_at DESC,b.id DESC LIMIT 50`,
      [c.organizationId, c.clientId, id ?? null],
    )
  ).rows;
  const rows = bundles.length
    ? await itemRows(
        pool,
        bundles.map((bundle) => bundle.id),
      )
    : [];
  return bundles.map(({ live, ...bundle }) => ({
    ...bundle,
    state: bundle.revoked_at ? "REVOKED" : live ? "ACTIVE" : "EXPIRED",
    summary: summarize(rows.filter((row) => row.bundle_id === bundle.id)),
  }));
}

export async function bundleStatus(c: Context, id: string) {
  const [bundle] = await listApprovalBundles(c, id);
  if (!bundle) throw new AppError(404, "NOT_FOUND", "Approval link not found.");
  return bundle;
}

export async function revokeApprovalBundle(c: Context, id: string) {
  requireBundleManager(c);
  return transaction(async (tx) => {
    const bundle = (
      await tx.query(
        `SELECT id,revoked_at FROM approval_bundles
         WHERE organization_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE`,
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!bundle)
      throw new AppError(404, "NOT_FOUND", "Approval link not found.");
    if (!bundle.revoked_at) {
      await tx.query(
        "UPDATE approval_bundles SET revoked_at=now(),revoked_by=$1 WHERE id=$2",
        [c.userId, id],
      );
      await audit(tx, c, "approval_bundle.revoked", id);
    }
    return { revoked: true };
  });
}

// The active bundle behind a link secret. Deleted clients and organizations
// hide their bundles, as they hide per-post approval links.
async function activeBundle(
  db: Pick<PoolClient, "query">,
  secret: string,
  lock = "",
) {
  const bundle = (
    await db.query(
      `SELECT b.id,b.organization_id,b.client_id,b.period_start,b.period_end,
              b.expires_at,c.name AS client_name,c.locale,o.timezone
       FROM approval_bundles b
       JOIN clients c ON c.id=b.client_id AND c.organization_id=b.organization_id
         AND c.deleted_at IS NULL
       JOIN organizations o ON o.id=b.organization_id AND o.deleted_at IS NULL
       WHERE b.token_hash=$1 AND b.revoked_at IS NULL AND b.expires_at>now()
       ${lock}`,
      [hashToken(secret)],
    )
  ).rows[0];
  if (!bundle) throw invalidLink();
  return bundle;
}

type Snapshot = {
  targets?: { accountId: string; caption: string; mediaIds: string[] }[];
};

// Latest content version of each post: what the client is asked to approve.
async function snapshots(postIds: string[]) {
  const rows = (
    await pool.query(
      `SELECT DISTINCT ON (post_id) post_id,snapshot FROM post_versions
       WHERE post_id=ANY($1::uuid[]) ORDER BY post_id,revision DESC`,
      [postIds],
    )
  ).rows;
  return new Map(rows.map((row) => [row.post_id, row.snapshot as Snapshot]));
}

// Public view of a bundle. Posts are referred to only by their number in the
// bundle; no organization, client, post, review or media ID leaves the server.
// Media is served through the bundle's own media endpoint.
export async function bundleView(secret: string) {
  const bundle = await activeBundle(pool, secret);
  const rows = await itemRows(pool, [bundle.id]);
  const visible = rows.filter((row) => !row.deleted);
  const versions = await snapshots(visible.map((row) => row.post_id));
  const accounts = new Map(
    (
      await pool.query(
        "SELECT id,platform,name FROM social_accounts WHERE organization_id=$1 AND client_id=$2",
        [bundle.organization_id, bundle.client_id],
      )
    ).rows.map((account) => [account.id, account]),
  );
  const mediaIds = [...versions.values()].flatMap((snapshot) =>
    (snapshot.targets ?? []).flatMap((target) => target.mediaIds ?? []),
  );
  const assets = new Map(
    (
      await pool.query(
        `SELECT id,name,mime_type FROM media_assets
         WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])
           AND status='READY' AND deleted_at IS NULL`,
        [bundle.organization_id, bundle.client_id, mediaIds],
      )
    ).rows.map((asset) => [asset.id, asset]),
  );
  const shownRequests = rows
    .filter((row) => itemState(row) !== "UNAVAILABLE")
    .map((row) => row.request_id);
  const comments = (
    await pool.query(
      `SELECT approval_request_id,author,body,created_at FROM approval_comments
       WHERE approval_request_id=ANY($1::uuid[]) ORDER BY created_at,id`,
      [shownRequests],
    )
  ).rows;
  const items = rows.map((row) => {
    const state = itemState(row);
    if (row.deleted)
      return {
        item: row.position,
        state,
        scheduled_at: null,
        caption: "",
        link: null,
        versions: [],
        comments: [],
      };
    return {
      item: row.position,
      state,
      scheduled_at: row.scheduled_at,
      caption: row.caption,
      link: row.link,
      versions: (versions.get(row.post_id)?.targets ?? []).map(
        (target, targetIndex) => {
          const account = accounts.get(target.accountId);
          return {
            platform: account?.platform ?? null,
            name: account?.name ?? null,
            caption: target.caption,
            media: (target.mediaIds ?? []).flatMap((id, mediaIndex) => {
              const asset = assets.get(id);
              return asset
                ? [
                    {
                      file: `${targetIndex}-${mediaIndex}`,
                      name: asset.name,
                      mime_type: asset.mime_type,
                    },
                  ]
                : [];
            }),
          };
        },
      ),
      comments:
        state === "UNAVAILABLE"
          ? []
          : comments
              .filter(
                (comment) => comment.approval_request_id === row.request_id,
              )
              .map(({ author, body, created_at }) => ({
                author,
                body,
                created_at,
              })),
    };
  });
  return {
    client_name: bundle.client_name,
    locale: bundle.locale,
    timezone: bundle.timezone,
    expires_at: bundle.expires_at,
    period_start: bundle.period_start,
    period_end: bundle.period_end,
    summary: summarize(rows),
    items,
  };
}

// Object key of one attachment of a bundle item, for the media endpoint.
// `file` is the "<target>-<attachment>" reference from bundleView.
export async function bundleMedia(secret: string, item: number, file: string) {
  const bundle = await activeBundle(pool, secret);
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(file);
  const row = (
    await pool.query(
      `SELECT bp.post_id FROM approval_bundle_posts bp
       JOIN posts p ON p.id=bp.post_id AND p.deleted_at IS NULL
       WHERE bp.bundle_id=$1 AND bp.position=$2`,
      [bundle.id, item],
    )
  ).rows[0];
  const target = match && row
    ? (await snapshots([row.post_id])).get(row.post_id)?.targets?.[
        Number(match[1])
      ]
    : undefined;
  const mediaId = target?.mediaIds?.[Number(match?.[2])];
  const asset = mediaId
    ? (
        await pool.query(
          `SELECT object_key,mime_type FROM media_assets
           WHERE organization_id=$1 AND client_id=$2 AND id=$3
             AND status='READY' AND deleted_at IS NULL`,
          [bundle.organization_id, bundle.client_id, mediaId],
        )
      ).rows[0]
    : undefined;
  if (!asset) throw new AppError(404, "NOT_FOUND", "Media not found.");
  return asset as { object_key: string; mime_type: string };
}

// Records the client's decisions. "approve_all" approves every item that can
// still be decided, in one transaction and in post ID order; items decided in
// the meantime (here or on their per-post link) are skipped.
export async function decideBundle(secret: string, decision: BundleDecision) {
  return transaction(async (tx) => {
    // FOR SHARE: a concurrent revocation waits for this decision, and a
    // decision after the revocation sees the revoked link.
    const bundle = await activeBundle(tx, secret, "FOR SHARE OF b");
    const origin = { bundleId: bundle.id as string };
    if (decision.action === "approve_all") {
      const total = Number(
        (
          await tx.query(
            "SELECT count(*) AS total FROM approval_bundle_posts WHERE bundle_id=$1",
            [bundle.id],
          )
        ).rows[0].total,
      );
      const requests = (
        await tx.query(
          `SELECT ar.* FROM approval_bundle_posts bp
           JOIN posts p ON p.id=bp.post_id AND p.organization_id=bp.organization_id
             AND p.client_id=bp.client_id AND p.deleted_at IS NULL
             AND p.status='PENDING_APPROVAL'
           JOIN approval_requests ar ON ar.post_id=p.id
             AND ar.organization_id=bp.organization_id
             AND ar.client_id=bp.client_id AND ar.revision=p.revision
           WHERE bp.bundle_id=$1 AND ar.step_kind='EXTERNAL'
             AND ar.status='PENDING' AND ar.expires_at>now()
           ORDER BY ar.post_id,ar.created_at DESC,ar.id DESC
           FOR UPDATE OF ar`,
          [bundle.id],
        )
      ).rows;
      const seen = new Set<string>();
      let approved = 0;
      for (const request of requests) {
        if (seen.has(request.post_id)) continue;
        seen.add(request.post_id);
        try {
          await applyApprovalDecision(
            tx,
            request,
            "approve",
            "",
            undefined,
            origin,
          );
          approved++;
        } catch (error) {
          // Raised before anything is written, so the transaction is intact.
          if (!(error instanceof AppError && error.code === "STALE_APPROVAL"))
            throw error;
        }
      }
      return { approved, skipped: total - approved };
    }
    const item = (
      await tx.query(
        "SELECT post_id FROM approval_bundle_posts WHERE bundle_id=$1 AND position=$2",
        [bundle.id, decision.item],
      )
    ).rows[0];
    if (!item)
      throw new AppError(
        404,
        "NOT_FOUND",
        "This post is not part of this approval link.",
      );
    const request = (
      await tx.query(
        `SELECT ar.* FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.deleted_at IS NULL
         WHERE ar.post_id=$1 AND ar.organization_id=$2 AND ar.client_id=$3
           AND ar.step_kind='EXTERNAL' AND ar.status='PENDING'
           AND ar.expires_at>now()
         ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1
         FOR UPDATE OF ar`,
        [item.post_id, bundle.organization_id, bundle.client_id],
      )
    ).rows[0];
    if (!request) throw decided();
    const result = await applyApprovalDecision(
      tx,
      request,
      decision.action,
      decision.comment,
      undefined,
      origin,
    );
    return { item: decision.item, status: result.status };
  });
}
