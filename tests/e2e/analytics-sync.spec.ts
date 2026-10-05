import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { processAnalyticsSyncJobs } from "../../packages/server/analytics-sync";

test("analytics backfill is durable, deduplicated and visible to operations", async ({
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const email = `analytics-sync-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  let userId = "";
  let organizationId = "";
  let clientId = "";
  try {
    const signup = await api.post("/api/auth/sign-up/email", {
      data: { email, password, name: "Analytics sync test" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    organizationId = (
      await db.query(
        `INSERT INTO organizations(name) VALUES($1) RETURNING id`,
        [`Analytics sync ${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    clientId = (
      await db.query(
        `INSERT INTO clients(organization_id,name)
         VALUES($1,'Metrics client') RETURNING id`,
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
         ) VALUES($1,$2,'facebook','Mock analytics',$3,'mock') RETURNING id`,
        [organizationId, clientId, `mock-${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    const postId = (
      await db.query(
        `INSERT INTO posts(
           organization_id,client_id,author_id,caption,status
         ) VALUES($1,$2,$3,'Metrics post','PUBLISHED') RETURNING id`,
        [organizationId, clientId, userId],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO post_targets(
         organization_id,client_id,post_id,social_account_id,caption,status,
         remote_id,published_at
       ) VALUES($1,$2,$3,$4,'Metrics post','PUBLISHED',$5,now())`,
      [organizationId, clientId, postId, accountId, crypto.randomUUID()],
    );

    const requested = await api.post("/api/hub", {
      data: { action: "analytics.backfill", clientId, days: 3 },
    });
    expect(requested.ok()).toBe(true);
    const requestedBody = await requested.json();
    expect(requestedBody.days).toBe(3);
    expect(requestedBody.queued).toBeGreaterThanOrEqual(0);
    expect(requestedBody.queued).toBeLessThanOrEqual(4);

    await processAnalyticsSyncJobs(10, organizationId);
    await expect
      .poll(async () => {
        const result = await db.query(
          `SELECT count(*) FILTER (WHERE status='DONE') AS done,
                  count(*) FILTER (WHERE status<>'DONE') AS remaining
           FROM analytics_sync_jobs WHERE organization_id=$1`,
          [organizationId],
        );
        return {
          done: Number(result.rows[0].done),
          remaining: Number(result.rows[0].remaining),
        };
      })
      .toEqual({ done: expect.any(Number), remaining: 0 });
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM analytics_sync_jobs
             WHERE organization_id=$1 AND status='DONE'`,
            [organizationId],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThanOrEqual(4);

    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM analytics_daily
             WHERE organization_id=$1 AND day>=current_date-2`,
            [organizationId],
          )
        ).rows[0].count,
      ),
    ).toBe(3);
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM post_metrics WHERE organization_id=$1`,
            [organizationId],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThanOrEqual(1);

    const duplicate = await api.post("/api/hub", {
      data: { action: "analytics.backfill", clientId, days: 3 },
    });
    expect(duplicate.ok()).toBe(true);
    expect((await duplicate.json()).queued).toBeGreaterThanOrEqual(3);
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM analytics_sync_jobs
             WHERE organization_id=$1
               AND (kind='POST' OR snapshot_day>=current_date-2)`,
            [organizationId],
          )
        ).rows[0].count,
      ),
    ).toBe(4);
    await processAnalyticsSyncJobs(10, organizationId);

    const hub = await api.get(`/api/hub?clientId=${clientId}`);
    expect(hub.ok()).toBe(true);
    const operations = (await hub.json()).operations;
    expect(operations.analyticsWaiting).toEqual(expect.any(Number));
    expect(operations.analyticsDead).toBe(0);
    expect(operations.analyticsLastSuccessAt).toBeTruthy();
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
