import {
  expect,
  test,
  type APIRequestContext,
  type PlaywrightWorkerArgs,
} from "@playwright/test";
import { Pool } from "pg";
import {
  processErasureRequests,
  processRetentionPolicies,
} from "../../packages/server/privacy";

const baseURL = process.env.APP_URL!;

async function signUp(
  playwright: PlaywrightWorkerArgs["playwright"],
  label: string,
) {
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const response = await api.post("/api/auth/sign-up/email", {
    data: { email, password, name: `${label} test` },
  });
  expect(response.ok()).toBe(true);
  return {
    api,
    email,
    userId: (await response.json()).user.id as string,
  };
}

async function createWorkspace(
  db: Pool,
  ownerId: string,
  name: string,
  memberId?: string,
) {
  const organizationId = (
    await db.query(`INSERT INTO organizations(name) VALUES($1) RETURNING id`, [
      name,
    ])
  ).rows[0].id as string;
  const clientId = (
    await db.query(
      `INSERT INTO clients(organization_id,name)
       VALUES($1,'Privacy test client') RETURNING id`,
      [organizationId],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO organization_members(organization_id,user_id,role)
     VALUES($1,$2,'OWNER')`,
    [organizationId, ownerId],
  );
  await db.query(
    `INSERT INTO client_members(organization_id,client_id,user_id,role)
     VALUES($1,$2,$3,'OWNER')`,
    [organizationId, clientId, ownerId],
  );
  if (memberId) {
    await db.query(
      `INSERT INTO organization_members(organization_id,user_id,role)
       VALUES($1,$2,'VIEWER')`,
      [organizationId, memberId],
    );
    await db.query(
      `INSERT INTO client_members(organization_id,client_id,user_id,role)
       VALUES($1,$2,$3,'VIEWER')`,
      [organizationId, clientId, memberId],
    );
  }
  return { organizationId, clientId };
}

async function postAction(
  api: APIRequestContext,
  action: string,
  data: Record<string, unknown> = {},
) {
  return api.post("/api/hub", { data: { action, ...data } });
}

test("personal export excludes secrets and account deletion is cancellable", async ({
  playwright,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const keeper = await signUp(playwright, "privacy-keeper");
  const subject = await signUp(playwright, "privacy-subject");
  let organizationId = "";
  try {
    ({ organizationId } = await createWorkspace(
      db,
      keeper.userId,
      `Privacy ${crypto.randomUUID()}`,
      subject.userId,
    ));

    const exported = await subject.api.get("/api/privacy/export");
    expect(exported.ok()).toBe(true);
    expect(exported.headers()["content-disposition"]).toContain("attachment");
    const payload = await exported.json();
    expect(payload.profile.email).toBe(subject.email);
    expect(payload.memberships.organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: organizationId, role: "VIEWER" }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toMatch(
      /password|access[_-]?token|refresh[_-]?token|session[_-]?token/i,
    );

    const soleOwner = await postAction(
      keeper.api,
      "privacy.user.erase.request",
      { confirmation: keeper.email },
    );
    expect(soleOwner.status()).toBe(409);
    expect((await soleOwner.json()).code).toBe("SOLE_OWNER");

    const requested = await postAction(
      subject.api,
      "privacy.user.erase.request",
      { confirmation: subject.email },
    );
    expect(requested.ok()).toBe(true);
    const firstRequest = await requested.json();
    expect(
      new Date(firstRequest.executeAfter).getTime() - Date.now(),
    ).toBeGreaterThan(23 * 60 * 60 * 1000);

    const cancelled = await postAction(subject.api, "privacy.request.cancel", {
      requestId: firstRequest.id,
    });
    expect(cancelled.ok()).toBe(true);
    expect((await cancelled.json()).status).toBe("CANCELLED");

    const repeated = await postAction(
      subject.api,
      "privacy.user.erase.request",
      { confirmation: subject.email },
    );
    expect(repeated.ok()).toBe(true);
    const finalRequest = await repeated.json();
    await db.query(
      `UPDATE privacy_requests SET execute_after=now()-interval '1 minute',
       run_at=now()-interval '1 minute' WHERE id=$1`,
      [finalRequest.id],
    );
    expect(await processErasureRequests(1)).toEqual({
      completed: 1,
      failed: 0,
    });
    expect(
      Number(
        (
          await db.query(`SELECT count(*) FROM "user" WHERE id=$1`, [
            subject.userId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      (
        await db.query(`SELECT status FROM privacy_requests WHERE id=$1`, [
          finalRequest.id,
        ])
      ).rows[0].status,
    ).toBe("COMPLETED");
  } finally {
    if (organizationId)
      await db.query(`DELETE FROM organizations WHERE id=$1`, [organizationId]);
    await db.query(
      `DELETE FROM privacy_requests WHERE subject_user_id IN ($1,$2) OR requester_id IN ($1,$2)`,
      [keeper.userId, subject.userId],
    );
    await db.query(`DELETE FROM "user" WHERE id IN ($1,$2)`, [
      keeper.userId,
      subject.userId,
    ]);
    await Promise.all([keeper.api.dispose(), subject.api.dispose()]);
    await db.end();
  }
});

test("organization deletion has a grace period and removes only the tenant", async ({
  playwright,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const owner = await signUp(playwright, "privacy-org-owner");
  const organizationName = `Disposable ${crypto.randomUUID()}`;
  let organizationId = "";
  let clientId = "";
  try {
    ({ organizationId, clientId } = await createWorkspace(
      db,
      owner.userId,
      organizationName,
    ));
    await db.query(
      `INSERT INTO social_accounts(
         organization_id,client_id,platform,name,remote_id,mode
       ) VALUES($1,$2,'facebook','Mock page',$3,'mock')`,
      [organizationId, clientId, crypto.randomUUID()],
    );

    const requested = await postAction(
      owner.api,
      "privacy.organization.erase.request",
      { clientId, confirmation: organizationName },
    );
    expect(requested.ok()).toBe(true);
    const firstRequest = await requested.json();
    expect(
      new Date(firstRequest.executeAfter).getTime() - Date.now(),
    ).toBeGreaterThan(71 * 60 * 60 * 1000);
    expect(
      (
        await postAction(owner.api, "privacy.request.cancel", {
          requestId: firstRequest.id,
        })
      ).ok(),
    ).toBe(true);

    const repeated = await postAction(
      owner.api,
      "privacy.organization.erase.request",
      { clientId, confirmation: organizationName },
    );
    expect(repeated.ok()).toBe(true);
    const finalRequest = await repeated.json();
    await db.query(
      `UPDATE privacy_requests SET execute_after=now()-interval '1 minute',
       run_at=now()-interval '1 minute' WHERE id=$1`,
      [finalRequest.id],
    );
    expect(await processErasureRequests(1)).toEqual({
      completed: 1,
      failed: 0,
    });
    expect(
      Number(
        (
          await db.query(`SELECT count(*) FROM organizations WHERE id=$1`, [
            organizationId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db.query(`SELECT count(*) FROM "user" WHERE id=$1`, [
            owner.userId,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
  } finally {
    if (organizationId)
      await db.query(`DELETE FROM organizations WHERE id=$1`, [organizationId]);
    if (organizationId)
      await db.query(`DELETE FROM privacy_requests WHERE organization_id=$1`, [
        organizationId,
      ]);
    await db.query(`DELETE FROM "user" WHERE id=$1`, [owner.userId]);
    await owner.api.dispose();
    await db.end();
  }
});

test("retention removes expired operational data and keeps recent records", async ({
  playwright,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const owner = await signUp(playwright, "privacy-retention-owner");
  let organizationId = "";
  let clientId = "";
  try {
    ({ organizationId, clientId } = await createWorkspace(
      db,
      owner.userId,
      `Retention ${crypto.randomUUID()}`,
    ));
    await db.query(
      `UPDATE organizations
       SET retention_days=30,retention_last_run_at=NULL WHERE id=$1`,
      [organizationId],
    );
    await db.query(
      `INSERT INTO notifications(organization_id,client_id,message,created_at)
       VALUES($1,$2,'expired',now()-interval '31 days'),
             ($1,$2,'recent',now()-interval '29 days')`,
      [organizationId, clientId],
    );

    expect(await processRetentionPolicies(1, organizationId)).toEqual({
      completed: 1,
      failed: 0,
    });
    expect(
      (
        await db.query(
          `SELECT message FROM notifications WHERE organization_id=$1 ORDER BY message`,
          [organizationId],
        )
      ).rows.map((row) => row.message),
    ).toEqual(["recent"]);
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM audit_logs
             WHERE organization_id=$1 AND action='privacy.retention_executed'`,
            [organizationId],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  } finally {
    if (organizationId)
      await db.query(`DELETE FROM organizations WHERE id=$1`, [organizationId]);
    await db.query(`DELETE FROM "user" WHERE id=$1`, [owner.userId]);
    await owner.api.dispose();
    await db.end();
  }
});
