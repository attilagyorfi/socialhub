import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
const db = new PGlite();
beforeAll(async () => {
  for (const name of [
    "001_initial.sql",
    "002_auth_uuid_defaults.sql",
    "003_media_integrity.sql",
    "004_approval_steps.sql",
    "005_team_invitations.sql",
    "006_media_processing.sql",
    "007_meta_integration.sql",
    "008_operational_health.sql",
    "009_approval_assignment.sql",
    "010_analytics_queries.sql",
    "011_ai_governance.sql",
    "012_approval_automation.sql",
    "013_approval_delivery_cancellation.sql",
    "014_user_timezones.sql",
    "015_privacy_workflows.sql",
    "016_analytics_sync_jobs.sql",
    "017_social_account_cascade.sql",
    "018_publish_reconciliation.sql",
    "019_locales.sql",
    "020_meta_compliance.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../packages/db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
}, 30000);
afterAll(() => db.close());
describe("tenant constraints", () => {
  it("rejects cross-organization client membership", async () => {
    const org1 = crypto.randomUUID(),
      org2 = crypto.randomUUID(),
      client = crypto.randomUUID(),
      user = crypto.randomUUID();
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'one'),($2,'two')",
      [org1, org2],
    );
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
      [client, org1],
    );
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES($1,'user','user@example.test')",
      [user],
    );
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'VIEWER')",
      [org2, user],
    );
    await expect(
      db.query(
        "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,'VIEWER')",
        [org2, client, user],
      ),
    ).rejects.toThrow();
  });
  it("rejects post targets referencing another client’s account", async () => {
    const org = crypto.randomUUID(),
      c1 = crypto.randomUUID(),
      c2 = crypto.randomUUID(),
      account = crypto.randomUUID(),
      post = crypto.randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'tenant')", [
      org,
    ]);
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'one'),($2,$3,'two')",
      [c1, c2, org],
    );
    await db.query(
      "INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode) VALUES($1,$2,$3,'facebook','account','remote','mock')",
      [account, org, c1],
    );
    await db.query(
      "INSERT INTO posts(id,organization_id,client_id) VALUES($1,$2,$3)",
      [post, org, c2],
    );
    await expect(
      db.query(
        "INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption) VALUES($1,$2,$3,$4,'hello')",
        [org, c2, post, account],
      ),
    ).rejects.toThrow();
  });
  it("rejects invitation access to a client in another organization", async () => {
    const org1 = crypto.randomUUID(),
      org2 = crypto.randomUUID(),
      client = crypto.randomUUID(),
      inviter = crypto.randomUUID(),
      invitation = crypto.randomUUID();
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'invite-one'),($2,'invite-two')",
      [org1, org2],
    );
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'foreign-client')",
      [client, org2],
    );
    await db.query(
      "INSERT INTO \"user\"(id,name,email) VALUES($1,'inviter',$2)",
      [inviter, `${inviter}@example.test`],
    );
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')",
      [org1, inviter],
    );
    await db.query(
      `INSERT INTO member_invitations(id,organization_id,email,role,token_hash,invited_by,expires_at)
       VALUES($1,$2,$3,'VIEWER',$4,$5,now()+interval '1 day')`,
      [
        invitation,
        org1,
        `${invitation}@example.test`,
        crypto.randomUUID(),
        inviter,
      ],
    );
    await expect(
      db.query(
        "INSERT INTO member_invitation_clients(organization_id,invitation_id,client_id) VALUES($1,$2,$3)",
        [org1, invitation, client],
      ),
    ).rejects.toThrow();
  });
  it("rejects a media processing job scoped to another client", async () => {
    const org = crypto.randomUUID(),
      c1 = crypto.randomUUID(),
      c2 = crypto.randomUUID(),
      asset = crypto.randomUUID();
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'media-tenant')",
      [org],
    );
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'one'),($2,$3,'two')",
      [c1, c2, org],
    );
    await db.query(
      "INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes) VALUES($1,$2,$3,'asset','incoming/asset','image/png',10)",
      [asset, org, c1],
    );
    await expect(
      db.query(
        "INSERT INTO media_processing_jobs(organization_id,client_id,media_asset_id) VALUES($1,$2,$3)",
        [org, c2, asset],
      ),
    ).rejects.toThrow();
  });
  it("rejects provider evidence scoped to another client", async () => {
    const org = crypto.randomUUID(),
      c1 = crypto.randomUUID(),
      c2 = crypto.randomUUID(),
      account = crypto.randomUUID(),
      post = crypto.randomUUID(),
      target = crypto.randomUUID(),
      job = crypto.randomUUID(),
      key = crypto.randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'receipt')", [
      org,
    ]);
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'one'),($2,$3,'two')",
      [c1, c2, org],
    );
    await db.query(
      "INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode) VALUES($1,$2,$3,'facebook','page','remote','direct')",
      [account, org, c1],
    );
    await db.query(
      "INSERT INTO posts(id,organization_id,client_id) VALUES($1,$2,$3)",
      [post, org, c1],
    );
    await db.query(
      "INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption) VALUES($1,$2,$3,$4,$5,'hello')",
      [target, org, c1, post, account],
    );
    await db.query(
      "INSERT INTO publish_jobs(id,organization_id,client_id,target_id,run_at,idempotency_key) VALUES($1,$2,$3,$4,now(),$5)",
      [job, org, c1, target, key],
    );
    await expect(
      db.query(
        "INSERT INTO provider_receipts(idempotency_key,organization_id,client_id,provider,remote_id) VALUES($1,$2,$3,'meta:facebook','post-1')",
        [key, org, c2],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO publish_reconciliation_jobs(organization_id,client_id,publish_job_id) VALUES($1,$2,$3)",
        [org, c2, job],
      ),
    ).rejects.toThrow();
  });
  it("stores bounded service heartbeat identities", async () => {
    await db.query(
      "INSERT INTO service_heartbeats(service_name,instance_id,metadata) VALUES('worker','worker-1',$1)",
      [JSON.stringify({ revision: "test" })],
    );
    const result = await db.query<{ revision: string }>(
      "SELECT metadata->>'revision' AS revision FROM service_heartbeats WHERE service_name='worker' AND instance_id='worker-1'",
    );
    expect(result.rows[0]?.revision).toBe("test");
    await expect(
      db.query(
        "INSERT INTO service_heartbeats(service_name,instance_id) VALUES('','invalid')",
      ),
    ).rejects.toThrow();
  });
  it("rejects an approval reviewer outside the client scope", async () => {
    const org1 = crypto.randomUUID();
    const org2 = crypto.randomUUID();
    const client = crypto.randomUUID();
    const author = crypto.randomUUID();
    const reviewer = crypto.randomUUID();
    const post = crypto.randomUUID();
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'review-one'),($2,'review-two')",
      [org1, org2],
    );
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'review-client')",
      [client, org1],
    );
    await db.query(
      `INSERT INTO "user"(id,name,email) VALUES
       ($1,'author',$3),($2,'reviewer',$4)`,
      [author, reviewer, `${author}@example.test`, `${reviewer}@example.test`],
    );
    await db.query(
      `INSERT INTO organization_members(organization_id,user_id,role)
       VALUES($1,$2,'OWNER'),($3,$4,'ADMIN')`,
      [org1, author, org2, reviewer],
    );
    await db.query(
      "INSERT INTO posts(id,organization_id,client_id,author_id) VALUES($1,$2,$3,$4)",
      [post, org1, client, author],
    );
    await expect(
      db.query(
        `INSERT INTO approval_requests(
           organization_id,client_id,post_id,revision,token_hash,expires_at,
           step_kind,assigned_to
         ) VALUES($1,$2,$3,1,$4,now()+interval '1 day','INTERNAL',$5)`,
        [org1, client, post, crypto.randomUUID(), reviewer],
      ),
    ).rejects.toThrow(/eligible reviewer/);
  });
  it("rejects an AI generation scoped to another client", async () => {
    const org = crypto.randomUUID();
    const client = crypto.randomUUID();
    const foreignClient = crypto.randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'ai-scope')", [
      org,
    ]);
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'one'),($2,$3,'two')",
      [client, foreignClient, org],
    );
    await expect(
      db.query(
        `INSERT INTO ai_generations(
           organization_id,client_id,operation,provider,model,mode,status,input
         ) VALUES($1,$2,'generate','mock','test','mock','PENDING','hello')`,
        [crypto.randomUUID(), client],
      ),
    ).rejects.toThrow();
  });
  it("rejects an approval delivery scoped to another client", async () => {
    const org = crypto.randomUUID();
    const client = crypto.randomUUID();
    const foreignClient = crypto.randomUUID();
    const post = crypto.randomUUID();
    const request = crypto.randomUUID();
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'delivery-scope')",
      [org],
    );
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'one'),($2,$3,'two')",
      [client, foreignClient, org],
    );
    await db.query(
      "INSERT INTO posts(id,organization_id,client_id) VALUES($1,$2,$3)",
      [post, org, client],
    );
    await db.query(
      `INSERT INTO approval_requests(
         id,organization_id,client_id,post_id,revision,token_hash,expires_at
       ) VALUES($1,$2,$3,$4,1,$5,now()+interval '1 day')`,
      [request, org, client, post, crypto.randomUUID()],
    );
    await expect(
      db.query(
        `INSERT INTO approval_automation_deliveries(
           organization_id,client_id,approval_request_id,kind,sequence,recipient_email
         ) VALUES($1,$2,$3,'REMINDER',1,'reviewer@example.test')`,
        [org, foreignClient, request],
      ),
    ).rejects.toThrow();
  });
  it("keeps privacy evidence and invitations after the requesting user is erased", async () => {
    const organization = crypto.randomUUID();
    const user = crypto.randomUUID();
    const request = crypto.randomUUID();
    const invitation = crypto.randomUUID();
    await db.query(
      `INSERT INTO organizations(id,name) VALUES($1,'privacy-evidence')`,
      [organization],
    );
    await db.query(
      `INSERT INTO "user"(id,name,email) VALUES($1,'privacy-user',$2)`,
      [user, `${user}@example.test`],
    );
    await db.query(
      `INSERT INTO privacy_requests(
         id,request_type,subject_user_id,requester_id,execute_after
       ) VALUES($1,'USER_ERASURE',$2,$2,now())`,
      [request, user],
    );
    await db.query(
      `INSERT INTO member_invitations(
         id,organization_id,email,role,token_hash,invited_by,expires_at
       ) VALUES($1,$2,$3,'VIEWER',$4,$5,now()+interval '1 day')`,
      [
        invitation,
        organization,
        `${invitation}@example.test`,
        crypto.randomUUID(),
        user,
      ],
    );

    await db.query(`DELETE FROM "user" WHERE id=$1`, [user]);
    expect(
      (
        await db.query(
          `SELECT subject_user_id,requester_id FROM privacy_requests WHERE id=$1`,
          [request],
        )
      ).rows[0],
    ).toEqual({ subject_user_id: user, requester_id: null });
    expect(
      (
        await db.query<{ invited_by: string | null }>(
          `SELECT invited_by FROM member_invitations WHERE id=$1`,
          [invitation],
        )
      ).rows[0].invited_by,
    ).toBeNull();
  });
  it("rejects analytics work assigned to a different social account", async () => {
    const organization = crypto.randomUUID();
    const client = crypto.randomUUID();
    const firstAccount = crypto.randomUUID();
    const secondAccount = crypto.randomUUID();
    const post = crypto.randomUUID();
    const target = crypto.randomUUID();
    await db.query(
      `INSERT INTO organizations(id,name) VALUES($1,'analytics-jobs')`,
      [organization],
    );
    await db.query(
      `INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')`,
      [client, organization],
    );
    await db.query(
      `INSERT INTO social_accounts(
         id,organization_id,client_id,platform,name,remote_id,mode
       ) VALUES($1,$3,$4,'facebook','one',$5,'mock'),
               ($2,$3,$4,'instagram','two',$6,'mock')`,
      [
        firstAccount,
        secondAccount,
        organization,
        client,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO posts(id,organization_id,client_id) VALUES($1,$2,$3)`,
      [post, organization, client],
    );
    await db.query(
      `INSERT INTO post_targets(
         id,organization_id,client_id,post_id,social_account_id,caption
       ) VALUES($1,$2,$3,$4,$5,'analytics')`,
      [target, organization, client, post, firstAccount],
    );
    await expect(
      db.query(
        `INSERT INTO analytics_sync_jobs(
           organization_id,client_id,social_account_id,target_id,kind,snapshot_day
         ) VALUES($1,$2,$3,$4,'POST',current_date)`,
        [organization, client, secondAccount, target],
      ),
    ).rejects.toThrow(/selected social account/);
    await expect(
      db.query(`DELETE FROM organizations WHERE id=$1`, [organization]),
    ).resolves.toBeDefined();
  });
});
