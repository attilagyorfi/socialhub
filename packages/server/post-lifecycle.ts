import { z } from "zod";
import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import { postInput } from "./validation";
import { AppError } from "../core/security";

export async function editDraft(
  c: Context,
  id: string,
  input: z.infer<typeof postInput>,
) {
  return transaction(async (tx) => {
    const post = (
      await tx.query(
        "SELECT * FROM posts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
    if (post.status !== "DRAFT")
      throw new AppError(
        409,
        "INVALID_STATE",
        "Only drafts can be edited. Cancel or request changes before editing.",
      );
    if (
      new Set(input.targets.map((t) => t.accountId)).size !==
      input.targets.length
    )
      throw new AppError(
        422,
        "DUPLICATE_TARGET",
        "Choose each account only once.",
      );
    for (const target of input.targets) {
      if (
        !(
          await tx.query(
            "SELECT 1 FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='CONNECTED' AND deleted_at IS NULL",
            [c.organizationId, c.clientId, target.accountId],
          )
        ).rowCount
      )
        throw new AppError(
          422,
          "INVALID_ACCOUNT",
          "Choose a connected account from this client.",
        );
      const media = await tx.query(
        "SELECT id FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND status='READY' AND deleted_at IS NULL",
        [c.organizationId, c.clientId, target.mediaIds],
      );
      if (media.rowCount !== target.mediaIds.length)
        throw new AppError(
          422,
          "INVALID_MEDIA",
          "Media must be ready and belong to this client.",
        );
    }
    await tx.query("DELETE FROM post_targets WHERE post_id=$1", [id]);
    for (const target of input.targets)
      await tx.query(
        "INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids) VALUES($1,$2,$3,$4,$5,$6)",
        [
          c.organizationId,
          c.clientId,
          id,
          target.accountId,
          target.caption,
          target.mediaIds,
        ],
      );
    const updated = (
      await tx.query(
        "UPDATE posts SET caption=$1,link=$2,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *",
        [input.caption, input.link || null, id],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO post_versions(organization_id,client_id,post_id,revision,snapshot) VALUES($1,$2,$3,$4,$5)",
      [
        c.organizationId,
        c.clientId,
        id,
        updated.revision,
        JSON.stringify(input),
      ],
    );
    await tx.query(
      "UPDATE approval_requests SET status='SUPERSEDED',updated_at=now() WHERE post_id=$1 AND status='PENDING'",
      [id],
    );
    await audit(tx, c, "post.edited", id, { revision: updated.revision });
    return updated;
  });
}

export async function cancelPost(c: Context, id: string) {
  return transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM approval_requests WHERE post_id=$1 AND organization_id=$2 AND client_id=$3 FOR UPDATE",
      [id, c.organizationId, c.clientId],
    );
    // Match the worker's lock order: jobs → targets → parent post.
    await tx.query(
      "SELECT j.id FROM publish_jobs j JOIN post_targets t ON t.id=j.target_id WHERE t.post_id=$1 AND j.organization_id=$2 AND j.client_id=$3 ORDER BY j.id FOR UPDATE OF j",
      [id, c.organizationId, c.clientId],
    );
    await tx.query(
      "SELECT id FROM post_targets WHERE post_id=$1 AND organization_id=$2 AND client_id=$3 ORDER BY id FOR UPDATE",
      [id, c.organizationId, c.clientId],
    );
    const post = (
      await tx.query(
        "SELECT * FROM posts WHERE id=$1 AND organization_id=$2 AND client_id=$3 FOR UPDATE",
        [id, c.organizationId, c.clientId],
      )
    ).rows[0];
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
    const delivered = (
      await tx.query(
        "SELECT 1 FROM post_targets WHERE post_id=$1 AND status='PUBLISHED'",
        [id],
      )
    ).rowCount;
    if (delivered)
      throw new AppError(
        409,
        "ALREADY_PUBLISHED",
        "Some content has already published. Cancelling cannot remove published content.",
      );
    if (
      (
        await tx.query(
          `SELECT 1 FROM publish_jobs j JOIN post_targets t ON t.id=j.target_id
           WHERE t.post_id=$1 AND j.status='RUNNING' LIMIT 1`,
          [id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "PUBLISHING_IN_PROGRESS",
        "Publishing is in progress. Try again once it has finished.",
      );
    // An unresolved ambiguous delivery may already be live on the provider.
    const uncertain = (
      await tx.query(
        `SELECT 1 FROM publish_jobs j JOIN post_targets t ON t.id=j.target_id
         WHERE t.post_id=$1 AND j.last_error='META_DELIVERY_UNCERTAIN'
           AND j.status<>'DONE' LIMIT 1`,
        [id],
      )
    ).rowCount;
    if (uncertain)
      throw new AppError(
        409,
        "DELIVERY_UNCERTAIN",
        "Meta may already have published this post. It cannot be cancelled while that delivery is unconfirmed; recheck it in Settings → Operations.",
      );
    if (post.status === "CANCELLED") return { id, status: "CANCELLED" };
    await tx.query(
      "UPDATE publish_jobs SET status='CANCELLED',updated_at=now() WHERE target_id IN (SELECT id FROM post_targets WHERE post_id=$1)",
      [id],
    );
    await tx.query(
      "UPDATE post_targets SET status='CANCELLED',updated_at=now() WHERE post_id=$1",
      [id],
    );
    await tx.query(
      "UPDATE posts SET status='CANCELLED',updated_at=now() WHERE id=$1",
      [id],
    );
    await tx.query(
      "UPDATE approval_requests SET status='CANCELLED',updated_at=now() WHERE post_id=$1 AND status='PENDING'",
      [id],
    );
    await audit(tx, c, "post.cancelled", id);
    return { id, status: "CANCELLED" };
  });
}
