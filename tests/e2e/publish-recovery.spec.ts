import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { recoverInterruptedPublishes } from "../../packages/server/publishing";

test("publishes interrupted mid-delivery are retried or marked uncertain", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let organizationId = "";
  try {
    organizationId = (
      await db.query(
        `INSERT INTO organizations(name) VALUES($1) RETURNING id`,
        [`Recovery ${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    const clientId = (
      await db.query(
        `INSERT INTO clients(organization_id,name)
         VALUES($1,'Recovery client') RETURNING id`,
        [organizationId],
      )
    ).rows[0].id;
    const postId = (
      await db.query(
        `INSERT INTO posts(organization_id,client_id,caption,status)
         VALUES($1,$2,'Campaign','PUBLISHING') RETURNING id`,
        [organizationId, clientId],
      )
    ).rows[0].id;
    // One stale RUNNING job per provider kind, as left by a crashed worker.
    const stale = async (platform: string, mode: string) => {
      const accountId = (
        await db.query(
          `INSERT INTO social_accounts(
             organization_id,client_id,platform,name,remote_id,mode
           ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            organizationId,
            clientId,
            platform,
            `${platform} ${mode}`,
            crypto.randomUUID(),
            mode,
          ],
        )
      ).rows[0].id;
      const targetId = (
        await db.query(
          `INSERT INTO post_targets(
             organization_id,client_id,post_id,social_account_id,caption,status
           ) VALUES($1,$2,$3,$4,'Campaign','PUBLISHING') RETURNING id`,
          [organizationId, clientId, postId, accountId],
        )
      ).rows[0].id;
      const jobId = (
        await db.query(
          `INSERT INTO publish_jobs(
             organization_id,client_id,target_id,run_at,status,attempts,updated_at
           ) VALUES($1,$2,$3,now()-interval '1 hour','RUNNING',1,
                    now()-interval '20 minutes') RETURNING id`,
          [organizationId, clientId, targetId],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO publish_attempts(
           organization_id,client_id,publish_job_id,attempt,status,started_at
         ) VALUES($1,$2,$3,1,'STARTED',now()-interval '20 minutes')`,
        [organizationId, clientId, jobId],
      );
      return jobId;
    };
    const mockJob = await stale("linkedin", "mock");
    const metaJob = await stale("facebook", "direct");

    expect(await recoverInterruptedPublishes()).toBeGreaterThanOrEqual(2);

    const state = async (jobId: string) =>
      (
        await db.query(
          `SELECT j.status,j.last_error,t.status AS target_status,
                  a.status AS attempt_status,a.error_code
           FROM publish_jobs j
           JOIN post_targets t ON t.id=j.target_id
           JOIN publish_attempts a ON a.publish_job_id=j.id
           WHERE j.id=$1`,
          [jobId],
        )
      ).rows[0];
    expect(await state(mockJob)).toMatchObject({
      status: "RETRY",
      last_error: "WORKER_INTERRUPTED",
      target_status: "QUEUED",
      attempt_status: "FAILED",
    });
    // A Meta delivery may already be live: never retried, only reconciled.
    expect(await state(metaJob)).toMatchObject({
      status: "DEAD",
      last_error: "META_DELIVERY_UNCERTAIN",
      target_status: "FAILED",
      attempt_status: "FAILED",
      error_code: "META_DELIVERY_UNCERTAIN",
    });
    expect(
      (
        await db.query(
          "SELECT 1 FROM publish_reconciliation_jobs WHERE publish_job_id=$1",
          [metaJob],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    if (organizationId)
      await db.query(`DELETE FROM organizations WHERE id=$1`, [organizationId]);
    await db.end();
  }
});
