import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The web app can be deployed before migration 032 has run: everything except
// the portal itself has to keep working.
const db = new PGlite();
vi.mock("../packages/db", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { sql } = await import("drizzle-orm");
  const query = async (text: string, params?: unknown[]) => {
    const result = await db.query(text, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
    db: drizzle({ client: db }),
    sql,
  };
});
vi.mock("../packages/server/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => ({
        user: { id: headers.get("x-test-user"), name: "T", email: "t@x.test" },
      }),
    },
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: async () => true,
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://storage.test/x",
}));
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.S3_BUCKET = "test";
process.env.S3_MANAGE_BUCKET = "false";

const { createPost } = await import("../packages/server/posts");
const { executePublish } = await import("../packages/server/publishing");
const { usableMedia } = await import("../packages/server/client-media-rule");
const { exportUserData, processErasureRequests, processRetentionPolicies } =
  await import("../packages/server/privacy");
const { pool } = await import("../packages/db");
const hubRoute = await import("../apps/web/app/api/hub/route");
const uploadsRoute = await import("../apps/web/app/api/client-uploads/route");

const origin = new URL(process.env.APP_URL ?? "http://localhost:3010").origin;
const migrations = new URL("../packages/db/migrations/", import.meta.url);
beforeAll(async () => {
  for (const name of (await readdir(migrations)).sort())
    if (name < "032")
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
}, 60000);
afterAll(() => db.close());

it("works as before without the table, and notices it once it is there", async () => {
  const [org, client, account, media] = [1, 2, 3, 4].map(() =>
    crypto.randomUUID(),
  );
  const users = { OWNER: "", CLIENT_REVIEWER: "", VIEWER: "" };
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'a')", [org]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'c')",
    [client, org],
  );
  for (const role of Object.keys(users) as (keyof typeof users)[]) {
    const id = (users[role] = crypto.randomUUID());
    await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'n',$2)`, [
      id,
      `${id}@x.test`,
    ]);
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
      [org, id, role],
    );
    if (role !== "OWNER")
      await db.query(
        "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,$4)",
        [org, client, id, role],
      );
  }
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status)
     VALUES($1,$2,$3,'facebook','P','r','mock','CONNECTED')`,
    [account, org, client],
  );
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
     VALUES($1,$2,$3,'a.png','k','image/png',10,'READY')`,
    [media, org, client],
  );
  const get = async (
    route: { GET(r: Request): Promise<Response> },
    user: string,
    path: string,
  ) => {
    const response = await route.GET(
      new Request(`${origin}${path}`, { headers: { "x-test-user": user } }),
    );
    return { status: response.status, body: await response.json() };
  };

  for (const user of Object.values(users)) {
    const hub = await get(hubRoute, user, `/api/hub?clientId=${client}`);
    expect(hub.status).toBe(200);
    expect(hub.body.media).toHaveLength(1);
    expect(
      (
        await get(
          hubRoute,
          user,
          `/api/hub?clientId=${client}&mediaId=${media}`,
        )
      ).status,
    ).toBe(200);
  }
  const portal = await get(
    uploadsRoute,
    users.CLIENT_REVIEWER,
    `/api/client-uploads?clientId=${client}`,
  );
  expect(portal.status).toBe(503);
  expect(portal.body.code).toBe("CLIENT_MEDIA_UNAVAILABLE");
  const prepared = await uploadsRoute.POST(
    new Request(`${origin}/api/client-uploads`, {
      method: "POST",
      headers: { origin, "x-test-user": users.CLIENT_REVIEWER },
      body: JSON.stringify({
        action: "prepare",
        clientId: client,
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
      }),
    }),
  );
  expect(prepared.status).toBe(503);

  const post = await createPost(
    {
      organizationId: org,
      clientId: client,
      userId: users.OWNER,
      role: "OWNER",
    },
    {
      clientId: client,
      caption: "x",
      targets: [{ accountId: account, caption: "x", mediaIds: [media] }],
    },
  );
  const job = (
    await db.query<{ id: string }>(
      `INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at)
       SELECT organization_id,client_id,id,now()-interval '1 second' FROM post_targets WHERE post_id=$1
       RETURNING id`,
      [post.id],
    )
  ).rows[0];
  await executePublish(job.id);
  expect(
    (
      await db.query("SELECT status FROM post_targets WHERE post_id=$1", [
        post.id,
      ])
    ).rows,
  ).toEqual([{ status: "PUBLISHED" }]);

  expect((await exportUserData(users.VIEWER)).clientUploads).toEqual([]);
  await db.query(
    `INSERT INTO privacy_requests(request_type,subject_user_id,requester_id,execute_after)
     VALUES('USER_ERASURE',$1,$1,now()-interval '1 minute')`,
    [users.VIEWER],
  );
  expect(await processErasureRequests()).toEqual({ completed: 1, failed: 0 });
  expect(await processRetentionPolicies()).toEqual({ completed: 1, failed: 0 });

  // "Not there yet" is never remembered.
  expect(await usableMedia(pool, "m")).toBe("TRUE");
  await db.exec(
    await readFile(new URL("032_client_media_uploads.sql", migrations), "utf8"),
  );
  expect(await usableMedia(pool, "m")).toContain("client_media_uploads");
  expect(
    (
      await get(
        uploadsRoute,
        users.CLIENT_REVIEWER,
        `/api/client-uploads?clientId=${client}`,
      )
    ).status,
  ).toBe(200);
});
