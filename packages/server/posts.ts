import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import {
  inMediaOrder,
  MEDIA_ERRORS,
  mediaErrorText,
  mediaSetErrors,
  supportsFirstComment,
  validatePost,
  type Platform,
} from "../core/domain";
import { AppError } from "../core/security";
import { lockPortalMedia, usableMedia } from "./client-media-rule";
import { postInput } from "./validation";
import type { z } from "zod";
import type { PoolClient } from "pg";

// Checked before any query: the 003 trigger would otherwise reject a repeated
// attachment with a raw database error.
export function assertUniqueMedia(mediaIds: string[]) {
  if (new Set(mediaIds).size !== mediaIds.length)
    throw new AppError(
      422,
      "DUPLICATE_MEDIA",
      mediaErrorText(MEDIA_ERRORS.duplicate),
    );
}

// Attachment count and type limits per network, enforced when a draft is
// saved so nothing is dropped silently later.
export function assertMediaSet(
  platform: Platform,
  media: { id: string; mime_type: string }[],
) {
  const errors = mediaSetErrors(platform, media);
  if (errors.length)
    throw new AppError(
      422,
      "MEDIA_UNSUPPORTED",
      `${networkNames[platform]}: ${errors.map(mediaErrorText).join(" ")}`,
    );
}
// The stored first comment: blank means none. Networks whose adapter cannot
// post a comment reject it instead of silently dropping approved text.
export function firstCommentFor(platform: Platform, value?: string | null) {
  const text = value?.trim() ? value : null;
  if (text && !supportsFirstComment(platform))
    throw new AppError(
      422,
      "FIRST_COMMENT_UNSUPPORTED",
      `${networkNames[platform]}: a first comment is not available on this network.`,
    );
  return text;
}
const networkNames: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  google: "Google Cégprofil",
};

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
  const mediaIds: string[] = targets.flatMap((target) => target.media_ids);
  await lockPortalMedia(tx, c, mediaIds);
  const usable = mediaIds.length ? await usableMedia(tx, "m") : "TRUE";
  const errors: string[] = [];
  for (const target of targets) {
    if (target.account_status !== "CONNECTED") {
      errors.push(
        `${target.platform}: Reconnect the selected account before publishing.`,
      );
      continue;
    }
    const media = inMediaOrder(
      target.media_ids,
      (
        await tx.query(
          `SELECT * FROM media_assets m WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL AND ${usable}`,
          [c.organizationId, c.clientId, target.media_ids],
        )
      ).rows,
    );
    if (media.length !== target.media_ids.length) {
      errors.push(`${target.platform}: An attachment is missing.`);
      continue;
    }
    for (const message of validatePost(target.platform as Platform, {
      caption: target.caption,
      link: post.link,
      media,
    }))
      errors.push(`${target.platform}: ${mediaErrorText(message)}`);
  }
  return { targets, errors };
}
// Draft metadata that only the integration API sets today.
export type DraftMetadata = {
  suggestedAt: string | null;
  pillar: string | null;
  source: string | null;
  mediaUrls: string[] | null;
};

// Creates a DRAFT post with its targets and first version. Shared by the UI
// and the integration API so both keep the same invariants; the caller writes
// the audit event and owns the transaction.
export async function insertDraftPost(
  tx: PoolClient,
  scope: { organizationId: string; clientId: string; authorId: string | null },
  input: Omit<z.infer<typeof postInput>, "clientId">,
  snapshot: unknown,
  metadata?: DraftMetadata,
) {
  if (
    new Set(input.targets.map((t) => t.accountId)).size !== input.targets.length
  )
    throw new AppError(
      422,
      "DUPLICATE_TARGET",
      "Choose each account only once.",
    );
  const post = (
    await tx.query(
      "INSERT INTO posts(organization_id,client_id,author_id,caption,link,suggested_at,pillar,source,media_urls) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        scope.organizationId,
        scope.clientId,
        scope.authorId,
        input.caption,
        input.link || null,
        metadata?.suggestedAt ?? null,
        metadata?.pillar ?? null,
        metadata?.source ?? null,
        metadata?.mediaUrls ? JSON.stringify(metadata.mediaUrls) : null,
      ],
    )
  ).rows[0];
  const mediaIds = input.targets.flatMap((target) => target.mediaIds);
  await lockPortalMedia(tx, scope, mediaIds);
  const usable = mediaIds.length ? await usableMedia(tx, "m") : "TRUE";
  for (const target of input.targets) {
    const account = (
      await tx.query(
        "SELECT * FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='CONNECTED' AND deleted_at IS NULL",
        [scope.organizationId, scope.clientId, target.accountId],
      )
    ).rows[0];
    if (!account)
      throw new AppError(
        422,
        "INVALID_ACCOUNT",
        "Choose a connected account from this client.",
      );
    if (target.mediaIds.length) {
      assertUniqueMedia(target.mediaIds);
      const media = inMediaOrder(
        target.mediaIds,
        (
          await tx.query(
            `SELECT * FROM media_assets m WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND status='READY' AND deleted_at IS NULL AND ${usable}`,
            [scope.organizationId, scope.clientId, target.mediaIds],
          )
        ).rows,
      );
      if (media.length !== target.mediaIds.length)
        throw new AppError(
          422,
          "INVALID_MEDIA",
          "Media must belong to this client and be ready.",
        );
      assertMediaSet(account.platform, media);
    }
    await tx.query(
      "INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids,first_comment) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        scope.organizationId,
        scope.clientId,
        post.id,
        account.id,
        target.caption,
        target.mediaIds,
        firstCommentFor(account.platform, target.firstComment),
      ],
    );
  }
  await tx.query(
    "INSERT INTO post_versions(organization_id,client_id,post_id,revision,snapshot) VALUES($1,$2,$3,1,$4)",
    [scope.organizationId, scope.clientId, post.id, JSON.stringify(snapshot)],
  );
  return post;
}
export async function createPost(c: Context, input: z.infer<typeof postInput>) {
  return transaction(async (tx) => {
    const post = await insertDraftPost(
      tx,
      {
        organizationId: c.organizationId,
        clientId: c.clientId,
        authorId: c.userId,
      },
      input,
      input,
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
