import type { PoolClient } from "pg";
import { pool } from "../db";
import { transaction } from "./transaction";
import { AppError } from "../core/security";
import { FIRST_COMMENT_PLATFORMS } from "../core/domain";
import { MetaGraphClient, metaConfig, publishMetaFirstComment } from "./meta";

// Called in the same transaction that marks a target PUBLISHED (direct
// delivery or reconciliation), never for an uncertain delivery. The key is
// derived from the target id, so a repeated call finds the existing job.
export async function enqueueFirstComment(tx: PoolClient, targetId: string) {
  await tx.query(
    `INSERT INTO first_comment_jobs(organization_id,client_id,target_id,idempotency_key)
     SELECT t.organization_id,t.client_id,t.id,md5(t.id::text||':first_comment')::uuid
     FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
     WHERE t.id=$1 AND t.status='PUBLISHED' AND t.remote_id IS NOT NULL
       AND btrim(coalesce(t.first_comment,''))<>'' AND a.platform=ANY($2::text[])
     ON CONFLICT(target_id) DO NOTHING`,
    [targetId, FIRST_COMMENT_PLATFORMS],
  );
}

const MAX_ATTEMPTS = 5;

// Posts one first comment. Transient failures (rate limit, 5xx before
// delivery, network before sending) retry with backoff; an unconfirmed
// delivery becomes UNCERTAIN and is never resent automatically. The
// published target is not touched either way.
export async function executeFirstComment(id: string, graph?: MetaGraphClient) {
  const claim = await transaction(async (tx) => {
    const job = (
      await tx.query(
        "SELECT * FROM first_comment_jobs WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED",
        [id],
      )
    ).rows[0];
    if (
      !job ||
      !["PENDING", "RETRY"].includes(job.status) ||
      new Date(job.run_at).getTime() > Date.now()
    )
      return;
    const target = (
      await tx.query(
        `SELECT t.id,t.post_id,t.remote_id,t.first_comment,t.social_account_id,
                a.platform,a.mode,a.status AS account_status
         FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
         WHERE t.id=$1`,
        [job.target_id],
      )
    ).rows[0];
    await tx.query(
      "UPDATE first_comment_jobs SET status='RUNNING',attempts=attempts+1,updated_at=now() WHERE id=$1",
      [id],
    );
    return { job, target, attempt: job.attempts + 1 };
  });
  if (!claim) return;
  const { job, target, attempt } = claim;
  let remoteId: string | undefined;
  let failure: AppError | undefined;
  try {
    if (!target?.remote_id || !target.first_comment?.trim())
      throw new AppError(422, "FIRST_COMMENT_INVALID", "Nothing to comment.");
    if (target.account_status !== "CONNECTED")
      throw new AppError(422, "DISCONNECTED", "Account disconnected");
    if (target.mode === "direct")
      remoteId = (
        await publishMetaFirstComment(
          {
            organizationId: job.organization_id,
            clientId: job.client_id,
            accountId: target.social_account_id,
            objectId: target.remote_id,
            message: target.first_comment,
            idempotencyKey: job.idempotency_key,
          },
          graph ?? new MetaGraphClient(metaConfig()),
        )
      ).remoteId;
    else {
      // Mock accounts: a local receipt only, nothing leaves the process.
      remoteId = `mock-comment-${job.idempotency_key}`;
      await pool.query(
        `INSERT INTO provider_receipts(idempotency_key,organization_id,client_id,provider,remote_id)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          job.idempotency_key,
          job.organization_id,
          job.client_id,
          `mock:${target.platform}:comment`,
          remoteId,
        ],
      );
    }
  } catch (e) {
    failure =
      e instanceof AppError
        ? e
        : new AppError(503, "PROVIDER_UNAVAILABLE", "Provider request failed");
  }
  return transaction(async (tx) => {
    const current = (
      await tx.query(
        "SELECT status,attempts FROM first_comment_jobs WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      !current ||
      current.status !== "RUNNING" ||
      current.attempts !== attempt
    )
      return;
    const status = !failure
      ? "SENT"
      : failure.code === "META_DELIVERY_UNCERTAIN"
        ? "UNCERTAIN"
        : (failure.status === 429 || failure.status >= 500) &&
            attempt < MAX_ATTEMPTS
          ? "RETRY"
          : "FAILED";
    await tx.query(
      `UPDATE first_comment_jobs
       SET status=$1,remote_id=$2,last_error=$3,
           run_at=CASE WHEN $1='RETRY' THEN now()+($4 * interval '1 second') ELSE run_at END,
           updated_at=now()
       WHERE id=$5`,
      [
        status,
        remoteId ?? null,
        failure?.code ?? null,
        Math.min(3600, 5 * 2 ** (attempt - 1)),
        id,
      ],
    );
    if (status === "FAILED" || status === "UNCERTAIN")
      await tx.query(
        "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
        [
          job.organization_id,
          job.client_id,
          `First comment ${status === "FAILED" ? "failed" : "unconfirmed"} on ${target?.platform}: ${failure!.code}`,
          target?.post_id ?? null,
        ],
      );
    await tx.query(
      "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5)",
      [
        job.organization_id,
        job.client_id,
        status === "SENT"
          ? "post.first_comment_sent"
          : "post.first_comment_failed",
        target?.post_id ?? null,
        JSON.stringify({
          targetId: job.target_id,
          attempt,
          status,
          errorCode: failure?.code,
        }),
      ],
    );
    return { jobId: id, attempt, status, errorCode: failure?.code };
  });
}

// Worker entry point: due jobs, plus jobs a dead worker left RUNNING. Those
// may already have posted, so they become UNCERTAIN instead of retrying.
export async function processFirstComments(
  limit = 20,
  graph?: MetaGraphClient,
) {
  const stale = await pool.query(
    `UPDATE first_comment_jobs SET status='UNCERTAIN',last_error='WORKER_INTERRUPTED',updated_at=now()
     WHERE status='RUNNING' AND updated_at<now()-interval '15 minutes'
     RETURNING id`,
  );
  const due = (
    await pool.query(
      "SELECT id FROM first_comment_jobs WHERE status IN ('PENDING','RETRY') AND run_at<=now() ORDER BY run_at LIMIT $1",
      [limit],
    )
  ).rows;
  const result = { sent: 0, retried: 0, failed: 0, uncertain: 0 };
  for (const { id } of due) {
    const outcome = await executeFirstComment(id, graph);
    if (outcome?.status === "SENT") result.sent++;
    else if (outcome?.status === "RETRY") result.retried++;
    else if (outcome?.status === "FAILED") result.failed++;
    else if (outcome?.status === "UNCERTAIN") result.uncertain++;
  }
  result.uncertain += stale.rows.length;
  return result;
}
