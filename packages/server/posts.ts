import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import { validatePost, type Platform } from "../core/domain";
import { AppError } from "../core/security";
import { postInput } from "./validation";
import type { z } from "zod";
import type { PoolClient } from "pg";

// Shared by approval submission and scheduling, so a post that cannot be
// published is rejected before anyone reviews it, not after.
export async function publishabilityErrors(
  tx: PoolClient,
  c: Context,
  post: { id: string; link: string | null },
) {
  const targets = (
    await tx.query(
      "SELECT t.*,a.platform,a.status AS account_status FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id WHERE t.post_id=$1 AND t.organization_id=$2 AND t.client_id=$3",
      [post.id, c.organizationId, c.clientId],
    )
  ).rows;
  if (!targets.length)
    return { targets, errors: ["Select at least one account."] };
  const errors: string[] = [];
  for (const target of targets) {
    if (target.account_status !== "CONNECTED") {
      errors.push(
        `${target.platform}: Reconnect the selected account before publishing.`,
      );
      continue;
    }
    const media = (
      await tx.query(
        "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL",
        [c.organizationId, c.clientId, target.media_ids],
      )
    ).rows;
    if (media.length !== target.media_ids.length) {
      errors.push(`${target.platform}: An attachment is missing.`);
      continue;
    }
    for (const message of validatePost(target.platform as Platform, {
      caption: target.caption,
      link: post.link,
      media,
    }))
      errors.push(`${target.platform}: ${message}`);
  }
  return { targets, errors };
}
export async function createPost(c: Context, input: z.infer<typeof postInput>) {
  return transaction(async (tx) => {
    if (
      new Set(input.targets.map((t) => t.accountId)).size !==
      input.targets.length
    )
      throw new AppError(
        422,
        "DUPLICATE_TARGET",
        "Choose each account only once.",
      );
    const post = (
      await tx.query(
        "INSERT INTO posts(organization_id,client_id,author_id,caption,link) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [
          c.organizationId,
          c.clientId,
          c.userId,
          input.caption,
          input.link || null,
        ],
      )
    ).rows[0];
    for (const target of input.targets) {
      const account = (
        await tx.query(
          "SELECT * FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='CONNECTED' AND deleted_at IS NULL",
          [c.organizationId, c.clientId, target.accountId],
        )
      ).rows[0];
      if (!account)
        throw new AppError(
          422,
          "INVALID_ACCOUNT",
          "Choose a connected account from this client.",
        );
      const media = (
        await tx.query(
          "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND status='READY' AND deleted_at IS NULL",
          [c.organizationId, c.clientId, target.mediaIds],
        )
      ).rows;
      if (media.length !== target.mediaIds.length)
        throw new AppError(
          422,
          "INVALID_MEDIA",
          "Media must belong to this client and be ready.",
        );
      await tx.query(
        "INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids) VALUES($1,$2,$3,$4,$5,$6)",
        [
          c.organizationId,
          c.clientId,
          post.id,
          account.id,
          target.caption,
          target.mediaIds,
        ],
      );
    }
    await tx.query(
      "INSERT INTO post_versions(organization_id,client_id,post_id,revision,snapshot) VALUES($1,$2,$3,1,$4)",
      [c.organizationId, c.clientId, post.id, JSON.stringify(input)],
    );
    await audit(tx, c, "post.created", post.id);
    return post;
  });
}
export async function schedulePost(
  c: Context,
  id: string,
  scheduledAt: string,
) {
  const time = new Date(scheduledAt);
  if (!Number.isFinite(time.getTime()) || time.getTime() < Date.now() - 5000)
    throw new AppError(422, "INVALID_TIME", "Choose a valid future time.");
  return transaction(async (tx) => {
    const post = (
      await tx.query(
        "SELECT * FROM posts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
    if (post.status !== "APPROVED")
      throw new AppError(
        409,
        "APPROVAL_REQUIRED",
        "The post must be approved before scheduling.",
      );
    const { targets, errors } = await publishabilityErrors(tx, c, post);
    if (errors.length) throw new AppError(422, "VALIDATION", errors.join(" "));
    for (const target of targets) {
      await tx.query(
        "UPDATE post_targets SET status='SCHEDULED',updated_at=now() WHERE id=$1",
        [target.id],
      );
      await tx.query(
        "INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at) VALUES($1,$2,$3,$4)",
        [c.organizationId, c.clientId, target.id, time],
      );
    }
    await tx.query(
      "UPDATE posts SET status='SCHEDULED',scheduled_at=$1,updated_at=now() WHERE id=$2",
      [time, id],
    );
    await audit(tx, c, "post.scheduled", id, {
      scheduledAt: time.toISOString(),
    });
    return { id, status: "SCHEDULED" };
  });
}
