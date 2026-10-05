import { pool } from "../db";
import type { Status, Platform } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";

const MAX_CALENDAR_RANGE_MS = 93 * 24 * 60 * 60 * 1000;
const MAX_CALENDAR_POSTS = 1000;

export type CalendarFilters = {
  from: string;
  to: string;
  platform?: Platform;
  status?: Status;
  authorId?: string;
};

function calendarRange(input: CalendarFilters) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    to <= from ||
    to.getTime() - from.getTime() > MAX_CALENDAR_RANGE_MS
  )
    throw new AppError(
      422,
      "INVALID_RANGE",
      "Choose a calendar range of 93 days or less.",
    );
  return { from, to };
}

export async function listCalendarPosts(c: Context, input: CalendarFilters) {
  const { from, to } = calendarRange(input);
  const values: unknown[] = [c.organizationId, c.clientId, from, to];
  const conditions = [
    "p.organization_id=$1",
    "p.client_id=$2",
    "p.deleted_at IS NULL",
    "p.scheduled_at >= $3",
    "p.scheduled_at < $4",
  ];
  if (input.platform) {
    values.push(input.platform);
    conditions.push(
      `EXISTS(SELECT 1 FROM post_targets ft JOIN social_accounts fa ON fa.id=ft.social_account_id WHERE ft.post_id=p.id AND fa.platform=$${values.length})`,
    );
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`p.status=$${values.length}::post_status`);
  }
  if (input.authorId) {
    values.push(input.authorId);
    conditions.push(`p.author_id=$${values.length}`);
  }
  values.push(MAX_CALENDAR_POSTS + 1);
  const [postsResult, authorsResult] = await Promise.all([
    pool.query(
      `SELECT p.*,u.name AS author_name,
       coalesce((SELECT jsonb_agg(jsonb_build_object(
         'id',t.id,'accountId',t.social_account_id,'platform',a.platform,
         'caption',t.caption,'status',t.status,'mediaIds',t.media_ids,
         'errorCode',t.error_code) ORDER BY t.created_at)
       FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
       WHERE t.post_id=p.id),'[]'::jsonb) AS targets
       FROM posts p LEFT JOIN "user" u ON u.id=p.author_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.scheduled_at,p.id LIMIT $${values.length}`,
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
  const truncated = postsResult.rows.length > MAX_CALENDAR_POSTS;
  return {
    posts: postsResult.rows.slice(0, MAX_CALENDAR_POSTS),
    authors: authorsResult.rows,
    truncated,
  };
}

export async function reschedulePost(
  c: Context,
  id: string,
  scheduledAt: string,
  expectedRevision: number,
) {
  const time = new Date(scheduledAt);
  if (!Number.isFinite(time.getTime()) || time.getTime() < Date.now() - 5000)
    throw new AppError(422, "INVALID_TIME", "Choose a valid future time.");

  return transaction(async (tx) => {
    // Match the worker lock order: jobs → targets → parent post.
    const jobs = (
      await tx.query(
        `SELECT j.*,t.status AS target_status
         FROM publish_jobs j JOIN post_targets t ON t.id=j.target_id
         WHERE t.post_id=$1 AND j.organization_id=$2 AND j.client_id=$3
         ORDER BY j.id FOR UPDATE OF j`,
        [id, c.organizationId, c.clientId],
      )
    ).rows;
    const targets = (
      await tx.query(
        `SELECT id,status FROM post_targets
         WHERE post_id=$1 AND organization_id=$2 AND client_id=$3
         ORDER BY id FOR UPDATE`,
        [id, c.organizationId, c.clientId],
      )
    ).rows;
    const post = (
      await tx.query(
        `SELECT * FROM posts
         WHERE id=$1 AND organization_id=$2 AND client_id=$3 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, c.organizationId, c.clientId],
      )
    ).rows[0];
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
    if (post.revision !== expectedRevision)
      throw new AppError(
        409,
        "STALE_POST",
        "This post changed since the calendar loaded. Refresh and try again.",
      );
    if (post.status !== "SCHEDULED")
      throw new AppError(
        409,
        "INVALID_STATE",
        "Only scheduled posts that have not started publishing can be moved.",
      );
    if (
      !targets.length ||
      jobs.length !== targets.length ||
      targets.some((target) => target.status !== "SCHEDULED") ||
      jobs.some((job) => job.status !== "PENDING" || job.attempts !== 0)
    )
      throw new AppError(
        409,
        "PUBLISHING_STARTED",
        "Publishing has already started for this post.",
      );
    const deliveryEvidence = await tx.query(
      `SELECT 1 FROM publish_jobs j
       WHERE j.id=ANY($1::uuid[]) AND (
         EXISTS(SELECT 1 FROM publish_attempts pa WHERE pa.publish_job_id=j.id) OR
         EXISTS(SELECT 1 FROM provider_receipts pr WHERE pr.idempotency_key=j.idempotency_key)
       ) LIMIT 1`,
      [jobs.map((job) => job.id)],
    );
    if (deliveryEvidence.rowCount)
      throw new AppError(
        409,
        "PUBLISHING_STARTED",
        "Publishing has already started for this post.",
      );

    await tx.query(
      `UPDATE publish_jobs SET run_at=$1,status='PENDING',last_error=NULL,updated_at=now()
       WHERE id=ANY($2::uuid[])`,
      [time, jobs.map((job) => job.id)],
    );
    const updated = (
      await tx.query(
        `UPDATE posts SET scheduled_at=$1,revision=revision+1,updated_at=now()
         WHERE id=$2 RETURNING id,status,scheduled_at,revision`,
        [time, id],
      )
    ).rows[0];
    await audit(tx, c, "post.rescheduled", id, {
      previousScheduledAt: new Date(post.scheduled_at).toISOString(),
      scheduledAt: time.toISOString(),
      revision: updated.revision,
    });
    return {
      id: updated.id,
      status: updated.status,
      scheduledAt: new Date(updated.scheduled_at).toISOString(),
      revision: updated.revision,
    };
  });
}
