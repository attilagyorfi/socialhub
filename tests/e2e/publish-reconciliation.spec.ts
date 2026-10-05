import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { processPublishReconciliationJobsWith } from "../../packages/server/publish-reconciliation";

test("an exact Meta match safely reconciles an uncertain delivery", async ({
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const email = `publish-reconciliation-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  let userId = "";
  let organizationId = "";
  let clientId = "";
  try {
    const signup = await api.post("/api/auth/sign-up/email", {
      data: { email, password, name: "Reconciliation test" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    organizationId = (
      await db.query(
        `INSERT INTO organizations(name) VALUES($1) RETURNING id`,
        [`Reconciliation ${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    clientId = (
      await db.query(
        `INSERT INTO clients(organization_id,name)
         VALUES($1,'Delivery client') RETURNING id`,
        [organizationId],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO organization_members(organization_id,user_id,role)
       VALUES($1,$2,'OWNER')`,
      [organizationId, userId],
    );
    await db.query(
      `INSERT INTO client_members(organization_id,client_id,user_id,role)
       VALUES($1,$2,$3,'OWNER')`,
      [organizationId, clientId, userId],
    );
    const accountId = (
      await db.query(
        `INSERT INTO social_accounts(
           organization_id,client_id,platform,name,remote_id,mode
         ) VALUES($1,$2,'facebook','Direct page',$3,'direct') RETURNING id`,
        [organizationId, clientId, `page-${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    const postId = (
      await db.query(
        `INSERT INTO posts(
           organization_id,client_id,author_id,caption,status
         ) VALUES($1,$2,$3,'Campaign','FAILED') RETURNING id`,
        [organizationId, clientId, userId],
      )
    ).rows[0].id;
    const targetId = (
      await db.query(
        `INSERT INTO post_targets(
           organization_id,client_id,post_id,social_account_id,caption,status,
           error_code
         ) VALUES($1,$2,$3,$4,'Campaign','FAILED',
                  'META_DELIVERY_UNCERTAIN') RETURNING id`,
        [organizationId, clientId, postId, accountId],
      )
    ).rows[0].id;
    const publishJob = (
      await db.query(
        `INSERT INTO publish_jobs(
           organization_id,client_id,target_id,run_at,status,attempts,last_error
         ) VALUES($1,$2,$3,now()+interval '1 day','PENDING',1,NULL)
         RETURNING id,idempotency_key`,
        [organizationId, clientId, targetId],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO publish_attempts(
         organization_id,client_id,publish_job_id,attempt,status,error_code,
         started_at,finished_at
       ) VALUES($1,$2,$3,1,'FAILED','META_DELIVERY_UNCERTAIN',
                now()-interval '30 seconds',now())`,
      [organizationId, clientId, publishJob.id],
    );
    await db.query(
      `INSERT INTO publish_reconciliation_jobs(
         organization_id,client_id,publish_job_id,run_at
       ) VALUES($1,$2,$3,now()+interval '1 day')`,
      [organizationId, clientId, publishJob.id],
    );
    await db.query(
      `WITH failed AS (
         UPDATE publish_jobs
         SET status='DEAD',last_error='META_DELIVERY_UNCERTAIN',updated_at=now()
         WHERE id=$1 RETURNING id
       )
       UPDATE publish_reconciliation_jobs
       SET run_at=now(),updated_at=now()
       WHERE publish_job_id IN (SELECT id FROM failed)`,
      [publishJob.id],
    );

    const result = await processPublishReconciliationJobsWith(
      1,
      async () => [
        {
          id: "page_post_confirmed",
          caption: "Campaign",
          createdAt: new Date().toISOString(),
          permalink: "https://facebook.example/page_post_confirmed",
        },
      ],
      organizationId,
    );
    expect(result).toEqual({ confirmed: 1, retried: 0, unresolved: 0 });

    const state = (
      await db.query(
        `SELECT r.status AS reconciliation_status,r.outcome,
                j.status AS job_status,j.last_error,
                t.status AS target_status,t.remote_id,
                p.status AS post_status
         FROM publish_reconciliation_jobs r
         JOIN publish_jobs j ON j.id=r.publish_job_id
         JOIN post_targets t ON t.id=j.target_id
         JOIN posts p ON p.id=t.post_id
         WHERE r.organization_id=$1`,
        [organizationId],
      )
    ).rows[0];
    expect(state).toMatchObject({
      reconciliation_status: "CONFIRMED",
      outcome: "MATCHED",
      job_status: "DONE",
      last_error: null,
      target_status: "PUBLISHED",
      remote_id: "page_post_confirmed",
      post_status: "PUBLISHED",
    });
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM provider_receipts
             WHERE idempotency_key=$1 AND remote_id='page_post_confirmed'`,
            [publishJob.idempotency_key],
          )
        ).rows[0].count,
      ),
    ).toBe(1);

    const recheck = await api.post("/api/hub", {
      data: { action: "publishing.reconcile", clientId },
    });
    expect(recheck.ok()).toBe(true);
    expect(await recheck.json()).toEqual({ queued: 0 });

    const hub = await api.get(`/api/hub?clientId=${clientId}`);
    expect(hub.ok()).toBe(true);
    expect((await hub.json()).operations).toMatchObject({
      publishUncertain: 0,
      publishReconciliationWaiting: 0,
      publishReconciliationUnresolved: 0,
      publishReconciliationLastSuccessAt: expect.any(String),
    });
  } finally {
    if (organizationId)
      await db.query(`DELETE FROM organizations WHERE id=$1`, [organizationId]);
    if (userId)
      await db.query(`DELETE FROM "user" WHERE id=$1 AND email=$2`, [
        userId,
        email,
      ]);
    await api.dispose();
    await db.end();
  }
});
