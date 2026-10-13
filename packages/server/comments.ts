import type { PoolClient } from "pg";
import { pool } from "../db";
import { can } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import {
  fetchMetaComments,
  fetchMetaRecentContent,
  hideMetaComment,
  metaIntegrationStatus,
  replyMetaComment,
  subscribeMetaWebhooks,
} from "./meta";
import { audit, transaction } from "./transaction";

// Comments on posts published in the last month are polled; webhooks cover
// everything else (and arrive faster) once the app is approved.
const SYNC_WINDOW_DAYS = 30;
const SYNC_INTERVAL_MINUTES = 10;
// Posts published outside the hub are read from the network itself.
const RECENT_POSTS_PER_SYNC = 25;
const PAGE_SIZE = 25;

type Queryable = Pick<PoolClient, "query">;

type AccountRow = {
  id: string;
  organization_id: string;
  client_id: string;
  platform: "facebook" | "instagram";
  remote_id: string;
};

export type IncomingComment = {
  remoteId: string;
  parentRemoteId: string | null;
  objectRemoteId: string;
  authorName: string | null;
  authorRemoteId: string | null;
  message: string;
  createdAt: string;
  hidden: boolean;
  likeCount: number;
  fromPage: boolean;
};

async function storeComment(
  db: Queryable,
  account: AccountRow,
  comment: IncomingComment,
  postTargetId: string | null,
) {
  const result = await db.query(
    `INSERT INTO social_comments(
       organization_id,client_id,social_account_id,platform,remote_id,
       parent_remote_id,object_remote_id,post_target_id,author_name,
       author_remote_id,message,from_page,hidden,like_count,status,
       remote_created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(social_account_id,remote_id) DO UPDATE SET
       message=excluded.message,hidden=excluded.hidden,
       like_count=excluded.like_count,deleted=false,
       author_name=coalesce(excluded.author_name,social_comments.author_name),
       author_remote_id=coalesce(excluded.author_remote_id,social_comments.author_remote_id),
       post_target_id=coalesce(social_comments.post_target_id,excluded.post_target_id),
       updated_at=now()
     RETURNING (xmax = 0) AS inserted`,
    [
      account.organization_id,
      account.client_id,
      account.id,
      account.platform,
      comment.remoteId,
      comment.parentRemoteId,
      comment.objectRemoteId,
      postTargetId,
      comment.authorName,
      comment.authorRemoteId,
      comment.message.slice(0, 8000),
      comment.fromPage,
      comment.hidden,
      comment.likeCount,
      // The page's own comments never need handling.
      comment.fromPage ? "DONE" : "OPEN",
      new Date(comment.createdAt),
    ],
  );
  const inserted = result.rows[0]?.inserted === true;
  // Someone answered in a handled thread: it needs attention again.
  if (inserted && comment.parentRemoteId && !comment.fromPage)
    await db.query(
      `UPDATE social_comments SET status='OPEN',updated_at=now()
       WHERE social_account_id=$1 AND remote_id=$2`,
      [account.id, comment.parentRemoteId],
    );
  return inserted;
}

async function targetForObject(
  db: Queryable,
  accountId: string,
  objectRemoteId: string,
) {
  const row = (
    await db.query(
      "SELECT id FROM post_targets WHERE social_account_id=$1 AND remote_id=$2 LIMIT 1",
      [accountId, objectRemoteId],
    )
  ).rows[0];
  return (row?.id as string | undefined) ?? null;
}

const accountRef = (account: AccountRow) => ({
  organizationId: account.organization_id,
  clientId: account.client_id,
  accountId: account.id,
});

export async function syncAccountComments(account: AccountRow) {
  const targets = (
    await pool.query(
      `SELECT id,remote_id FROM post_targets
       WHERE social_account_id=$1 AND status='PUBLISHED' AND remote_id IS NOT NULL
         AND published_at>now()-make_interval(days => $2)
       ORDER BY published_at DESC LIMIT 50`,
      [account.id, SYNC_WINDOW_DAYS],
    )
  ).rows as { id: string; remote_id: string }[];
  const since = Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const known = new Set(targets.map((target) => target.remote_id));
  const recent = (await fetchMetaRecentContent(accountRef(account)))
    .filter(
      (item) =>
        !known.has(item.id) && new Date(item.createdAt).getTime() >= since,
    )
    .slice(0, RECENT_POSTS_PER_SYNC);
  const objects = [
    ...targets.map((target) => ({
      remoteId: target.remote_id,
      targetId: target.id as string | null,
    })),
    ...recent.map((item) => ({ remoteId: item.id, targetId: null })),
  ];
  let inserted = 0;
  if (account.platform === "facebook") await ensureWebhooks(account);
  for (const target of objects) {
    // Facebook videos still processing only have a video id, not a post.
    if (account.platform === "facebook" && !target.remoteId.includes("_"))
      continue;
    let comments;
    try {
      comments = await fetchMetaComments({
        ...accountRef(account),
        objectId: target.remoteId,
      });
    } catch (error) {
      // A post deleted on Facebook/Instagram must not stop the others;
      // outages, rate limits and broken credentials still do.
      if (
        error instanceof AppError &&
        error.status < 500 &&
        error.status !== 429 &&
        error.code === "META_REJECTED"
      )
        continue;
      throw error;
    }
    for (const comment of comments)
      if (await storeComment(pool, account, comment, target.targetId))
        inserted++;
  }
  await pool.query(
    "UPDATE social_accounts SET comments_synced_at=now() WHERE id=$1",
    [account.id],
  );
  return inserted;
}

async function ensureWebhooks(account: AccountRow) {
  const row = (
    await pool.query(
      "SELECT webhooks_subscribed_at FROM social_accounts WHERE id=$1",
      [account.id],
    )
  ).rows[0];
  if (row?.webhooks_subscribed_at) return;
  try {
    if (await subscribeMetaWebhooks(accountRef(account)))
      await pool.query(
        "UPDATE social_accounts SET webhooks_subscribed_at=now() WHERE id=$1",
        [account.id],
      );
  } catch (error) {
    // Usually a grant without pages_manage_metadata; polling still works.
    console.error(
      JSON.stringify({
        event: "meta_webhook_subscribe_failed",
        accountId: account.id,
        code: error instanceof AppError ? error.code : "UNKNOWN",
      }),
    );
  }
}

const ACCOUNT_COLUMNS = "id,organization_id,client_id,platform,remote_id";

export async function syncDueComments(limit = 20) {
  if (!metaIntegrationStatus().enabled) return { accounts: 0, inserted: 0 };
  const accounts = (
    await pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM social_accounts
       WHERE mode='direct' AND platform IN ('facebook','instagram')
         AND status='CONNECTED' AND deleted_at IS NULL
         AND (comments_synced_at IS NULL
           OR comments_synced_at<now()-make_interval(mins => $1))
       ORDER BY comments_synced_at NULLS FIRST LIMIT $2`,
      [SYNC_INTERVAL_MINUTES, limit],
    )
  ).rows as AccountRow[];
  let inserted = 0;
  for (const account of accounts) {
    try {
      inserted += await syncAccountComments(account);
    } catch (error) {
      await pool.query(
        "UPDATE social_accounts SET comments_synced_at=now() WHERE id=$1",
        [account.id],
      );
      console.error(
        JSON.stringify({
          event: "comment_sync_failed",
          accountId: account.id,
          code: error instanceof AppError ? error.code : "UNKNOWN",
        }),
      );
    }
  }
  return { accounts: accounts.length, inserted };
}

type WebhookChange = {
  object?: string;
  change?: { field?: string; value?: Record<string, unknown> };
};

const text = (value: unknown) =>
  typeof value === "string" && value ? value : null;

// Applies one stored Meta webhook event; returns false for events the inbox
// does not use.
export async function applyCommentWebhook(
  db: Queryable,
  account: AccountRow,
  payload: WebhookChange,
) {
  const field = payload.change?.field;
  const value = payload.change?.value ?? {};
  if (account.platform === "facebook" && field === "feed") {
    if (value.item !== "comment") return false;
    const remoteId = text(value.comment_id);
    const postId = text(value.post_id);
    if (!remoteId || !postId) return false;
    const verb = value.verb;
    if (verb === "remove") {
      await db.query(
        `UPDATE social_comments SET deleted=true,updated_at=now()
         WHERE social_account_id=$1 AND remote_id=$2`,
        [account.id, remoteId],
      );
      return true;
    }
    if (verb === "hide" || verb === "unhide") {
      await db.query(
        `UPDATE social_comments SET hidden=$3,updated_at=now()
         WHERE social_account_id=$1 AND remote_id=$2`,
        [account.id, remoteId, verb === "hide"],
      );
      return true;
    }
    if (verb !== "add" && verb !== "edited") return false;
    const from = (value.from ?? {}) as { id?: unknown; name?: unknown };
    const parentId = text(value.parent_id);
    const created = Number(value.created_time);
    await storeComment(
      db,
      account,
      {
        remoteId,
        parentRemoteId: parentId && parentId !== postId ? parentId : null,
        objectRemoteId: postId,
        authorName: text(from.name),
        authorRemoteId: text(from.id),
        message: text(value.message) ?? "",
        createdAt: Number.isFinite(created)
          ? new Date(created * 1000).toISOString()
          : new Date().toISOString(),
        hidden: value.is_hidden === true,
        likeCount: 0,
        fromPage: text(from.id) === account.remote_id,
      },
      await targetForObject(db, account.id, postId),
    );
    return true;
  }
  if (account.platform === "instagram" && field === "comments") {
    const remoteId = text(value.id);
    const media = (value.media ?? {}) as { id?: unknown };
    const mediaId = text(media.id);
    if (!remoteId || !mediaId) return false;
    const from = (value.from ?? {}) as { id?: unknown; username?: unknown };
    await storeComment(
      db,
      account,
      {
        remoteId,
        parentRemoteId: text(value.parent_id),
        objectRemoteId: mediaId,
        authorName: text(from.username),
        authorRemoteId: text(from.id),
        message: text(value.text) ?? "",
        createdAt: new Date().toISOString(),
        hidden: false,
        likeCount: 0,
        fromPage: text(from.id) === account.remote_id,
      },
      await targetForObject(db, account.id, mediaId),
    );
    return true;
  }
  return false;
}

export async function processCommentWebhooks(limit = 100) {
  return transaction(async (tx) => {
    const events = (
      await tx.query(
        `SELECT e.id,e.payload,a.id AS account_id,a.organization_id,
                a.client_id,a.platform,a.remote_id
         FROM webhook_events e
         JOIN social_accounts a ON a.id=e.social_account_id
         WHERE e.provider='meta' AND e.status='PENDING'
         ORDER BY e.created_at LIMIT $1
         FOR UPDATE OF e SKIP LOCKED`,
        [limit],
      )
    ).rows;
    let applied = 0;
    for (const event of events) {
      const account: AccountRow = {
        id: event.account_id,
        organization_id: event.organization_id,
        client_id: event.client_id,
        platform: event.platform,
        remote_id: event.remote_id,
      };
      let status = "IGNORED";
      let error: string | null = null;
      try {
        await tx.query("SAVEPOINT comment_event");
        if (await applyCommentWebhook(tx, account, event.payload)) {
          status = "PROCESSED";
          applied++;
        }
        await tx.query("RELEASE SAVEPOINT comment_event");
      } catch (reason) {
        await tx.query("ROLLBACK TO SAVEPOINT comment_event");
        status = "FAILED";
        error = reason instanceof AppError ? reason.code : "PROCESSING_FAILED";
      }
      await tx.query(
        `UPDATE webhook_events SET status=$2,processed_at=now(),last_error=$3
         WHERE id=$1`,
        [event.id, status, error],
      );
    }
    return { events: events.length, applied };
  });
}

type ThreadRow = {
  id: string;
  social_account_id: string;
  platform: "facebook" | "instagram";
  remote_id: string;
  account_name: string;
  author_name: string | null;
  message: string;
  remote_created_at: Date;
  like_count: number;
  hidden: boolean;
  status: "OPEN" | "DONE";
  post_id: string | null;
  caption: string | null;
};

export async function openCommentCount(c: Context) {
  const row = (
    await pool.query(
      `SELECT count(*)::int AS open FROM social_comments
       WHERE organization_id=$1 AND client_id=$2 AND status='OPEN'
         AND parent_remote_id IS NULL AND NOT deleted AND NOT from_page`,
      [c.organizationId, c.clientId],
    )
  ).rows[0];
  return (row?.open as number | undefined) ?? 0;
}

export async function listComments(
  c: Context,
  input: {
    status: "OPEN" | "DONE" | "ALL";
    platform?: "facebook" | "instagram";
    before?: string;
  },
) {
  const values: unknown[] = [c.organizationId, c.clientId];
  const filters = [
    "sc.organization_id=$1",
    "sc.client_id=$2",
    "sc.parent_remote_id IS NULL",
    "NOT sc.deleted",
    "NOT sc.from_page",
  ];
  if (input.status !== "ALL") {
    values.push(input.status);
    filters.push(`sc.status=$${values.length}`);
  }
  if (input.platform) {
    values.push(input.platform);
    filters.push(`sc.platform=$${values.length}`);
  }
  if (input.before) {
    values.push(new Date(input.before));
    filters.push(`sc.remote_created_at<$${values.length}`);
  }
  values.push(PAGE_SIZE + 1);
  const rows = (
    await pool.query(
      `SELECT sc.id,sc.social_account_id,sc.platform,sc.remote_id,
              a.name AS account_name,sc.author_name,sc.message,
              sc.remote_created_at,sc.like_count,sc.hidden,sc.status,
              p.id AS post_id,p.caption
       FROM social_comments sc
       JOIN social_accounts a ON a.id=sc.social_account_id
       LEFT JOIN post_targets t ON t.id=sc.post_target_id
       LEFT JOIN posts p ON p.id=t.post_id
       WHERE ${filters.join(" AND ")}
       ORDER BY sc.remote_created_at DESC,sc.id DESC
       LIMIT $${values.length}`,
      values,
    )
  ).rows as ThreadRow[];
  const page = rows.slice(0, PAGE_SIZE);
  const replies = page.length
    ? ((
        await pool.query(
          `SELECT id,social_account_id,parent_remote_id,author_name,message,
                  remote_created_at,from_page,hidden
           FROM social_comments
           WHERE NOT deleted AND (social_account_id,parent_remote_id) IN (
             SELECT * FROM unnest($1::uuid[],$2::text[]))
           ORDER BY remote_created_at`,
          [
            page.map((row) => row.social_account_id),
            page.map((row) => row.remote_id),
          ],
        )
      ).rows as {
        id: string;
        social_account_id: string;
        parent_remote_id: string;
        author_name: string | null;
        message: string;
        remote_created_at: Date;
        from_page: boolean;
        hidden: boolean;
      }[])
    : [];
  const synced = (
    await pool.query(
      `SELECT max(comments_synced_at) AS synced FROM social_accounts
       WHERE organization_id=$1 AND client_id=$2 AND deleted_at IS NULL`,
      [c.organizationId, c.clientId],
    )
  ).rows[0];
  return {
    threads: page.map((row) => ({
      id: row.id,
      platform: row.platform,
      accountName: row.account_name,
      authorName: row.author_name,
      message: row.message,
      createdAt: new Date(row.remote_created_at).toISOString(),
      likeCount: row.like_count,
      hidden: row.hidden,
      status: row.status,
      post: row.post_id
        ? { id: row.post_id, caption: row.caption ?? "" }
        : null,
      replies: replies
        .filter(
          (reply) =>
            reply.social_account_id === row.social_account_id &&
            reply.parent_remote_id === row.remote_id,
        )
        .map((reply) => ({
          id: reply.id,
          authorName: reply.author_name,
          message: reply.message,
          createdAt: new Date(reply.remote_created_at).toISOString(),
          fromPage: reply.from_page,
          hidden: reply.hidden,
        })),
    })),
    nextBefore:
      rows.length > PAGE_SIZE
        ? new Date(page.at(-1)!.remote_created_at).toISOString()
        : null,
    openCount: await openCommentCount(c),
    canReply: can(c.role, "publish"),
    lastSyncedAt: synced?.synced ? new Date(synced.synced).toISOString() : null,
  };
}

async function loadComment(c: Context, id: string) {
  const row = (
    await pool.query(
      `SELECT sc.*,a.remote_id AS account_remote_id
       FROM social_comments sc
       JOIN social_accounts a ON a.id=sc.social_account_id
       WHERE sc.organization_id=$1 AND sc.client_id=$2 AND sc.id=$3
         AND NOT sc.deleted`,
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Comment not found.");
  return row;
}

export async function replyToComment(c: Context, id: string, message: string) {
  const comment = await loadComment(c, id);
  // Both networks thread replies under the top-level comment only.
  const rootRemoteId: string = comment.parent_remote_id ?? comment.remote_id;
  const account: AccountRow = {
    id: comment.social_account_id,
    organization_id: c.organizationId,
    client_id: c.clientId,
    platform: comment.platform,
    remote_id: comment.account_remote_id,
  };
  const reply = await replyMetaComment({
    ...accountRef(account),
    commentId: rootRemoteId,
    message,
  });
  return transaction(async (tx) => {
    await storeComment(
      tx,
      account,
      {
        remoteId: reply.remoteId,
        parentRemoteId: rootRemoteId,
        objectRemoteId: comment.object_remote_id,
        authorName: null,
        authorRemoteId: reply.authorRemoteId || null,
        message,
        createdAt: new Date().toISOString(),
        hidden: false,
        likeCount: 0,
        fromPage: true,
      },
      comment.post_target_id,
    );
    await tx.query(
      `UPDATE social_comments
       SET replied_by=$4,replied_at=now(),updated_at=now()
       WHERE social_account_id=$1 AND remote_id=$2 AND organization_id=$3`,
      [account.id, reply.remoteId, c.organizationId, c.userId],
    );
    await tx.query(
      `UPDATE social_comments
       SET status='DONE',replied_at=now(),replied_by=$3,updated_at=now()
       WHERE social_account_id=$1 AND remote_id=$2`,
      [account.id, rootRemoteId, c.userId],
    );
    await audit(tx, c, "comment.replied", comment.id, {
      platform: comment.platform,
    });
    const stored = (
      await tx.query(
        `SELECT id,author_name,message,remote_created_at,from_page,hidden
         FROM social_comments WHERE social_account_id=$1 AND remote_id=$2`,
        [account.id, reply.remoteId],
      )
    ).rows[0];
    return {
      reply: {
        id: stored.id as string,
        authorName: stored.author_name as string | null,
        message: stored.message as string,
        createdAt: new Date(stored.remote_created_at).toISOString(),
        fromPage: true,
        hidden: false,
      },
    };
  });
}

export async function setCommentHidden(
  c: Context,
  id: string,
  hidden: boolean,
) {
  const comment = await loadComment(c, id);
  await hideMetaComment({
    organizationId: c.organizationId,
    clientId: c.clientId,
    accountId: comment.social_account_id,
    commentId: comment.remote_id,
    hidden,
  });
  await transaction(async (tx) => {
    await tx.query(
      "UPDATE social_comments SET hidden=$2,updated_at=now() WHERE id=$1",
      [comment.id, hidden],
    );
    await audit(
      tx,
      c,
      hidden ? "comment.hidden" : "comment.unhidden",
      comment.id,
      { platform: comment.platform },
    );
  });
  return { ok: true };
}

export async function setCommentStatus(
  c: Context,
  id: string,
  status: "OPEN" | "DONE",
) {
  const comment = await loadComment(c, id);
  await pool.query(
    "UPDATE social_comments SET status=$2,updated_at=now() WHERE id=$1",
    [comment.id, status],
  );
  return { ok: true };
}

export async function syncClientComments(c: Context) {
  if (!metaIntegrationStatus().enabled) return { synced: 0 };
  const accounts = (
    await pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM social_accounts
       WHERE organization_id=$1 AND client_id=$2 AND mode='direct'
         AND platform IN ('facebook','instagram') AND status='CONNECTED'
         AND deleted_at IS NULL`,
      [c.organizationId, c.clientId],
    )
  ).rows as AccountRow[];
  let synced = 0;
  for (const account of accounts) synced += await syncAccountComments(account);
  return { synced };
}
