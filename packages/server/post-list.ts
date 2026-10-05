import { z } from "zod";
import { pool } from "../db";
import type { Context } from "./context";
import { AppError } from "../core/security";
import type { Platform, Status } from "../core/domain";

const cursorShape = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.string().uuid(),
});

const postProjection = `SELECT p.*,author.name AS author_name,
 current_review.step_kind AS approval_kind,
 current_review.status AS approval_status,
 current_review.expires_at AS approval_expires_at,
 current_review.assigned_to AS approval_assigned_to,
 current_review.reviewer_name AS approval_reviewer_name,
 current_review.reminder_sent_at AS approval_reminder_sent_at,
 current_review.reminder_count AS approval_reminder_count,
 current_review.automatic_reminder_count AS approval_automatic_reminder_count,
 current_review.next_reminder_at AS approval_next_reminder_at,
 current_review.escalated_at AS approval_escalated_at,
 coalesce((
   SELECT jsonb_agg(jsonb_build_object(
     'id',history.id,'kind',history.step_kind,'status',history.status,
     'expiresAt',history.expires_at,'createdAt',history.created_at,
     'updatedAt',history.updated_at,'reviewerName',reviewer.name,
     'reminderCount',history.reminder_count,
     'automaticReminderCount',history.automatic_reminder_count,
     'escalatedAt',history.escalated_at
   ) ORDER BY history.created_at DESC,history.id DESC)
   FROM approval_requests history
   LEFT JOIN "user" reviewer ON reviewer.id=history.assigned_to
   WHERE history.post_id=p.id
 ),'[]'::jsonb) AS approval_history,
 coalesce((
   SELECT jsonb_agg(jsonb_build_object(
     'id',t.id,'accountId',t.social_account_id,'platform',a.platform,
     'caption',t.caption,'status',t.status,'mediaIds',t.media_ids,
     'errorCode',t.error_code
   ) ORDER BY t.created_at,t.id)
   FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
   WHERE t.post_id=p.id
 ),'[]'::jsonb) AS targets
 FROM posts p
 LEFT JOIN "user" author ON author.id=p.author_id
 LEFT JOIN LATERAL (
   SELECT ar.*,reviewer.name AS reviewer_name
   FROM approval_requests ar
   LEFT JOIN "user" reviewer ON reviewer.id=ar.assigned_to
   WHERE ar.post_id=p.id AND ar.revision=p.revision
   ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1
 ) current_review ON true`;

export type PostListFilters = {
  query?: string;
  status?: Status;
  platform?: Platform;
  authorId?: string;
  approvalOnly?: boolean;
  cursor?: string;
  limit: number;
};

function decodeCursor(value: string) {
  try {
    return cursorShape.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError(
      422,
      "INVALID_CURSOR",
      "The post list cursor is invalid. Start again from the first page.",
    );
  }
}

function encodeCursor(row: { created_at: Date | string; id: string }) {
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(row.created_at).toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}

export async function listPosts(c: Context, input: PostListFilters) {
  const values: unknown[] = [c.organizationId, c.clientId];
  const conditions = [
    "p.organization_id=$1",
    "p.client_id=$2",
    "p.deleted_at IS NULL",
  ];
  if (input.query) {
    values.push(input.query.trim().toLowerCase());
    const parameter = `$${values.length}`;
    conditions.push(
      `(position(${parameter} in lower(p.caption))>0
       OR position(${parameter} in lower(coalesce(p.link,'')))>0
       OR EXISTS(
         SELECT 1 FROM post_targets search_target
         WHERE search_target.post_id=p.id
           AND position(${parameter} in lower(search_target.caption))>0
       ))`,
    );
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`p.status=$${values.length}::post_status`);
  } else if (input.approvalOnly) {
    conditions.push("p.status IN ('PENDING_APPROVAL','APPROVED')");
  }
  if (input.platform) {
    values.push(input.platform);
    conditions.push(
      `EXISTS(
        SELECT 1 FROM post_targets platform_target
        JOIN social_accounts platform_account
          ON platform_account.id=platform_target.social_account_id
        WHERE platform_target.post_id=p.id
          AND platform_account.platform=$${values.length}
      )`,
    );
  }
  if (input.authorId) {
    values.push(input.authorId);
    conditions.push(`p.author_id=$${values.length}`);
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    values.push(cursor.createdAt, cursor.id);
    conditions.push(
      `(p.created_at,p.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(input.limit + 1);
  const [postsResult, authorsResult] = await Promise.all([
    pool.query(
      `${postProjection}
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at DESC,p.id DESC
       LIMIT $${values.length}`,
      values,
    ),
    pool.query(
      `SELECT DISTINCT u.id,u.name
       FROM posts p JOIN "user" u ON u.id=p.author_id
       WHERE p.organization_id=$1 AND p.client_id=$2 AND p.deleted_at IS NULL
       ORDER BY u.name,u.id`,
      [c.organizationId, c.clientId],
    ),
  ]);
  const hasMore = postsResult.rows.length > input.limit;
  const posts = postsResult.rows.slice(0, input.limit);
  return {
    posts,
    authors: authorsResult.rows,
    nextCursor: hasMore ? encodeCursor(posts.at(-1)) : null,
  };
}

export async function getPost(c: Context, id: string) {
  const post = (
    await pool.query(
      `${postProjection}
       WHERE p.organization_id=$1 AND p.client_id=$2 AND p.id=$3
         AND p.deleted_at IS NULL`,
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
  return post;
}
