import type { PoolClient, QueryResultRow } from "pg";
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

type Claim = {
  job: QueryResultRow;
  target: QueryResultRow;
  attempt: number;
  trace: string | undefined;
};

// Provider calls can take minutes (Instagram processing), so they run outside
// any transaction: a short transaction claims the job as RUNNING, the provider
// is called, and a second short transaction records the outcome.
export async function executePublish(id: string) {
  const claim = await transaction(async (tx) => {
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
    await tx.query(
      "UPDATE publish_attempts SET status='INTERRUPTED',finished_at=now() WHERE publish_job_id=$1 AND status='STARTED'",
      [id],
    );
    const attempt = Number(
      (
        await tx.query(
          "SELECT coalesce(max(attempt),0)+1 AS next FROM publish_attempts WHERE publish_job_id=$1",
          [id],
        )
      ).rows[0].next,
    );
    const trace: string = (
      await tx.query(
        "INSERT INTO publish_attempts(organization_id,client_id,publish_job_id,attempt,status) VALUES($1,$2,$3,$4,'STARTED') RETURNING id",
        [job.organization_id, job.client_id, id, attempt],
      )
    ).rows[0].id;
    await tx.query(
      "UPDATE publish_jobs SET status='RUNNING',attempts=$1,updated_at=now() WHERE id=$2",
      [attempt, id],
    );
    await tx.query(
      "UPDATE post_targets SET status='PUBLISHING',updated_at=now() WHERE id=$1",
      [target.id],
    );
    const media = (
      await tx.query(
        "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL",
        [job.organization_id, job.client_id, target.media_ids],
      )
    ).rows;
    return { job, target, media, attempt, trace };
  });
  if (!claim) return;
  const { job, target, media, attempt, trace } = claim;

  let failure: AppError | undefined;
  let remoteId: string | undefined;
  try {
    if (target.account_status !== "CONNECTED")
      throw new AppError(422, "DISCONNECTED", "Account disconnected");
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
        : new AppError(503, "PROVIDER_UNAVAILABLE", "Provider request failed");
  }

  return transaction(async (tx) => {
    const current = (
      await tx.query(
        "SELECT status,attempts FROM publish_jobs WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    // A newer attempt or a completed/cancelled job owns the outcome now.
    if (
      !current ||
      current.attempts !== attempt ||
      ["DONE", "CANCELLED"].includes(current.status)
    )
      return;
    await recordOutcome(tx, { job, target, attempt, trace }, failure, remoteId);
    return { jobId: id, attempt, status: failure ? "FAILED" : "PUBLISHED" };
  });
}

async function recordOutcome(
  tx: PoolClient,
  { job, target, attempt, trace }: Claim,
  failure: AppError | undefined,
  remoteId: string | undefined,
) {
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
        job.id,
      ],
    );
    await tx.query(
      "UPDATE post_targets SET status=$1,error_code=$2,updated_at=now() WHERE id=$3",
      [retry ? "QUEUED" : "FAILED", failure.code, target.id],
    );
    if (trace)
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
        [job.organization_id, job.client_id, job.id],
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
      "UPDATE publish_jobs SET status='DONE',attempts=$1,last_error=NULL,updated_at=now() WHERE id=$2",
      [attempt, job.id],
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
}

// A worker that dies during a provider call leaves its job RUNNING. A Meta
// delivery may already be live, so it becomes uncertain and is picked up by
// reconciliation; other providers deduplicate by idempotency key and retry.
export async function recoverInterruptedPublishes() {
  return transaction(async (tx) => {
    const stale = (
      await tx.query(
        `SELECT j.*,t.post_id,a.platform,a.mode
         FROM publish_jobs j
         JOIN post_targets t ON t.id=j.target_id
         JOIN social_accounts a ON a.id=t.social_account_id
         WHERE j.status='RUNNING' AND j.updated_at<now()-interval '15 minutes'
         ORDER BY j.id FOR UPDATE OF j SKIP LOCKED`,
      )
    ).rows;
    for (const job of stale) {
      const trace = (
        await tx.query(
          "SELECT id FROM publish_attempts WHERE publish_job_id=$1 AND attempt=$2",
          [job.id, job.attempts],
        )
      ).rows[0]?.id;
      const meta =
        job.mode === "direct" &&
        ["facebook", "instagram"].includes(job.platform);
      await recordOutcome(
        tx,
        {
          job,
          target: {
            id: job.target_id,
            post_id: job.post_id,
            platform: job.platform,
          },
          attempt: job.attempts,
          trace,
        },
        meta
          ? new AppError(
              409,
              "META_DELIVERY_UNCERTAIN",
              "The worker stopped during delivery.",
            )
          : new AppError(503, "WORKER_INTERRUPTED", "The worker stopped."),
        undefined,
      );
    }
    return stale.length;
  });
}
export { syncAnalytics } from "./analytics-sync";
