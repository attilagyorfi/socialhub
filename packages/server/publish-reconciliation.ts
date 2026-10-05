import { pool } from "../db";
import { aggregateStatus, type Status } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { findMetaPublishedMatches } from "./meta";
import { audit, transaction } from "./transaction";

type ReconciliationJob = {
  id: string;
  organization_id: string;
  client_id: string;
  publish_job_id: string;
  attempts: number;
};

const maxAttempts = 4;
const retrySeconds = [60, 300, 900, 3600];

export async function ensurePublishReconciliationJobs() {
  const recovered = await pool.query(
    `UPDATE publish_reconciliation_jobs
     SET status='RETRY',run_at=now(),outcome='ERROR',
         last_error='META_RECONCILIATION_INTERRUPTED',updated_at=now()
     WHERE status='RUNNING' AND started_at<now()-interval '15 minutes'`,
  );
  const result = await pool.query(
    `INSERT INTO publish_reconciliation_jobs(
       organization_id,client_id,publish_job_id,run_at
     )
     SELECT j.organization_id,j.client_id,j.id,now()+interval '1 minute'
     FROM publish_jobs j
     JOIN post_targets t ON t.id=j.target_id
     JOIN social_accounts a ON a.id=t.social_account_id
     WHERE j.status='DEAD' AND j.last_error='META_DELIVERY_UNCERTAIN'
       AND a.mode='direct' AND a.platform IN ('facebook','instagram')
     ON CONFLICT(publish_job_id) DO NOTHING`,
  );
  return {
    queued: result.rowCount ?? 0,
    recovered: recovered.rowCount ?? 0,
  };
}

export async function queueUncertainPublishReconciliation(c: Context) {
  if (!["OWNER", "ADMIN"].includes(c.role))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only organization administrators can request delivery reconciliation.",
    );
  return transaction(async (tx) => {
    const result = await tx.query(
      `INSERT INTO publish_reconciliation_jobs(
         organization_id,client_id,publish_job_id,run_at
       )
       SELECT j.organization_id,j.client_id,j.id,now()
       FROM publish_jobs j
       JOIN post_targets t ON t.id=j.target_id
       JOIN social_accounts a ON a.id=t.social_account_id
       WHERE j.organization_id=$1 AND j.client_id=$2
         AND j.status='DEAD' AND j.last_error='META_DELIVERY_UNCERTAIN'
         AND a.mode='direct' AND a.platform IN ('facebook','instagram')
       ON CONFLICT(publish_job_id) DO UPDATE
       SET status='PENDING',attempts=0,run_at=now(),outcome=NULL,
           matched_remote_id=NULL,last_error=NULL,started_at=NULL,
           completed_at=NULL,updated_at=now()
       WHERE publish_reconciliation_jobs.status<>'RUNNING'`,
      [c.organizationId, c.clientId],
    );
    await audit(tx, c, "post.publish_reconciliation_requested", c.clientId, {
      queued: result.rowCount ?? 0,
    });
    return { queued: result.rowCount ?? 0 };
  });
}

async function loadInput(job: ReconciliationJob) {
  const row = (
    await pool.query(
      `SELECT r.id,j.id AS publish_job_id,j.idempotency_key,
              t.id AS target_id,t.post_id,t.social_account_id,t.caption,
              a.platform,a.mode,
              uncertain.started_at AS delivery_started_at,
              coalesce(uncertain.finished_at,uncertain.started_at)
                AS delivery_finished_at
       FROM publish_reconciliation_jobs r
       JOIN publish_jobs j ON j.id=r.publish_job_id
       JOIN post_targets t ON t.id=j.target_id
       JOIN social_accounts a ON a.id=t.social_account_id
       JOIN LATERAL (
         SELECT started_at,finished_at
         FROM publish_attempts
         WHERE publish_job_id=j.id
           AND error_code='META_DELIVERY_UNCERTAIN'
         ORDER BY attempt DESC LIMIT 1
       ) uncertain ON true
       WHERE r.id=$1 AND r.organization_id=$2 AND r.client_id=$3`,
      [job.id, job.organization_id, job.client_id],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      404,
      "RECONCILIATION_INPUT_MISSING",
      "Delivery reconciliation input is missing.",
    );
  if (row.mode !== "direct" || !["facebook", "instagram"].includes(row.platform))
    throw new AppError(
      422,
      "RECONCILIATION_PROVIDER_UNSUPPORTED",
      "Delivery reconciliation is not configured for this provider.",
    );
  return row;
}

async function confirmMatch(
  job: ReconciliationJob,
  input: Awaited<ReturnType<typeof loadInput>>,
  match: { id: string; createdAt: string; permalink?: string },
) {
  await transaction(async (tx) => {
    const locked = (
      await tx.query(
        `SELECT status FROM publish_reconciliation_jobs
         WHERE id=$1 FOR UPDATE`,
        [job.id],
      )
    ).rows[0];
    if (!locked || locked.status !== "RUNNING") return;
    await tx.query(
      `INSERT INTO provider_receipts(
         idempotency_key,organization_id,client_id,provider,remote_id
       ) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        input.idempotency_key,
        job.organization_id,
        job.client_id,
        `meta:${input.platform}`,
        match.id,
      ],
    );
    const receipt = (
      await tx.query(
        `SELECT remote_id FROM provider_receipts
         WHERE idempotency_key=$1 AND organization_id=$2 AND client_id=$3`,
        [input.idempotency_key, job.organization_id, job.client_id],
      )
    ).rows[0];
    if (receipt?.remote_id !== match.id)
      throw new AppError(
        409,
        "PROVIDER_RECEIPT_CONFLICT",
        "The provider receipt does not match the reconciled publication.",
      );
    await tx.query(
      `UPDATE publish_jobs
       SET status='DONE',last_error=NULL,updated_at=now() WHERE id=$1`,
      [input.publish_job_id],
    );
    await tx.query(
      `UPDATE post_targets
       SET status='PUBLISHED',remote_id=$1,published_at=$2,error_code=NULL,
           updated_at=now()
       WHERE id=$3`,
      [match.id, match.createdAt, input.target_id],
    );
    await tx.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [
      input.post_id,
    ]);
    const states = (
      await tx.query("SELECT status FROM post_targets WHERE post_id=$1", [
        input.post_id,
      ])
    ).rows.map((row) => row.status as Status);
    await tx.query("UPDATE posts SET status=$1,updated_at=now() WHERE id=$2", [
      aggregateStatus(states),
      input.post_id,
    ]);
    await tx.query(
      `UPDATE publish_reconciliation_jobs
       SET status='CONFIRMED',outcome='MATCHED',matched_remote_id=$1,
           last_error=NULL,completed_at=now(),updated_at=now()
       WHERE id=$2`,
      [match.id, job.id],
    );
    await tx.query(
      `INSERT INTO notifications(organization_id,client_id,message,resource_id)
       VALUES($1,$2,$3,$4)`,
      [
        job.organization_id,
        job.client_id,
        `Meta delivery confirmed automatically on ${input.platform}.`,
        input.post_id,
      ],
    );
    await tx.query(
      `INSERT INTO audit_logs(
         organization_id,client_id,action,resource_id,metadata
       ) VALUES($1,$2,'post.publish_reconciled',$3,$4)`,
      [
        job.organization_id,
        job.client_id,
        input.post_id,
        JSON.stringify({
          targetId: input.target_id,
          reconciliationJobId: job.id,
          remoteId: match.id,
          permalink: match.permalink,
        }),
      ],
    );
  });
}

async function leaveUnresolved(
  job: ReconciliationJob,
  input: Awaited<ReturnType<typeof loadInput>> | undefined,
  outcome: "NOT_FOUND" | "AMBIGUOUS" | "ERROR",
  errorCode: string,
  terminal: boolean,
) {
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE publish_reconciliation_jobs
       SET status=$1,outcome=$2,last_error=$3,
           run_at=now()+($4 * interval '1 second'),
           completed_at=CASE WHEN $1='UNRESOLVED' THEN now() ELSE NULL END,
           updated_at=now()
       WHERE id=$5 AND status='RUNNING'`,
      [
        terminal ? "UNRESOLVED" : "RETRY",
        outcome,
        errorCode,
        retrySeconds[Math.min(job.attempts - 1, retrySeconds.length - 1)],
        job.id,
      ],
    );
    if (!terminal || !input) return;
    await tx.query(
      `INSERT INTO notifications(organization_id,client_id,message,resource_id)
       VALUES($1,$2,$3,$4)`,
      [
        job.organization_id,
        job.client_id,
        `Meta delivery could not be reconciled automatically: ${errorCode}`,
        input.post_id,
      ],
    );
    await tx.query(
      `INSERT INTO audit_logs(
         organization_id,client_id,action,resource_id,metadata
       ) VALUES($1,$2,'post.publish_reconciliation_unresolved',$3,$4)`,
      [
        job.organization_id,
        job.client_id,
        input.post_id,
        JSON.stringify({
          targetId: input.target_id,
          reconciliationJobId: job.id,
          outcome,
          errorCode,
        }),
      ],
    );
  });
}

export async function processPublishReconciliationJobs(limit = 20) {
  return processPublishReconciliationJobsWith(
    limit,
    findMetaPublishedMatches,
  );
}

export async function processPublishReconciliationJobsWith(
  limit: number,
  findMatches: typeof findMetaPublishedMatches,
  organizationId?: string,
) {
  let confirmed = 0;
  let retried = 0;
  let unresolved = 0;
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index++) {
    const job = await transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT * FROM publish_reconciliation_jobs
           WHERE status IN ('PENDING','RETRY') AND run_at<=now()
             AND ($1::uuid IS NULL OR organization_id=$1)
           ORDER BY run_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [organizationId ?? null],
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE publish_reconciliation_jobs
         SET status='RUNNING',attempts=attempts+1,started_at=now(),
             last_error=NULL,updated_at=now() WHERE id=$1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1 } as ReconciliationJob;
    });
    if (!job) break;
    let input: Awaited<ReturnType<typeof loadInput>> | undefined;
    try {
      input = await loadInput(job);
      const matches = await findMatches({
        organizationId: job.organization_id,
        clientId: job.client_id,
        accountId: input.social_account_id,
        caption: input.caption,
        startedAt: input.delivery_started_at,
        finishedAt: input.delivery_finished_at,
      });
      if (matches.length === 1) {
        await confirmMatch(job, input, matches[0]);
        confirmed++;
      } else {
        const ambiguous = matches.length > 1;
        const terminal = ambiguous || job.attempts >= maxAttempts;
        await leaveUnresolved(
          job,
          input,
          ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
          ambiguous
            ? "META_RECONCILIATION_AMBIGUOUS"
            : "META_RECONCILIATION_NOT_FOUND",
          terminal,
        );
        if (terminal) unresolved++;
        else retried++;
      }
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              503,
              "META_RECONCILIATION_FAILED",
              "Meta delivery reconciliation failed.",
            );
      const transient = appError.status === 429 || appError.status >= 500;
      const terminal = !transient || job.attempts >= maxAttempts;
      if (
        input &&
        ["META_TOKEN_INVALID", "META_TOKEN_EXPIRED"].includes(appError.code)
      )
        await pool.query(
          `UPDATE social_accounts
           SET token_health='EXPIRED',updated_at=now()
           WHERE id=$1 AND organization_id=$2 AND client_id=$3`,
          [
            input.social_account_id,
            job.organization_id,
            job.client_id,
          ],
        );
      await leaveUnresolved(job, input, "ERROR", appError.code, terminal);
      if (terminal) unresolved++;
      else retried++;
    }
  }
  return { confirmed, retried, unresolved };
}

export async function syncPublishReconciliations() {
  const scheduled = await ensurePublishReconciliationJobs();
  return {
    queued: scheduled.queued,
    recovered: scheduled.recovered,
    ...(await processPublishReconciliationJobs()),
  };
}
