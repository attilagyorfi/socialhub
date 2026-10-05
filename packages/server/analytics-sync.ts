import { pool } from "../db";
import { provider } from "../core/providers";
import type { Platform } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { fetchMetaPostMetrics, fetchMetaProfileMetrics } from "./meta";
import { audit, transaction } from "./transaction";

type SyncJob = {
  id: string;
  organization_id: string;
  client_id: string;
  social_account_id: string;
  target_id: string | null;
  kind: "PROFILE" | "POST";
  snapshot_day: Date | string;
  attempts: number;
};

const supportedAccount =
  "(a.mode='mock' OR (a.mode='direct' AND a.platform IN ('facebook','instagram')))";

function isoDay(value: Date | string) {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

const mockReceipts = {
  async get() {
    return undefined;
  },
  async put(_key: string, remoteId: string) {
    return remoteId;
  },
};

export async function queueAnalyticsBackfill(c: Context, days: number) {
  if (!["OWNER", "ADMIN"].includes(c.role))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only organization administrators can request analytics backfill.",
    );
  return transaction(async (tx) => {
    const profiles = await tx.query(
      `INSERT INTO analytics_sync_jobs(
         organization_id,client_id,social_account_id,requested_by,kind,
         snapshot_day
       )
       SELECT a.organization_id,a.client_id,a.id,$3,'PROFILE',day::date
       FROM social_accounts a
       CROSS JOIN generate_series(
         current_date-($4::integer-1),current_date,interval '1 day'
       ) day
       WHERE a.organization_id=$1 AND a.client_id=$2
         AND a.status='CONNECTED' AND a.deleted_at IS NULL
         AND ${supportedAccount}
       ON CONFLICT(social_account_id,snapshot_day) WHERE kind='PROFILE'
       DO UPDATE SET status='PENDING',attempts=0,run_at=now(),
                     requested_by=excluded.requested_by,started_at=NULL,
                     completed_at=NULL,error_code=NULL,updated_at=now()
       WHERE analytics_sync_jobs.status<>'RUNNING'`,
      [c.organizationId, c.clientId, c.userId, days],
    );
    const posts = await tx.query(
      `INSERT INTO analytics_sync_jobs(
         organization_id,client_id,social_account_id,target_id,requested_by,
         kind,snapshot_day
       )
       SELECT t.organization_id,t.client_id,t.social_account_id,t.id,$3,
              'POST',current_date
       FROM post_targets t
       JOIN social_accounts a ON a.id=t.social_account_id
       WHERE t.organization_id=$1 AND t.client_id=$2
         AND t.status='PUBLISHED' AND t.remote_id IS NOT NULL
         AND a.status='CONNECTED' AND a.deleted_at IS NULL
         AND ${supportedAccount}
       ON CONFLICT(target_id,snapshot_day) WHERE kind='POST'
       DO UPDATE SET status='PENDING',attempts=0,run_at=now(),
                     requested_by=excluded.requested_by,started_at=NULL,
                     completed_at=NULL,error_code=NULL,updated_at=now()
       WHERE analytics_sync_jobs.status<>'RUNNING'`,
      [c.organizationId, c.clientId, c.userId],
    );
    const queued = (profiles.rowCount ?? 0) + (posts.rowCount ?? 0);
    await audit(tx, c, "analytics.backfill_requested", c.clientId, {
      days,
      queued,
      profileJobs: profiles.rowCount ?? 0,
      postJobs: posts.rowCount ?? 0,
    });
    return { queued, days };
  });
}

export async function ensureAnalyticsSyncJobs(days = 7) {
  const boundedDays = Math.max(1, Math.min(days, 30));
  await pool.query(
    `UPDATE analytics_sync_jobs
     SET status='RETRY',run_at=now(),error_code='ANALYTICS_INTERRUPTED',
         updated_at=now()
     WHERE status='RUNNING' AND started_at<now()-interval '15 minutes'`,
  );
  const profiles = await pool.query(
    `INSERT INTO analytics_sync_jobs(
       organization_id,client_id,social_account_id,kind,snapshot_day
     )
     SELECT a.organization_id,a.client_id,a.id,'PROFILE',current_date
     FROM social_accounts a
     WHERE a.status='CONNECTED' AND a.deleted_at IS NULL
       AND ${supportedAccount}
     ON CONFLICT DO NOTHING`,
  );
  const profileBackfill = await pool.query(
    `INSERT INTO analytics_sync_jobs(
       organization_id,client_id,social_account_id,kind,snapshot_day
     )
     SELECT a.organization_id,a.client_id,a.id,'PROFILE',day::date
     FROM social_accounts a
     CROSS JOIN generate_series(
       current_date-($1::integer-1),current_date-1,interval '1 day'
     ) day
     WHERE $1::integer>1
       AND a.status='CONNECTED' AND a.deleted_at IS NULL
       AND ${supportedAccount}
     ON CONFLICT DO NOTHING`,
    [boundedDays],
  );
  const posts = await pool.query(
    `INSERT INTO analytics_sync_jobs(
       organization_id,client_id,social_account_id,target_id,kind,snapshot_day
     )
     SELECT t.organization_id,t.client_id,t.social_account_id,t.id,
            'POST',current_date
     FROM post_targets t
     JOIN social_accounts a ON a.id=t.social_account_id
     WHERE t.status='PUBLISHED' AND t.remote_id IS NOT NULL
       AND a.status='CONNECTED' AND a.deleted_at IS NULL
       AND ${supportedAccount}
     ON CONFLICT DO NOTHING`,
  );
  return {
    queued:
      (profiles.rowCount ?? 0) +
      (profileBackfill.rowCount ?? 0) +
      (posts.rowCount ?? 0),
  };
}

async function loadJobInput(job: SyncJob) {
  const row = (
    await pool.query(
      `SELECT j.*,j.snapshot_day::text AS snapshot_day,
              a.platform,a.mode,a.remote_id AS account_remote_id,
              t.remote_id AS target_remote_id
       FROM analytics_sync_jobs j
       JOIN social_accounts a ON a.id=j.social_account_id
       LEFT JOIN post_targets t ON t.id=j.target_id
       WHERE j.id=$1`,
      [job.id],
    )
  ).rows[0];
  if (!row)
    throw new AppError(404, "ANALYTICS_JOB_MISSING", "Analytics job missing.");
  if (row.kind === "POST" && !row.target_remote_id)
    throw new AppError(
      422,
      "ANALYTICS_REMOTE_ID_MISSING",
      "Published target has no provider identifier.",
    );
  return row;
}

async function fetchMetrics(job: SyncJob) {
  const input = await loadJobInput(job);
  const day = isoDay(input.snapshot_day);
  if (input.mode === "mock") {
    const adapter = provider(input.platform as Platform, mockReceipts, "mock");
    const normalized =
      input.kind === "PROFILE"
        ? await adapter.fetchProfileMetrics(input.account_remote_id, day)
        : await adapter.fetchPostMetrics(input.target_remote_id);
    return {
      provider: `mock:${input.platform}`,
      raw: normalized,
      normalized,
    };
  }
  if (
    input.mode === "direct" &&
    ["facebook", "instagram"].includes(input.platform)
  ) {
    const metrics =
      input.kind === "PROFILE"
        ? await fetchMetaProfileMetrics({
            organizationId: input.organization_id,
            clientId: input.client_id,
            accountId: input.social_account_id,
            day,
          })
        : await fetchMetaPostMetrics({
            organizationId: input.organization_id,
            clientId: input.client_id,
            accountId: input.social_account_id,
            remoteId: input.target_remote_id,
          });
    return { provider: `meta:${input.platform}`, ...metrics };
  }
  throw new AppError(
    503,
    "ANALYTICS_PROVIDER_UNSUPPORTED",
    "Analytics is not configured for this provider.",
  );
}

async function completeJob(
  job: SyncJob,
  metrics: {
    provider: string;
    raw: Record<string, unknown>;
    normalized: Record<string, number>;
  },
) {
  await transaction(async (tx) => {
    if (job.kind === "PROFILE") {
      await tx.query(
        `INSERT INTO analytics_daily(
           organization_id,client_id,social_account_id,day,provider,raw,normalized
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(social_account_id,day) DO UPDATE
         SET provider=excluded.provider,raw=excluded.raw,
             normalized=excluded.normalized,updated_at=now()`,
        [
          job.organization_id,
          job.client_id,
          job.social_account_id,
          isoDay(job.snapshot_day),
          metrics.provider,
          JSON.stringify(metrics.raw),
          JSON.stringify(metrics.normalized),
        ],
      );
      await tx.query(
        `UPDATE social_accounts SET last_sync_at=now(),updated_at=now()
         WHERE id=$1`,
        [job.social_account_id],
      );
    } else {
      await tx.query(
        `INSERT INTO post_metrics(
           organization_id,client_id,target_id,provider,raw,normalized
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          job.organization_id,
          job.client_id,
          job.target_id,
          metrics.provider,
          JSON.stringify(metrics.raw),
          JSON.stringify(metrics.normalized),
        ],
      );
    }
    await tx.query(
      `UPDATE analytics_sync_jobs
       SET status='DONE',completed_at=now(),error_code=NULL,updated_at=now()
       WHERE id=$1`,
      [job.id],
    );
  });
}

export async function processAnalyticsSyncJobs(
  limit = 50,
  organizationId?: string,
) {
  let completed = 0;
  let retried = 0;
  let failed = 0;
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index++) {
    const job = await transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT *,snapshot_day::text AS snapshot_day
           FROM analytics_sync_jobs
           WHERE status IN ('PENDING','RETRY') AND run_at<=now()
             AND ($1::uuid IS NULL OR organization_id=$1)
           ORDER BY run_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [organizationId ?? null],
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE analytics_sync_jobs
         SET status='RUNNING',attempts=attempts+1,started_at=now(),
             error_code=NULL,updated_at=now() WHERE id=$1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1 } as SyncJob;
    });
    if (!job) break;
    try {
      await completeJob(job, await fetchMetrics(job));
      completed++;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              503,
              "ANALYTICS_SYNC_FAILED",
              "Analytics synchronization failed.",
            );
      const retry =
        (appError.status === 429 || appError.status >= 500) && job.attempts < 3;
      await pool.query(
        `UPDATE analytics_sync_jobs
         SET status=$2,error_code=$3,
             run_at=now()+($4 * interval '1 second'),updated_at=now()
         WHERE id=$1`,
        [
          job.id,
          retry ? "RETRY" : "DEAD",
          appError.code,
          Math.min(900, 30 * 2 ** Math.max(0, job.attempts - 1)),
        ],
      );
      if (["META_TOKEN_INVALID", "META_TOKEN_EXPIRED"].includes(appError.code))
        await pool.query(
          `UPDATE social_accounts SET token_health='EXPIRED',updated_at=now()
           WHERE id=$1`,
          [job.social_account_id],
        );
      if (retry) retried++;
      else failed++;
      console.error(
        JSON.stringify({
          event: "analytics_sync_failed",
          jobId: job.id,
          code: appError.code,
          retry,
        }),
      );
    }
  }
  return { completed, retried, failed };
}

export async function syncAnalytics(limit = 50) {
  const scheduled = await ensureAnalyticsSyncJobs();
  const processed = await processAnalyticsSyncJobs(limit);
  return { ...scheduled, ...processed };
}
