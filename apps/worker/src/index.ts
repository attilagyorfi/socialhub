import { Worker } from "bullmq";
import { pool } from "../../../packages/db";
import {
  redis,
  publishQueue,
  mediaQueue,
} from "../../../packages/server/queue";
import {
  executePublish,
  syncAnalytics,
} from "../../../packages/server/publishing";
import {
  cleanupAbandonedUploads,
  processMedia,
  recoverMediaJobs,
} from "../../../packages/server/media-processing";
import { refreshDueMetaCredentials } from "../../../packages/server/meta";
import {
  cleanupServiceHeartbeats,
  recordServiceHeartbeat,
  removeServiceHeartbeat,
} from "../../../packages/server/operations";
import {
  expireDueApprovals,
  processApprovalAutomations,
} from "../../../packages/server/approvals";
import { processPrivacyMaintenance } from "../../../packages/server/privacy";
import { syncPublishReconciliations } from "../../../packages/server/publish-reconciliation";

const instanceId =
  process.env.WORKER_INSTANCE_ID ??
  process.env.HOSTNAME ??
  `worker-${crypto.randomUUID()}`;
const publishWorker = new Worker(
  "g2a-publish",
  async (job) => {
    const result = await executePublish(job.data.id);
    if (result)
      console.log(JSON.stringify({ event: "publish_attempt", ...result }));
  },
  { connection: redis(), concurrency: 4 },
);
const mediaWorker = new Worker(
  "g2a-media",
  async (job) => {
    const result = await processMedia(job.data.id);
    if (result)
      console.log(JSON.stringify({ event: "media_processing", ...result }));
  },
  { connection: redis(), concurrency: 2 },
);
publishWorker.on("error", () =>
  console.error(
    JSON.stringify({
      event: "worker_error",
      queue: "publish",
      code: "WORKER_CONNECTION_ERROR",
    }),
  ),
);
mediaWorker.on("error", () =>
  console.error(
    JSON.stringify({
      event: "worker_error",
      queue: "media",
      code: "WORKER_CONNECTION_ERROR",
    }),
  ),
);
let stopping = false;
let lastAnalytics = 0;
let lastMediaMaintenance = 0;
let lastCredentialMaintenance = 0;
let lastHeartbeat = 0;
let lastApprovalMaintenance = 0;
let lastPrivacyMaintenance = 0;
let lastPublishReconciliation = 0;
async function dispatch() {
  if (stopping) return;
  try {
    if (Date.now() - lastHeartbeat > 10_000) {
      await recordServiceHeartbeat("worker", instanceId, {
        pid: process.pid,
        revision: process.env.APP_REVISION ?? "development",
      });
      lastHeartbeat = Date.now();
    }
    const jobs = (
      await pool.query(
        "SELECT id,attempts FROM publish_jobs WHERE status IN ('PENDING','RETRY') AND run_at<=now() ORDER BY run_at LIMIT 100",
      )
    ).rows;
    for (const j of jobs) {
      const jobId = `${j.id}-${j.attempts}`;
      const existing = await publishQueue().getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "failed" || state === "completed")
          await existing.remove();
        else continue;
      }
      await publishQueue().add("publish", { id: j.id }, { jobId });
    }
    const mediaJobs = (
      await pool.query(
        "SELECT id,attempts FROM media_processing_jobs WHERE status IN ('PENDING','RETRY') AND run_at<=now() ORDER BY run_at LIMIT 100",
      )
    ).rows;
    for (const j of mediaJobs) {
      const jobId = `${j.id}-${j.attempts}`;
      const existing = await mediaQueue().getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "failed" || state === "completed")
          await existing.remove();
        else continue;
      }
      await mediaQueue().add("process", { id: j.id }, { jobId });
    }
    if (Date.now() - lastAnalytics > 60000) {
      const analytics = await syncAnalytics();
      if (analytics.retried || analytics.failed)
        console.log(JSON.stringify({ event: "analytics_sync", ...analytics }));
      lastAnalytics = Date.now();
    }
    if (Date.now() - lastPublishReconciliation > 60_000) {
      const reconciliation = await syncPublishReconciliations();
      if (
        reconciliation.queued ||
        reconciliation.recovered ||
        reconciliation.confirmed ||
        reconciliation.retried ||
        reconciliation.unresolved
      )
        console.log(
          JSON.stringify({
            event: "publish_reconciliation",
            ...reconciliation,
          }),
        );
      lastPublishReconciliation = Date.now();
    }
    if (Date.now() - lastApprovalMaintenance > 60_000) {
      const automation = await processApprovalAutomations();
      if (automation.queued || automation.sent || automation.failed)
        console.log(
          JSON.stringify({ event: "approval_automation", ...automation }),
        );
      await expireDueApprovals();
      lastApprovalMaintenance = Date.now();
    }
    if (Date.now() - lastMediaMaintenance > 60000) {
      await recoverMediaJobs();
      await cleanupAbandonedUploads();
      lastMediaMaintenance = Date.now();
    }
    if (Date.now() - lastPrivacyMaintenance > 60_000) {
      const privacy = await processPrivacyMaintenance();
      if (
        privacy.erasures.completed ||
        privacy.erasures.failed ||
        privacy.retention.failed
      )
        console.log(
          JSON.stringify({ event: "privacy_maintenance", ...privacy }),
        );
      lastPrivacyMaintenance = Date.now();
    }
    if (Date.now() - lastCredentialMaintenance > 60 * 60 * 1000) {
      await refreshDueMetaCredentials();
      await cleanupServiceHeartbeats();
      lastCredentialMaintenance = Date.now();
    }
  } catch {
    console.error(
      JSON.stringify({ event: "dispatcher_error", code: "DISPATCH_FAILED" }),
    );
  } finally {
    if (!stopping) setTimeout(dispatch, 2000);
  }
}
void dispatch();
async function stop() {
  stopping = true;
  try {
    await removeServiceHeartbeat("worker", instanceId);
  } catch {
    console.error(
      JSON.stringify({
        event: "worker_heartbeat_remove_failed",
        code: "HEARTBEAT_REMOVE_FAILED",
      }),
    );
  }
  await publishWorker.close();
  await mediaWorker.close();
  await publishQueue().close();
  await mediaQueue().close();
  await redis().quit();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
console.log(
  JSON.stringify({
    event: "worker_started",
    instanceId,
    revision: process.env.APP_REVISION ?? "development",
  }),
);
