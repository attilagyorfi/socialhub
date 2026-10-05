import { Worker } from "bullmq";
import { pool } from "../../../packages/db";
import {
  redis,
  publishQueue,
  mediaQueue,
} from "../../../packages/server/queue";
import {
  executePublish,
  recoverInterruptedPublishes,
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
const lastRun = new Map<string, number>();
// Each maintenance task fails independently so one broken task cannot starve
// the others; a failure waits for the task's normal interval before retrying.
async function periodic(
  task: string,
  intervalMs: number,
  run: () => Promise<void>,
) {
  if (Date.now() - (lastRun.get(task) ?? 0) <= intervalMs) return;
  lastRun.set(task, Date.now());
  try {
    await run();
  } catch {
    console.error(
      JSON.stringify({
        event: "maintenance_error",
        task,
        code: "MAINTENANCE_FAILED",
      }),
    );
  }
}
async function dispatchQueued() {
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
      if (state === "failed" || state === "completed") await existing.remove();
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
      if (state === "failed" || state === "completed") await existing.remove();
      else continue;
    }
    await mediaQueue().add("process", { id: j.id }, { jobId });
  }
}
async function dispatch() {
  if (stopping) return;
  try {
    await periodic("heartbeat", 10_000, () =>
      recordServiceHeartbeat("worker", instanceId, {
        pid: process.pid,
        revision: process.env.APP_REVISION ?? "development",
      }),
    );
    try {
      await dispatchQueued();
    } catch {
      console.error(
        JSON.stringify({ event: "dispatcher_error", code: "DISPATCH_FAILED" }),
      );
    }
    await periodic("publishRecovery", 60_000, async () => {
      const recovered = await recoverInterruptedPublishes();
      if (recovered)
        console.log(JSON.stringify({ event: "publish_recovered", recovered }));
    });
    await periodic("analytics", 60_000, async () => {
      const analytics = await syncAnalytics();
      if (analytics.retried || analytics.failed)
        console.log(JSON.stringify({ event: "analytics_sync", ...analytics }));
    });
    await periodic("publishReconciliation", 60_000, async () => {
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
    });
    await periodic("approvalAutomation", 60_000, async () => {
      const automation = await processApprovalAutomations();
      if (automation.queued || automation.sent || automation.failed)
        console.log(
          JSON.stringify({ event: "approval_automation", ...automation }),
        );
    });
    await periodic("approvalExpiry", 60_000, async () => {
      await expireDueApprovals();
    });
    await periodic("mediaRecovery", 60_000, recoverMediaJobs);
    await periodic("uploadCleanup", 60_000, async () => {
      await cleanupAbandonedUploads();
    });
    await periodic("privacy", 60_000, async () => {
      const privacy = await processPrivacyMaintenance();
      if (
        privacy.erasures.completed ||
        privacy.erasures.failed ||
        privacy.retention.failed
      )
        console.log(
          JSON.stringify({ event: "privacy_maintenance", ...privacy }),
        );
    });
    await periodic("metaCredentials", 60 * 60 * 1000, async () => {
      await refreshDueMetaCredentials();
    });
    await periodic("heartbeatCleanup", 60 * 60 * 1000, async () => {
      await cleanupServiceHeartbeats();
    });
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
