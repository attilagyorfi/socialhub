import { pool } from "../db";
import { transaction } from "./transaction";
import { provider } from "../core/providers";
import { aggregateStatus, type Status, type Platform } from "../core/domain";
import { AppError } from "../core/security";
import { publishMeta } from "./meta";
export const receipts = {
  async get(key: string) {
    return (
      await pool.query(
        "SELECT remote_id FROM mock_receipts WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0]?.remote_id;
  },
  async put(key: string, remoteId: string) {
    return (
      await pool.query(
        "INSERT INTO mock_receipts(idempotency_key,remote_id,organization_id,client_id) SELECT $1,$2,organization_id,client_id FROM publish_jobs WHERE idempotency_key=$1 ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING remote_id",
        [key, remoteId],
      )
    ).rows[0].remote_id;
  },
};
export async function executePublish(id: string) {
  return transaction(async (tx) => {
    const job = (
      await tx.query(
        "SELECT * FROM publish_jobs WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED",
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
        "SELECT t.*,a.platform,a.mode,a.status AS account_status,p.link FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id JOIN posts p ON p.id=t.post_id WHERE t.id=$1 FOR UPDATE OF t",
        [job.target_id],
      )
    ).rows[0];
    if (!target || ["PUBLISHED", "CANCELLED"].includes(target.status)) {
      await tx.query(
        "UPDATE publish_jobs SET status='DONE',updated_at=now() WHERE id=$1",
        [id],
      );
      return;
    }
    await pool.query(
      "UPDATE publish_attempts SET status='INTERRUPTED',finished_at=now() WHERE publish_job_id=$1 AND status='STARTED'",
      [id],
    );
    const attempt = Number(
      (
        await pool.query(
          "SELECT coalesce(max(attempt),0)+1 AS next FROM publish_attempts WHERE publish_job_id=$1",
          [id],
        )
      ).rows[0].next,
    );
    const trace = (
      await pool.query(
        "INSERT INTO publish_attempts(organization_id,client_id,publish_job_id,attempt,status) VALUES($1,$2,$3,$4,'STARTED') RETURNING id",
        [job.organization_id, job.client_id, id, attempt],
      )
    ).rows[0].id;
    let failure: AppError | undefined;
    let remoteId: string | undefined;
    try {
      if (target.account_status !== "CONNECTED")
        throw new AppError(422, "DISCONNECTED", "Account disconnected");
      const media = (
        await tx.query(
          "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL",
          [job.organization_id, job.client_id, target.media_ids],
        )
      ).rows;
      if (media.length !== target.media_ids.length)
        throw new AppError(422, "INVALID_MEDIA", "Attachment missing");
      const content = { caption: target.caption, link: target.link, media };
      if (
        target.mode === "direct" &&
        ["facebook", "instagram"].includes(target.platform)
      )
        remoteId = (
          await publishMeta({
            organizationId: job.organization_id,
            clientId: job.client_id,
            accountId: target.social_account_id,
            platform: target.platform as Platform,
            content,
            idempotencyKey: job.idempotency_key,
          })
        ).remoteId;
      else {
        const adapter = provider(
          target.platform as Platform,
          receipts,
          target.mode,
        );
        remoteId = (
          await adapter.publishPost(content, job.idempotency_key, attempt)
        ).remoteId;
      }
    } catch (e) {
      failure =
        e instanceof AppError
          ? e
          : new AppError(
              503,
              "PROVIDER_UNAVAILABLE",
              "Provider request failed",
            );
    }
    if (failure) {
      const retry =
        (failure.status === 429 || failure.status >= 500) && attempt < 5;
      await tx.query(
        "UPDATE publish_jobs SET status=$1,attempts=$2,last_error=$3,run_at=now()+($4 * interval '1 second'),updated_at=now() WHERE id=$5",
        [
          retry ? "RETRY" : "DEAD",
          attempt,
          failure.code,
          Math.min(3600, 5 * 2 ** (attempt - 1)),
          id,
        ],
      );
      await tx.query(
        "UPDATE post_targets SET status=$1,error_code=$2,updated_at=now() WHERE id=$3",
        [retry ? "QUEUED" : "FAILED", failure.code, target.id],
      );
      await tx.query(
        "UPDATE publish_attempts SET status='FAILED',error_code=$1,finished_at=now() WHERE id=$2",
        [failure.code, trace],
      );
      if (failure.code === "META_DELIVERY_UNCERTAIN")
        await tx.query(
          `INSERT INTO publish_reconciliation_jobs(
             organization_id,client_id,publish_job_id,run_at
           ) VALUES($1,$2,$3,now()+interval '1 minute')
           ON CONFLICT(publish_job_id) DO UPDATE
           SET status='PENDING',attempts=0,run_at=excluded.run_at,
               outcome=NULL,matched_remote_id=NULL,last_error=NULL,
               started_at=NULL,completed_at=NULL,updated_at=now()
           WHERE publish_reconciliation_jobs.status<>'RUNNING'`,
          [job.organization_id, job.client_id, id],
        );
      if (!retry)
        await tx.query(
          "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
          [
            job.organization_id,
            job.client_id,
            `Publishing failed on ${target.platform}: ${failure.code}`,
            target.post_id,
          ],
        );
    } else {
      await tx.query(
        "UPDATE publish_jobs SET status='DONE',attempts=$1,updated_at=now() WHERE id=$2",
        [attempt, id],
      );
      await tx.query(
        "UPDATE post_targets SET status='PUBLISHED',remote_id=$1,published_at=now(),error_code=NULL,updated_at=now() WHERE id=$2",
        [remoteId, target.id],
      );
      await tx.query(
        "UPDATE publish_attempts SET status='SUCCEEDED',provider_request_id=$1,finished_at=now() WHERE id=$2",
        [remoteId, trace],
      );
    }
    // Serialize aggregation across concurrent targets to avoid a stale parent status.
    await tx.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [
      target.post_id,
    ]);
    const states = (
      await tx.query("SELECT status FROM post_targets WHERE post_id=$1", [
        target.post_id,
      ])
    ).rows.map((r) => r.status as Status);
    await tx.query("UPDATE posts SET status=$1,updated_at=now() WHERE id=$2", [
      aggregateStatus(states),
      target.post_id,
    ]);
    await tx.query(
      "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5)",
      [
        job.organization_id,
        job.client_id,
        failure ? "post.publish_attempt_failed" : "post.published",
        target.post_id,
        JSON.stringify({
          targetId: target.id,
          attempt,
          traceId: trace,
          errorCode: failure?.code,
        }),
      ],
    );
    return { jobId: id, attempt, status: failure ? "FAILED" : "PUBLISHED" };
  });
}
export { syncAnalytics } from "./analytics-sync";
