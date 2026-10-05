import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { pool } from "../db";
import type { Context } from "./context";
import { mediaBucket, storageClient } from "./media";
import { redis } from "./queue";

type CheckName = "database" | "redis" | "storage" | "worker";
export type HealthCheck = {
  ok: boolean;
  required: boolean;
  latencyMs?: number;
};
export type ReadinessSnapshot = {
  status: "ok" | "degraded";
  timestamp: string;
  revision?: string;
  checks: Record<CheckName, HealthCheck>;
};

function envFlag(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true";
}

async function timed(
  operation: () => Promise<unknown>,
  required: boolean,
  timeoutMs = 3000,
): Promise<HealthCheck> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("health timeout")),
          timeoutMs,
        );
      }),
    ]);
    return {
      ok: true,
      required,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch {
    return {
      ok: false,
      required,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function evaluateReadiness(
  checks: Record<CheckName, HealthCheck>,
): "ok" | "degraded" {
  return Object.values(checks).some((check) => check.required && !check.ok)
    ? "degraded"
    : "ok";
}

export async function readinessSnapshot(): Promise<ReadinessSnapshot> {
  const workerRequired = envFlag(
    "HEALTH_REQUIRE_WORKER",
    process.env.NODE_ENV === "production",
  );
  const storageRequired = envFlag("HEALTH_REQUIRE_STORAGE", true);
  const [database, redisCheck, storage, worker] = await Promise.all([
    timed(() => pool.query("SELECT 1"), true),
    timed(() => redis().ping(), true),
    timed(
      () =>
        storageClient().send(new HeadBucketCommand({ Bucket: mediaBucket() })),
      storageRequired,
    ),
    timed(async () => {
      const result = await pool.query(
        "SELECT 1 FROM service_heartbeats WHERE service_name='worker' AND last_seen_at>now()-interval '30 seconds' LIMIT 1",
      );
      if (!result.rowCount) throw new Error("worker heartbeat stale");
    }, workerRequired),
  ]);
  const checks = {
    database,
    redis: redisCheck,
    storage,
    worker,
  };
  return {
    status: evaluateReadiness(checks),
    timestamp: new Date().toISOString(),
    revision: process.env.APP_REVISION || undefined,
    checks,
  };
}

export async function recordServiceHeartbeat(
  serviceName: string,
  instanceId: string,
  metadata: Record<string, string | number | boolean> = {},
) {
  await pool.query(
    `INSERT INTO service_heartbeats(service_name,instance_id,metadata)
     VALUES($1,$2,$3)
     ON CONFLICT(service_name,instance_id)
     DO UPDATE SET last_seen_at=now(),metadata=excluded.metadata`,
    [serviceName, instanceId, JSON.stringify(metadata)],
  );
}

export async function removeServiceHeartbeat(
  serviceName: string,
  instanceId: string,
) {
  await pool.query(
    "DELETE FROM service_heartbeats WHERE service_name=$1 AND instance_id=$2",
    [serviceName, instanceId],
  );
}

export async function cleanupServiceHeartbeats() {
  await pool.query(
    "DELETE FROM service_heartbeats WHERE last_seen_at<now()-interval '7 days'",
  );
}

function integer(value: unknown) {
  return Number.parseInt(String(value ?? 0), 10) || 0;
}

export async function operationalSummary(c: Context) {
  const [
    jobs,
    accounts,
    worker,
    approvalDeliveries,
    analyticsJobs,
    publishReconciliations,
  ] =
    await Promise.all([
      pool.query(
        `SELECT
       count(*) FILTER (WHERE kind='publish' AND status IN ('PENDING','RETRY')) AS publish_waiting,
       count(*) FILTER (WHERE kind='publish' AND status='DEAD') AS publish_dead,
       count(*) FILTER (WHERE kind='publish' AND status='DEAD' AND last_error='META_DELIVERY_UNCERTAIN') AS publish_uncertain,
       count(*) FILTER (WHERE kind='media' AND status IN ('PENDING','RETRY','RUNNING')) AS media_waiting,
       count(*) FILTER (WHERE kind='media' AND status='DEAD') AS media_dead,
       max(age_seconds) FILTER (WHERE status IN ('PENDING','RETRY') AND due) AS oldest_due_seconds
       FROM (
        SELECT 'publish' AS kind,status,last_error,run_at<=now() AS due,
         extract(epoch FROM now()-run_at) AS age_seconds
        FROM publish_jobs WHERE organization_id=$1 AND client_id=$2
        UNION ALL
        SELECT 'media' AS kind,status,last_error,run_at<=now() AS due,
         extract(epoch FROM now()-run_at) AS age_seconds
        FROM media_processing_jobs WHERE organization_id=$1 AND client_id=$2
       ) jobs`,
        [c.organizationId, c.clientId],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE status='CONNECTED') AS connected,
       count(*) FILTER (WHERE status='CONNECTED' AND token_health<>'HEALTHY') AS unhealthy_tokens
       FROM social_accounts
       WHERE organization_id=$1 AND client_id=$2 AND deleted_at IS NULL`,
        [c.organizationId, c.clientId],
      ),
      pool.query(
        `SELECT last_seen_at,metadata FROM service_heartbeats
       WHERE service_name='worker' ORDER BY last_seen_at DESC LIMIT 1`,
      ),
      pool.query(
        `SELECT
         count(*) FILTER (
           WHERE status IN ('PENDING','SENDING')
             OR (status='FAILED' AND attempts<3)
         ) AS waiting,
         count(*) FILTER (WHERE status='FAILED' AND attempts>=3) AS failed
       FROM approval_automation_deliveries
       WHERE organization_id=$1 AND client_id=$2`,
        [c.organizationId, c.clientId],
      ),
      pool.query(
        `SELECT
         count(*) FILTER (WHERE status IN ('PENDING','RETRY','RUNNING')) AS waiting,
         count(*) FILTER (WHERE status='DEAD') AS dead,
         max(completed_at) FILTER (WHERE status='DONE') AS last_success_at
       FROM analytics_sync_jobs
       WHERE organization_id=$1 AND client_id=$2`,
        [c.organizationId, c.clientId],
      ),
      pool.query(
        `SELECT
         count(*) FILTER (WHERE status IN ('PENDING','RETRY','RUNNING')) AS waiting,
         count(*) FILTER (WHERE status='UNRESOLVED') AS unresolved,
         max(completed_at) FILTER (WHERE status='CONFIRMED') AS last_success_at
         FROM publish_reconciliation_jobs
         WHERE organization_id=$1 AND client_id=$2`,
        [c.organizationId, c.clientId],
      ),
    ]);
  const job = jobs.rows[0] ?? {};
  const account = accounts.rows[0] ?? {};
  const approvalDelivery = approvalDeliveries.rows[0] ?? {};
  const analyticsJob = analyticsJobs.rows[0] ?? {};
  const publishReconciliation = publishReconciliations.rows[0] ?? {};
  const lastSeen = worker.rows[0]?.last_seen_at
    ? new Date(worker.rows[0].last_seen_at)
    : undefined;
  const workerHealthy = Boolean(
    lastSeen && Date.now() - lastSeen.getTime() < 30_000,
  );
  const summary = {
    publishWaiting: integer(job.publish_waiting),
    publishDead: integer(job.publish_dead),
    publishUncertain: integer(job.publish_uncertain),
    publishReconciliationWaiting: integer(publishReconciliation.waiting),
    publishReconciliationUnresolved: integer(
      publishReconciliation.unresolved,
    ),
    publishReconciliationLastSuccessAt:
      publishReconciliation.last_success_at
        ? new Date(publishReconciliation.last_success_at).toISOString()
        : null,
    mediaWaiting: integer(job.media_waiting),
    mediaDead: integer(job.media_dead),
    oldestDueSeconds: Math.max(
      0,
      Math.round(Number(job.oldest_due_seconds) || 0),
    ),
    connectedAccounts: integer(account.connected),
    unhealthyTokens: integer(account.unhealthy_tokens),
    approvalDeliveriesWaiting: integer(approvalDelivery.waiting),
    approvalDeliveriesFailed: integer(approvalDelivery.failed),
    analyticsWaiting: integer(analyticsJob.waiting),
    analyticsDead: integer(analyticsJob.dead),
    analyticsLastSuccessAt: analyticsJob.last_success_at
      ? new Date(analyticsJob.last_success_at).toISOString()
      : null,
    worker: {
      healthy: workerHealthy,
      lastSeenAt: lastSeen?.toISOString() ?? null,
      revision:
        typeof worker.rows[0]?.metadata?.revision === "string"
          ? worker.rows[0].metadata.revision
          : null,
    },
  };
  return {
    ...summary,
    needsAttention: Boolean(
      summary.publishDead ||
        summary.mediaDead ||
        summary.publishUncertain ||
        summary.publishReconciliationUnresolved ||
        summary.approvalDeliveriesFailed ||
        summary.analyticsDead ||
        summary.unhealthyTokens ||
        !summary.worker.healthy ||
        summary.oldestDueSeconds > 300,
    ),
  };
}
