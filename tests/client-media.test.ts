import { PGlite } from "@electric-sql/pglite";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = new PGlite();
// Statements of the code under test, and a hook that runs before each one.
const log: string[] = [];
let before: ((sql: string) => Promise<void>) | null = null;

vi.mock("../packages/db", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { sql } = await import("drizzle-orm");
  const query = async (text: string, params?: unknown[]) => {
    log.push(text);
    await before?.(text);
    const result = await db.query(text, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
  // One connection: a second transaction waits until the first has finished.
  let last = Promise.resolve();
  const connect = async () => {
    let release = () => {};
    const previous = last;
    last = new Promise<void>((resolve) => (release = resolve));
    await previous;
    return { query, release };
  };
  return { pool: { query, connect }, db: drizzle({ client: db }), sql };
});
vi.mock("../packages/server/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-user");
        return id ? { user: { id, name: "Test", email: "t@x.test" } } : null;
      },
    },
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: async () => true,
}));
// Storage is never reached: uploads exist once a test "puts" them.
const storage = vi.hoisted(() => ({
  objects: new Map<string, { size: number; type: string }>(),
  deleted: [] as string[],
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    async send(command: { constructor: { name: string }; input: unknown }) {
      const { Key } = command.input as { Key: string };
      if (command instanceof actual.HeadObjectCommand) {
        const object = storage.objects.get(Key);
        if (!object) throw Object.assign(new Error(), { name: "NotFound" });
        return { ContentLength: object.size, ContentType: object.type };
      }
      if (command instanceof actual.DeleteObjectCommand) {
        storage.deleted.push(Key);
        storage.objects.delete(Key);
      }
      return {};
    }
  }
  return { ...actual, S3Client };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_: unknown, command: { input: { Key: string } }) =>
    `https://storage.test/${command.input.Key}`,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.S3_BUCKET = "test";
process.env.S3_MANAGE_BUCKET = "false";

const { permissions } = await import("../packages/core/domain");
const {
  DAILY_UPLOAD_LIMIT,
  PENDING_UPLOAD_LIMIT,
  decideClientUpload,
  expireRejectedUploads,
} = await import("../packages/server/client-media");
const { createPost, schedulePost, publishabilityErrors } = await import(
  "../packages/server/posts"
);
const { editDraft } = await import("../packages/server/post-lifecycle");
const { executePublish } = await import("../packages/server/publishing");
const { approvalView } = await import("../packages/server/approvals");
const { gridMedia } = await import("../packages/server/instagram-grid");
const { completeMediaUpload, deleteMedia, mediaPreviewUrl } = await import(
  "../packages/server/media"
);
const { cleanupAbandonedUploads } = await import(
  "../packages/server/media-processing"
);
const { exportUserData, processErasureRequests, processRetentionPolicies } =
  await import("../packages/server/privacy");
const { transaction } = await import("../packages/server/transaction");
const { sendMail } = await import("../packages/server/mail");
const { namespaces } = await import("../apps/web/i18n/registry");
const uploadsRoute = await import("../apps/web/app/api/client-uploads/route");
const hubRoute = await import("../apps/web/app/api/hub/route");

const origin = new URL(process.env.APP_URL ?? "http://localhost:3010").origin;
const roles = [
  "OWNER",
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
] as const;
type Role = (typeof roles)[number];

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 60000);
afterAll(() => db.close());
beforeEach(() => {
  log.length = 0;
  storage.objects.clear();
  storage.deleted.length = 0;
});
afterEach(async () => {
  before = null;
  expect(sendMail).not.toHaveBeenCalled();
  expect((await db.query("SELECT 1 FROM notifications")).rows).toEqual([]);
});

async function insertUser(name: string) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)`, [
    id,
    name,
    `${id}@secret.test`,
  ]);
  return id;
}
async function insertClient(org: string) {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
    [id, org],
  );
  return id;
}
async function join(
  org: string,
  client: string,
  user: string,
  role: Role,
  member = true,
) {
  if (member)
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
      [org, user, role],
    );
  if (role !== "OWNER" && role !== "ADMIN")
    await db.query(
      "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,$4)",
      [org, client, user, role],
    );
}
async function workspace() {
  const org = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  const client = await insertClient(org);
  const users = {} as Record<Role, string>;
  for (const role of roles) {
    users[role] = await insertUser(role);
    await join(org, client, users[role], role);
  }
  const account = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status)
     VALUES($1,$2,$3,'facebook','Page',$4,'mock','CONNECTED')`,
    [account, org, client, account],
  );
  const c = (role: Role, userId = users[role]) => ({
    organizationId: org,
    clientId: client,
    userId,
    role,
  });
  return { org, client, users, account, c };
}
type W = Awaited<ReturnType<typeof workspace>>;

async function request(
  route: {
    GET(r: Request): Promise<Response>;
    POST(r: Request): Promise<Response>;
  },
  user: string,
  path: string,
  body?: unknown,
) {
  const response = await (body === undefined ? route.GET : route.POST)(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "x-test-user": user },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}
const file = { name: "kep.png", mimeType: "image/png", sizeBytes: 10 };
const portal = (w: W, user: string, action: string, body: object = {}) =>
  request(uploadsRoute, user, "/api/client-uploads", {
    action,
    clientId: w.client,
    ...body,
  });
const prepare = (w: W, user: string, body: object = {}) =>
  portal(w, user, "prepare", { ...file, ...body });
const list = (w: W, user: string, query = "", client = w.client) =>
  request(uploadsRoute, user, `/api/client-uploads?clientId=${client}${query}`);
const decide = (
  w: W,
  user: string,
  id: string,
  decision: "accept" | "reject",
  expectedStatus: string,
  reason?: string,
) => portal(w, user, "decide", { id, decision, expectedStatus, reason });
const hub = (w: W, user: string, query = "") =>
  request(hubRoute, user, `/api/hub?clientId=${w.client}${query}`);
const hubAction = (w: W, user: string, action: string, body: object = {}) =>
  request(hubRoute, user, "/api/hub", { action, clientId: w.client, ...body });

// A portal upload the worker has already finished.
async function uploaded(
  w: W,
  user = w.users.CLIENT_REVIEWER,
  status: "PENDING" | "ACCEPTED" | "REJECTED" = "PENDING",
  assetStatus = "READY",
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,preview_object_key,mime_type,size_bytes,status)
     VALUES($1,$2,$3,'titkos-fajlnev.png',$4,$5,'image/png',10,$6)`,
    [
      id,
      w.org,
      w.client,
      `${w.org}/${w.client}/ready/${id}`,
      `${w.org}/${w.client}/previews/${id}.jpg`,
      assetStatus,
    ],
  );
  await db.query(
    `INSERT INTO client_media_uploads(media_asset_id,organization_id,client_id,uploaded_by,note,status,decision_reason,decided_at)
     VALUES($1,$2,$3,$4,'titkos megjegyzés',$5,$6,$7)`,
    [
      id,
      w.org,
      w.client,
      user,
      status,
      status === "REJECTED" ? "titkos indok" : null,
      status === "PENDING" ? null : new Date(),
    ],
  );
  return id;
}
async function normalMedia(w: W, createdAt = new Date()) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status,created_at)
     VALUES($1,$2,$3,'sajat.png',$4,'image/png',10,'READY',$5)`,
    [id, w.org, w.client, `${w.org}/${id}`, createdAt],
  );
  return id;
}
// A post that already carries the file, however it got there.
async function postWith(w: W, media: string, status = "APPROVED") {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO posts(id,organization_id,client_id,caption,status) VALUES($1,$2,$3,'x',$4)",
    [id, w.org, w.client, status],
  );
  const target = (
    await db.query<{ id: string }>(
      `INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids)
       VALUES($1,$2,$3,$4,'x',$5) RETURNING id`,
      [w.org, w.client, id, w.account, [media]],
    )
  ).rows[0].id;
  return { id, target };
}
const draft = (w: W, mediaIds: string[]) => ({
  clientId: w.client,
  caption: "Szöveg",
  targets: [{ accountId: w.account, caption: "Szöveg", mediaIds }],
});
const row = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM client_media_uploads WHERE media_asset_id=$1",
      [id],
    )
  ).rows[0];
const asset = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM media_assets WHERE id=$1",
      [id],
    )
  ).rows[0];
const auditRows = async (id: string) =>
  (
    await db.query<{ action: string; metadata: object }>(
      "SELECT action,metadata FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
      [id],
    )
  ).rows;

describe("migration 032", () => {
  it("only creates its own table and indexes and is registered", async () => {
    const sql = await readFile(
      new URL(
        "../packages/db/migrations/032_client_media_uploads.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).not.toMatch(/\b(ALTER|DROP|TRIGGER|FUNCTION|INSERT|UPDATE)\b/);
    expect(sql.match(/^CREATE TABLE \w+/gm)).toEqual([
      "CREATE TABLE client_media_uploads",
    ]);
    for (const [, table] of sql.matchAll(/CREATE INDEX \w+\s+ON (\w+)/g))
      expect(table).toBe("client_media_uploads");
    expect(
      await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8"),
    ).toContain('"032_client_media_uploads.sql"');
  });

  it("refuses a row bound to a foreign client", async () => {
    const w = await workspace();
    const media = await normalMedia(w);
    const other = await insertClient(w.org);
    const foreign = await workspace();
    for (const [org, client] of [
      [w.org, other],
      [foreign.org, foreign.client],
      [foreign.org, w.client],
    ])
      await expect(
        db.query(
          "INSERT INTO client_media_uploads(media_asset_id,organization_id,client_id) VALUES($1,$2,$3)",
          [media, org, client],
        ),
      ).rejects.toThrow(/foreign key/);
  });
});

describe("who may do what", () => {
  it("keeps the permission matrix as it was", () => {
    expect(permissions.CLIENT_REVIEWER).toEqual(["read", "approve"]);
    expect(permissions.VIEWER).toEqual(["read"]);
  });

  it("lets only CLIENT_REVIEWER upload on the portal", async () => {
    const w = await workspace();
    for (const role of roles) {
      const id = await uploaded(w, w.users[role]);
      const expected = role === "CLIENT_REVIEWER" ? 200 : 403;
      expect((await prepare(w, w.users[role])).status).toBe(expected);
      expect((await portal(w, w.users[role], "complete", { id })).status).toBe(
        expected,
      );
      expect((await portal(w, w.users[role], "withdraw", { id })).status).toBe(
        expected,
      );
    }
    for (const role of ["CLIENT_REVIEWER", "VIEWER"] as const) {
      const id = await uploaded(w);
      expect(
        (await decide(w, w.users[role], id, "accept", "PENDING")).status,
      ).toBe(403);
    }
    expect((await list(w, w.users.VIEWER)).status).toBe(403);
  });

  it("gives CLIENT_REVIEWER no other create action", async () => {
    const w = await workspace();
    const own = await uploaded(w);
    for (const [action, body] of [
      ["media.delete", { id: own }],
      ["media.upload.prepare", file],
      ["media.upload.complete", { id: own }],
      ["post.create", draft(w, [])],
      ["post.edit", { id: own, ...draft(w, []) }],
      ["post.submit", { id: own }],
      ["post.schedule", { id: own }],
      ["post.cancel", { id: own }],
      ["post.review.remind", { id: own }],
      ["ai.generate", { operation: "generate", text: "x" }],
      ["ai.check", { text: "x" }],
      ["ai.apply", { id: own }],
      ["hashtags.save", { name: "x", hashtags: ["#x"] }],
      ["templates.save", { name: "x", body: "x" }],
      ["brand.save", { brand: {} }],
    ] as const)
      expect(
        (await hubAction(w, w.users.CLIENT_REVIEWER, action, body)).status,
        action,
      ).toBe(403);
    expect(await asset(own)).toMatchObject({ status: "READY" });
  });

  it("answers 404 for a foreign organization or client", async () => {
    const w = await workspace();
    const foreign = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    const other = await insertClient(w.org);
    const id = await uploaded(foreign);
    for (const client of [foreign.client, other, crypto.randomUUID()]) {
      expect((await list(w, reviewer, "", client)).status).toBe(404);
      expect((await prepare(w, reviewer, { clientId: client })).status).toBe(
        404,
      );
    }
    expect((await portal(w, reviewer, "withdraw", { id })).status).toBe(404);
    expect((await portal(w, reviewer, "complete", { id })).status).toBe(404);
    expect(
      (await decide(w, w.users.OWNER, id, "accept", "PENDING")).status,
    ).toBe(404);
    expect((await row(id)).status).toBe("PENDING");
  });
});

describe("uploading", () => {
  it("stores the upload undecided with its note and hands it to the worker", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    const prepared = await prepare(w, reviewer, { note: "  A tavaszi fotó  " });
    expect(prepared.status).toBe(200);
    expect(prepared.headers.get("cache-control")).toBe("no-store");
    const { id } = prepared.body;
    expect(await row(id)).toMatchObject({
      status: "PENDING",
      note: "A tavaszi fotó",
      uploaded_by: reviewer,
    });
    expect((await portal(w, reviewer, "complete", { id })).body.code).toBe(
      "UPLOAD_INCOMPLETE",
    );
    storage.objects.set(`${w.org}/${w.client}/incoming/${id}`, {
      size: 10,
      type: "image/png",
    });
    expect((await portal(w, reviewer, "complete", { id })).body).toEqual({
      id,
      status: "PROCESSING",
    });
    expect(
      (
        await db.query(
          "SELECT status FROM media_processing_jobs WHERE media_asset_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ status: "PENDING" }]);
    expect(await auditRows(id)).toEqual([
      { action: "media.upload_prepared", metadata: {} },
      { action: "media.upload_completed", metadata: {} },
    ]);
  });

  it("accepts the known types, 20 MB and a 1000 character note at most", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/mp4",
      "video/quicktime",
    ])
      expect((await prepare(w, reviewer, { mimeType })).status).toBe(200);
    expect(
      (
        await prepare(w, reviewer, {
          sizeBytes: 20 * 1024 * 1024,
          note: "x".repeat(1000),
        })
      ).status,
    ).toBe(200);
    for (const bad of [
      { mimeType: "application/pdf" },
      { mimeType: "image/svg+xml" },
      { sizeBytes: 20 * 1024 * 1024 + 1 },
      { sizeBytes: 0 },
      { note: "x".repeat(1001) },
      { note: "a\0b" },
      { name: " " },
    ])
      expect((await prepare(w, reviewer, bad)).status).toBe(422);
  });

  it("completes only the uploader's own portal upload", async () => {
    const w = await workspace();
    const other = await insertUser("Másik");
    await join(w.org, w.client, other, "CLIENT_REVIEWER");
    const { id } = (await prepare(w, w.users.CLIENT_REVIEWER)).body;
    storage.objects.set(`${w.org}/${w.client}/incoming/${id}`, {
      size: 10,
      type: "image/png",
    });
    expect((await portal(w, other, "complete", { id })).status).toBe(404);
    const normal = await normalMedia(w);
    expect(
      (await portal(w, w.users.CLIENT_REVIEWER, "complete", { id: normal }))
        .status,
    ).toBe(404);
    // Not even the team can complete it in the uploader's place.
    expect(
      (await hubAction(w, w.users.OWNER, "media.upload.complete", { id }))
        .status,
    ).toBe(404);
    expect((await asset(id)).status).toBe("UPLOADING");
    // Ownership is checked again under the lock.
    before = async (sql) => {
      if (!sql.includes("FOR UPDATE")) return;
      before = null;
      await db.query(
        "UPDATE client_media_uploads SET uploaded_by=NULL WHERE media_asset_id=$1",
        [id],
      );
    };
    await expect(
      completeMediaUpload(w.c("CLIENT_REVIEWER"), id, true),
    ).rejects.toMatchObject({ status: 404 });
    expect((await asset(id)).status).toBe("UPLOADING");
  });

  it("leaves the team's own upload as it was", async () => {
    const w = await workspace();
    const { body } = await hubAction(
      w,
      w.users.CONTENT_CREATOR,
      "media.upload.prepare",
      file,
    );
    expect(await row(body.id)).toBeUndefined();
    storage.objects.set(`${w.org}/${w.client}/incoming/${body.id}`, {
      size: 10,
      type: "image/png",
    });
    expect(
      (
        await hubAction(w, w.users.CONTENT_CREATOR, "media.upload.complete", {
          id: body.id,
        })
      ).body.status,
    ).toBe("PROCESSING");
    expect(log.some((sql) => sql.includes("advisory"))).toBe(false);
  });
});

describe("limits", () => {
  it("holds 50 undecided files per client against parallel requests", async () => {
    const w = await workspace();
    const second = await insertUser("Második");
    await join(w.org, w.client, second, "CLIENT_REVIEWER");
    const ids: string[] = [];
    for (let i = 0; i < PENDING_UPLOAD_LIMIT - 2; i++)
      ids.push(await uploaded(w));
    // Decided files do not count.
    await uploaded(w, second, "ACCEPTED");
    await uploaded(w, second, "REJECTED");
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        prepare(w, n % 2 ? second : w.users.CLIENT_REVIEWER),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 200, 409, 409, 409, 409,
    ]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe(
      "CLIENT_MEDIA_PENDING_LIMIT",
    );
    const full = async () => (await prepare(w, second)).status === 409;
    expect(await full()).toBe(true);

    // A failed, an expired, a withdrawn and a deleted one each free a place.
    await db.query("UPDATE media_assets SET status='FAILED' WHERE id=$1", [
      ids[0],
    ]);
    expect(await full()).toBe(false);
    expect(await full()).toBe(true);
    await db.query(
      "UPDATE media_assets SET status='UPLOADING',created_at=now()-interval '2 hours' WHERE id=$1",
      [ids[1]],
    );
    expect(await full()).toBe(true);
    await cleanupAbandonedUploads();
    expect(await full()).toBe(false);
    expect(await full()).toBe(true);
    await portal(w, w.users.CLIENT_REVIEWER, "withdraw", { id: ids[2] });
    expect(await full()).toBe(false);
    expect(await full()).toBe(true);
    await deleteMedia(w.c("OWNER"), ids[3]);
    expect(await full()).toBe(false);
    expect(await full()).toBe(true);
    // Another client is not affected.
    const other = await insertClient(w.org);
    await join(w.org, other, second, "CLIENT_REVIEWER", false);
    expect((await prepare(w, second, { clientId: other })).status).toBe(200);
  });

  it("holds the daily limit per person across clients, withdrawn ones included", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    const other = await insertClient(w.org);
    await join(w.org, other, reviewer, "CLIENT_REVIEWER", false);
    for (let i = 0; i < DAILY_UPLOAD_LIMIT - 1; i++)
      await uploaded(w, reviewer, "ACCEPTED");
    const old = await uploaded(w, reviewer, "ACCEPTED");
    await db.query(
      "UPDATE client_media_uploads SET created_at=now()-interval '25 hours' WHERE media_asset_id=$1",
      [old],
    );
    const results = await Promise.all(
      [other, w.client, other].map((clientId) =>
        prepare(w, reviewer, { clientId }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const { id, clientId } = {
      id: results.find((r) => r.status === 200)!.body.id,
      clientId:
        results[0].status === 200 || results[2].status === 200
          ? other
          : w.client,
    };
    await db.query("UPDATE media_assets SET status='READY' WHERE id=$1", [id]);
    expect(
      (await portal(w, reviewer, "withdraw", { id, clientId })).status,
    ).toBe(200);
    expect((await prepare(w, reviewer)).body.code).toBe(
      "CLIENT_MEDIA_DAILY_LIMIT",
    );
    const fresh = await insertUser("Friss");
    await join(w.org, w.client, fresh, "CLIENT_REVIEWER");
    expect((await prepare(w, fresh)).status).toBe(200);
  });

  it("locks user, then client, before counting and inserting", async () => {
    const w = await workspace();
    log.length = 0;
    await prepare(w, w.users.CLIENT_REVIEWER);
    const steps = log.slice(log.indexOf("BEGIN"));
    const at = (text: string) => steps.findIndex((sql) => sql.includes(text));
    expect(steps.filter((sql) => sql.includes("advisory_xact"))).toHaveLength(
      2,
    );
    expect(at("advisory_xact")).toBe(1);
    expect(at("count(*)")).toBe(3);
    expect(at("INSERT INTO client_media_uploads")).toBeGreaterThan(4);
    expect(at("COMMIT")).toBeGreaterThan(
      at("INSERT INTO client_media_uploads"),
    );
  });
});

describe("undecided and rejected files cannot be used", () => {
  for (const status of ["PENDING", "REJECTED"] as const)
    it(`refuses ${status} files on every way into a post`, async () => {
      const w = await workspace();
      const c = w.c("OWNER");
      const bad = await uploaded(w, undefined, status);
      const good = await uploaded(w, undefined, "ACCEPTED");
      const normal = await normalMedia(w);

      for (const mediaIds of [[bad], [normal, bad]])
        await expect(createPost(c, draft(w, mediaIds))).rejects.toMatchObject({
          code: "INVALID_MEDIA",
        });
      const post = await createPost(c, draft(w, [normal, good]));
      await expect(
        editDraft(c, post.id, draft(w, [bad])),
      ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
      await editDraft(c, post.id, draft(w, [good]));

      const { id, target } = await postWith(w, bad);
      const errors = await transaction((tx) =>
        publishabilityErrors(tx, c, { id, link: null }),
      );
      expect(errors.errors).toEqual(["facebook: An attachment is missing."]);
      await expect(
        schedulePost(c, id, new Date(Date.now() + 60_000).toISOString()),
      ).rejects.toMatchObject({ status: 422 });

      await db.query("UPDATE posts SET status='SCHEDULED' WHERE id=$1", [id]);
      await db.query("UPDATE post_targets SET status='QUEUED' WHERE id=$1", [
        target,
      ]);
      const job = (
        await db.query<{ id: string; idempotency_key: string }>(
          `INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at)
           VALUES($1,$2,$3,now()-interval '1 second') RETURNING id,idempotency_key`,
          [w.org, w.client, target],
        )
      ).rows[0];
      await executePublish(job.id);
      expect(
        (
          await db.query(
            "SELECT status,error_code FROM post_targets WHERE id=$1",
            [target],
          )
        ).rows,
      ).toEqual([{ status: "FAILED", error_code: "INVALID_MEDIA" }]);
      expect(
        (
          await db.query(
            "SELECT 1 FROM mock_receipts WHERE idempotency_key=$1",
            [job.idempotency_key],
          )
        ).rows,
      ).toEqual([]);
      const { pool } = await import("../packages/db");
      const covers = await gridMedia(
        pool as never,
        { organizationId: w.org, clientId: w.client },
        [{ mediaIds: [bad] }, { mediaIds: [good] }] as never,
      );
      expect([...covers.keys()]).toEqual([good]);
      // The usual notice about the failed post; it names no upload.
      expect(
        (
          await db.query(
            "DELETE FROM notifications WHERE resource_id=$1 RETURNING message",
            [id],
          )
        ).rows,
      ).toHaveLength(1);
    });

  it("leaves it out of the public approval page", async () => {
    const w = await workspace();
    const media = await uploaded(w, undefined, "ACCEPTED");
    const post = await createPost(w.c("OWNER"), draft(w, [media]));
    const token = randomBytes(16).toString("hex");
    await db.query(
      `INSERT INTO approval_requests(organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind)
       VALUES($1,$2,$3,1,$4,now()+interval '1 day','EXTERNAL')`,
      [
        w.org,
        w.client,
        post.id,
        createHash("sha256").update(token).digest("hex"),
      ],
    );
    expect((await approvalView(token)).versions[0].media).toHaveLength(1);
    await db.query("UPDATE client_media_uploads SET status='PENDING'");
    expect((await approvalView(token)).versions[0].media).toEqual([]);
  });

  it("has one condition, on every query that reads media for use", async () => {
    // Queries that must see every asset: upload, worker, deletion, privacy.
    const unfiltered: Record<string, number> = {
      "packages/server/media.ts": 4,
      "packages/server/media-processing.ts": 2,
      "packages/server/privacy.ts": 3,
      "packages/server/client-media.ts": 1,
    };
    const found: Record<string, number> = {};
    const root = new URL("../", import.meta.url);
    for (const folder of ["packages/server", "apps/web/app", "apps/worker"])
      for (const name of await readdir(new URL(folder, root), {
        recursive: true,
      })) {
        if (!/\.tsx?$/.test(name)) continue;
        const path = `${folder}/${name.replaceAll("\\", "/")}`;
        const source = await readFile(new URL(path, root), "utf8");
        for (const match of source.matchAll(/FROM media_assets\b/g)) {
          const rest = source.slice(match.index, match.index + 330);
          if (!/AND \$\{(usable|condition|await usableMedia)/.test(rest))
            found[path] = (found[path] ?? 0) + 1;
        }
        // The rule itself is written down once.
        if (path !== "packages/server/client-media-rule.ts")
          expect(source, path).not.toContain("<>'ACCEPTED'");
      }
    expect(found).toEqual(unfiltered);
    // These never read stored media, so there is nothing to filter.
    for (const name of ["api-v1-posts", "calendar-import", "ai"]) {
      const source = await readFile(
        new URL(`packages/server/${name}.ts`, root),
        "utf8",
      );
      expect(source).not.toMatch(/media_assets|media_ids/);
      for (const [value] of source.matchAll(/mediaIds:.*/g))
        expect(value).toBe("mediaIds: [],");
    }
  });
});

describe("the hub media list", () => {
  it("offers accepted files only, and undecided ones never crowd it", async () => {
    const w = await workspace();
    const usable: string[] = [];
    for (let i = 0; i < 3; i++)
      usable.push(await normalMedia(w, new Date(Date.now() - 3_600_000)));
    usable.push(await uploaded(w, undefined, "ACCEPTED"));
    for (let i = 0; i < 60; i++)
      await uploaded(w, undefined, i % 2 ? "PENDING" : "REJECTED");
    for (const role of roles) {
      const { body } = await hub(w, w.users[role]);
      expect(body.media.map((m: { id: string }) => m.id).sort()).toEqual(
        [...usable].sort(),
      );
    }
  });

  it("signs undecided files for the team and their uploader alone", async () => {
    const w = await workspace();
    const other = await insertUser("Másik");
    await join(w.org, w.client, other, "CLIENT_REVIEWER");
    for (const status of ["PENDING", "REJECTED"] as const) {
      const id = await uploaded(w, undefined, status);
      const url = async (user: string) =>
        (await hub(w, user, `&mediaId=${id}`)).status;
      for (const role of roles)
        expect(await url(w.users[role]), role).toBe(
          role === "VIEWER" ? 404 : 200,
        );
      expect(await url(other)).toBe(404);
      expect(
        await mediaPreviewUrl(w.c("CLIENT_REVIEWER", other), id),
      ).toBeUndefined();
      // Uploaded as a reviewer, but only a viewer now.
      const former = await uploaded(w, w.users.VIEWER, status);
      expect((await hub(w, w.users.VIEWER, `&mediaId=${former}`)).status).toBe(
        404,
      );
    }
    const accepted = await uploaded(w, undefined, "ACCEPTED");
    expect((await hub(w, w.users.VIEWER, `&mediaId=${accepted}`)).status).toBe(
      200,
    );
  });
});

describe("deciding", () => {
  it("lists uploads for the team by state and in pages, without e-mail", async () => {
    const w = await workspace();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await uploaded(w));
    await uploaded(w, undefined, "PENDING", "FAILED");
    const rejected = await uploaded(w, undefined, "REJECTED");
    const first = await list(w, w.users.CONTENT_CREATOR);
    expect(first.body.pending).toBe(30);
    expect(first.body.items).toHaveLength(24);
    expect(first.body.items[0]).toMatchObject({
      uploader_name: "CLIENT_REVIEWER",
      note: "titkos megjegyzés",
      status: "PENDING",
    });
    const second = await list(
      w,
      w.users.CONTENT_CREATOR,
      `&before=${first.body.nextCursor}`,
    );
    expect(second.body.nextCursor).toBeNull();
    expect(
      [...first.body.items, ...second.body.items]
        .map((i: { id: string }) => i.id)
        .sort(),
    ).toEqual(ids.sort());
    expect(JSON.stringify(first.body)).not.toMatch(/@|object_key|decided_by/);
    expect(
      (await list(w, w.users.OWNER, "&status=REJECTED")).body.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([rejected]);
    expect((await list(w, w.users.OWNER, "&status=ALL")).status).toBe(422);
  });

  it("accepts, rejects with a reason and accepts again, with audit", async () => {
    const w = await workspace();
    const id = await uploaded(w);
    const team = w.users.CONTENT_CREATOR;
    expect(
      (await decide(w, team, id, "reject", "PENDING", "  Életlen  ")).body,
    ).toEqual({ id, status: "REJECTED" });
    expect(await row(id)).toMatchObject({
      decision_reason: "Életlen",
      decided_by: team,
    });
    expect((await asset(id)).deleted_at).toBeNull();
    expect(storage.deleted).toEqual([]);
    const own = await list(w, w.users.CLIENT_REVIEWER);
    expect(own.body.items[0]).toMatchObject({
      status: "REJECTED",
      reason: "Életlen",
    });
    expect((await decide(w, team, id, "accept", "REJECTED")).status).toBe(200);
    expect(await row(id)).toMatchObject({
      status: "ACCEPTED",
      decision_reason: null,
    });
    await createPost(w.c("OWNER"), draft(w, [id]));
    const events = await auditRows(id);
    expect(events).toEqual([
      {
        action: "client_media.rejected",
        metadata: { previousStatus: "PENDING" },
      },
      {
        action: "client_media.accepted",
        metadata: { previousStatus: "REJECTED" },
      },
    ]);
    expect(
      (await decide(w, team, id, "reject", "ACCEPTED", "x".repeat(501))).status,
    ).toBe(422);
  });

  it("lets only one of two decisions through", async () => {
    const w = await workspace();
    const id = await uploaded(w);
    const results = await Promise.all([
      decide(w, w.users.OWNER, id, "accept", "PENDING"),
      decide(w, w.users.ADMIN, id, "reject", "PENDING"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const decided = await row(id);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body.code).toBe("CLIENT_MEDIA_CONFLICT");
    // A stale view and a repeated decision are conflicts as well.
    expect(
      (await decide(w, w.users.OWNER, id, "accept", "PENDING")).status,
    ).toBe(409);
    expect(
      (
        await decide(
          w,
          w.users.OWNER,
          id,
          decided.status === "ACCEPTED" ? "accept" : "reject",
          String(decided.status),
        )
      ).status,
    ).toBe(409);
    expect(await row(id)).toEqual(decided);
  });

  it("decides only finished, existing portal uploads", async () => {
    const w = await workspace();
    for (const status of ["UPLOADING", "PROCESSING", "FAILED"]) {
      const id = await uploaded(w, undefined, "PENDING", status);
      expect(
        (await decide(w, w.users.OWNER, id, "accept", "PENDING")).body.code,
      ).toBe("CLIENT_MEDIA_NOT_READY");
    }
    const normal = await normalMedia(w);
    expect(
      (await decide(w, w.users.OWNER, normal, "reject", "PENDING")).status,
    ).toBe(404);
    const deleted = await uploaded(w);
    expect(
      (await hubAction(w, w.users.OWNER, "media.delete", { id: deleted }))
        .status,
    ).toBe(200);
    expect(
      (await decide(w, w.users.OWNER, deleted, "accept", "PENDING")).status,
    ).toBe(404);
    const own = await list(w, w.users.CLIENT_REVIEWER);
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(3);
  });

  it("does not reject a file a post uses, whatever the post's state", async () => {
    const w = await workspace();
    for (const status of ["DRAFT", "CANCELLED", "PUBLISHED"]) {
      const id = await uploaded(w, undefined, "ACCEPTED");
      const post = await postWith(w, id, status);
      expect(
        (await decide(w, w.users.OWNER, id, "reject", "ACCEPTED")).body.code,
      ).toBe("MEDIA_IN_USE");
      expect((await row(id)).status).toBe("ACCEPTED");
      await db.query("UPDATE posts SET deleted_at=now() WHERE id=$1", [
        post.id,
      ]);
      expect(
        (await decide(w, w.users.OWNER, id, "reject", "ACCEPTED")).status,
      ).toBe(200);
    }
  });

  it("checks use after both locks, so attaching in the meantime wins", async () => {
    const w = await workspace();
    const id = await uploaded(w, undefined, "ACCEPTED");
    log.length = 0;
    // What a post saved while the rejection waited for the row looks like.
    before = async (sql) => {
      if (!/client_media_uploads WHERE[^]*FOR UPDATE/.test(sql)) return;
      before = null;
      await postWith(w, id, "DRAFT");
    };
    await expect(
      decideClientUpload(w.c("OWNER"), {
        clientId: w.client,
        id,
        decision: "reject",
        expectedStatus: "ACCEPTED",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_IN_USE" });
    const at = (text: string) => log.findIndex((sql) => sql.includes(text));
    expect(at("FROM media_assets")).toBeLessThan(
      at("FROM client_media_uploads"),
    );
    expect(at("FROM client_media_uploads")).toBeLessThan(
      at("FROM post_targets"),
    );
  });

  it("locks portal rows before reading media, so a rejection in the meantime wins", async () => {
    const w = await workspace();
    const c = w.c("OWNER");
    const save = async (run: (id: string) => Promise<unknown>) => {
      const id = await uploaded(w, undefined, "ACCEPTED");
      log.length = 0;
      before = async (sql) => {
        if (!sql.includes("FOR SHARE")) return;
        expect(sql).toContain("ORDER BY media_asset_id");
        expect(log.some((text) => text.includes("FROM media_assets"))).toBe(
          false,
        );
        before = null;
        await db.query(
          "UPDATE client_media_uploads SET status='REJECTED' WHERE media_asset_id=$1",
          [id],
        );
      };
      await expect(run(id)).rejects.toMatchObject({ status: 422 });
      expect(before).toBeNull();
    };
    await save((id) => createPost(c, draft(w, [id])));
    const post = await createPost(c, draft(w, []));
    await save((id) => editDraft(c, post.id, draft(w, [id])));
    await save(async (id) => {
      const { id: postId } = await postWith(w, id);
      return schedulePost(
        c,
        postId,
        new Date(Date.now() + 60_000).toISOString(),
      );
    });
  });
});

describe("what the client sees", () => {
  it("lists only the reviewer's own uploads, without team data", async () => {
    const w = await workspace();
    const other = await insertUser("Másik");
    await join(w.org, w.client, other, "CLIENT_REVIEWER");
    const mine = await uploaded(w);
    const failed = await uploaded(w, undefined, "PENDING", "FAILED");
    await uploaded(w, other, "REJECTED");
    await decide(w, w.users.OWNER, mine, "reject", "PENDING", "Rossz arány");
    const { body } = await list(w, w.users.CLIENT_REVIEWER, "&status=ACCEPTED");
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [mine, failed].sort(),
    );
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "asset_status",
      "created_at",
      "height",
      "id",
      "mime_type",
      "name",
      "note",
      "reason",
      "size_bytes",
      "status",
      "width",
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("titkos indok");
    expect(text).not.toContain(w.users.OWNER);
    expect(text).not.toContain("@");
  });

  it("withdraws the reviewer's own undecided file and its objects", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    for (const status of ["READY", "FAILED"]) {
      storage.deleted.length = 0;
      const id = await uploaded(w, reviewer, "PENDING", status);
      expect((await portal(w, reviewer, "withdraw", { id })).status).toBe(200);
      const base = `${w.org}/${w.client}`;
      expect([...storage.deleted].sort()).toEqual([
        `${base}/incoming/${id}`,
        `${base}/previews/${id}.jpg`,
        `${base}/publish/${id}-instagram.jpg`,
        `${base}/ready/${id}`,
      ]);
      expect((await asset(id)).deleted_at).not.toBeNull();
      expect(await row(id)).toMatchObject({
        note: null,
        uploaded_by: reviewer,
      });
      expect(await auditRows(id)).toEqual([
        { action: "client_media.withdrawn", metadata: {} },
      ]);
      expect((await portal(w, reviewer, "withdraw", { id })).status).toBe(404);
    }
    expect((await list(w, reviewer)).body.items).toEqual([]);
  });

  it("withdraws nothing else", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    const other = await insertUser("Másik");
    await join(w.org, w.client, other, "CLIENT_REVIEWER");
    const code = async (id: string) => {
      const { status, body } = await portal(w, reviewer, "withdraw", { id });
      return `${status} ${body.code}`;
    };
    expect(await code(await uploaded(w, other))).toBe("404 NOT_FOUND");
    expect(await code(await normalMedia(w))).toBe("404 NOT_FOUND");
    for (const status of ["ACCEPTED", "REJECTED"] as const)
      expect(await code(await uploaded(w, reviewer, status))).toBe(
        "409 CLIENT_MEDIA_DECIDED",
      );
    for (const status of ["UPLOADING", "PROCESSING"])
      expect(await code(await uploaded(w, reviewer, "PENDING", status))).toBe(
        "409 CLIENT_MEDIA_BUSY",
      );
    expect(storage.deleted).toEqual([]);
  });

  it("keeps other people's uploads out of the audit list", async () => {
    const w = await workspace();
    const other = await insertUser("Másik");
    await join(w.org, w.client, other, "CLIENT_REVIEWER");
    const event = (action: string, resource: string | null) =>
      db.query(
        "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,created_at) VALUES($1,$2,$3,$4,now()-interval '1 hour')",
        [w.org, w.client, action, resource],
      );
    const mine = await uploaded(w);
    const theirs = await uploaded(w, other, "ACCEPTED");
    const orphan = await uploaded(w, other);
    const viewers = await uploaded(w, w.users.VIEWER);
    const normal = await normalMedia(w);
    await event("media.ready", mine);
    await event("media.ready", normal);
    await event("client.updated", null);
    await db.query(
      "UPDATE client_media_uploads SET uploaded_by=NULL WHERE media_asset_id=$1",
      [orphan],
    );
    // More hidden rows than the list is long: filtered before the limit.
    for (let i = 0; i < 20; i++)
      for (const id of [theirs, orphan, viewers])
        await db.query(
          "INSERT INTO audit_logs(organization_id,client_id,action,resource_id) VALUES($1,$2,$3,$4)",
          [
            w.org,
            w.client,
            i % 2 ? "media.ready" : "client_media.rejected",
            id,
          ],
        );
    const seen = async (role: Role) =>
      (await hub(w, w.users[role])).body.audit.map(
        (a: { resource_id: string }) => a.resource_id,
      );
    expect((await seen("CLIENT_REVIEWER")).sort()).toEqual(
      [mine, normal, null].sort(),
    );
    expect((await seen("VIEWER")).sort()).toEqual([normal, null].sort());
    expect(await seen("CONTENT_CREATOR")).toHaveLength(50);
    expect(log.some((sql) => sql.includes("resource_id::uuid"))).toBe(false);
    for (const role of roles)
      expect(JSON.stringify((await hub(w, w.users[role])).body)).not.toMatch(
        /titkos (megjegyzés|indok)/,
      );
  });
});

describe("privacy", () => {
  it("exports the person's own uploads without storage keys", async () => {
    const w = await workspace();
    const id = await uploaded(w, undefined, "REJECTED");
    await uploaded(w, w.users.VIEWER);
    const { clientUploads } = await exportUserData(w.users.CLIENT_REVIEWER);
    expect(clientUploads).toMatchObject([
      {
        id,
        name: "titkos-fajlnev.png",
        mime_type: "image/png",
        note: "titkos megjegyzés",
        status: "REJECTED",
        decision_reason: "titkos indok",
      },
    ]);
    expect(JSON.stringify(clientUploads)).not.toMatch(/ready\/|previews\//);
  });

  it("cuts the uploader and the decider loose when they are erased", async () => {
    const w = await workspace();
    const reviewer = w.users.CLIENT_REVIEWER;
    const id = await uploaded(w);
    await decide(w, w.users.CONTENT_CREATOR, id, "accept", "PENDING");
    for (const user of [reviewer, w.users.CONTENT_CREATOR])
      await db.query(
        `INSERT INTO privacy_requests(request_type,subject_user_id,requester_id,execute_after)
         VALUES('USER_ERASURE',$1,$1,now()-interval '1 minute')`,
        [user],
      );
    expect(await processErasureRequests()).toEqual({ completed: 2, failed: 0 });
    expect(await row(id)).toMatchObject({
      note: null,
      uploaded_by: null,
      decided_by: null,
      status: "ACCEPTED",
    });
    // The team still sees the file, with no name.
    expect(
      (await list(w, w.users.OWNER, "&status=ACCEPTED")).body.items[0]
        .uploader_name,
    ).toBeNull();
  });

  it("deletes portal objects with the organization", async () => {
    const w = await workspace();
    const ids = [await uploaded(w), await uploaded(w, undefined, "REJECTED")];
    await db.query(
      `INSERT INTO privacy_requests(request_type,organization_id,requester_id,execute_after)
       VALUES('ORGANIZATION_ERASURE',$1,$2,now()-interval '1 minute')`,
      [w.org, w.users.OWNER],
    );
    expect(await processErasureRequests()).toEqual({ completed: 1, failed: 0 });
    for (const id of ids) {
      expect(storage.deleted).toContain(`${w.org}/${w.client}/ready/${id}`);
      expect(storage.deleted).toContain(
        `${w.org}/${w.client}/previews/${id}.jpg`,
      );
      expect(await row(id)).toBeUndefined();
    }
  });

  it("retires long rejected, unused files in two steps", async () => {
    const w = await workspace();
    const old = await uploaded(w, undefined, "REJECTED");
    const used = await uploaded(w, undefined, "REJECTED");
    const pending = await uploaded(w);
    const recent = await uploaded(w, undefined, "REJECTED");
    await postWith(w, used, "DRAFT");
    await db.query(
      "UPDATE client_media_uploads SET decided_at=now()-interval '400 days',created_at=now()-interval '401 days' WHERE media_asset_id=ANY($1)",
      [[old, used, pending]],
    );
    await processRetentionPolicies(10, w.org);
    const gone = async (id: string) => Boolean((await asset(id)).deleted_at);
    expect(await Promise.all([old, used, pending, recent].map(gone))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(storage.deleted).toEqual([]);
    expect((await row(old)).note).toBeNull();
    expect(await auditRows(old)).toEqual([
      { action: "client_media.expired", metadata: {} },
    ]);
    await db.query(
      "UPDATE media_assets SET deleted_at=now()-interval '400 days' WHERE id=$1",
      [old],
    );
    await db.query("UPDATE organizations SET retention_last_run_at=NULL");
    await processRetentionPolicies(10, w.org);
    expect(storage.deleted).toContain(`${w.org}/${w.client}/ready/${old}`);
    expect(await asset(old)).toBeUndefined();
  });

  it("does not retire a file accepted in the meantime", async () => {
    const w = await workspace();
    const id = await uploaded(w, undefined, "REJECTED");
    await db.query(
      "UPDATE client_media_uploads SET decided_at=now()-interval '400 days' WHERE media_asset_id=$1",
      [id],
    );
    before = async (sql) => {
      if (!sql.includes("FOR UPDATE")) return;
      before = null;
      await db.query(
        "UPDATE client_media_uploads SET status='ACCEPTED' WHERE media_asset_id=$1",
        [id],
      );
    };
    expect(await expireRejectedUploads(w.org, 365)).toBe(0);
    expect((await asset(id)).deleted_at).toBeNull();
  });
});

describe("failing closed", () => {
  it("uses nothing when the rule cannot be checked", async () => {
    const w = await workspace();
    const id = await uploaded(w);
    const normal = await normalMedia(w);
    before = async (sql) => {
      if (sql.includes("client_media_uploads")) throw new Error("db down");
    };
    await expect(createPost(w.c("OWNER"), draft(w, [normal]))).rejects.toThrow(
      "db down",
    );
    expect((await hub(w, w.users.VIEWER, `&mediaId=${id}`)).status).toBe(503);
    expect((await hub(w, w.users.OWNER)).status).toBe(503);
  });
});

describe("texts", () => {
  it("has every error code in both languages", () => {
    for (const code of [
      "CLIENT_MEDIA_UNAVAILABLE",
      "CLIENT_MEDIA_DAILY_LIMIT",
      "CLIENT_MEDIA_PENDING_LIMIT",
      "CLIENT_MEDIA_NOT_READY",
      "CLIENT_MEDIA_CONFLICT",
      "CLIENT_MEDIA_DECIDED",
      "CLIENT_MEDIA_BUSY",
    ]) {
      expect(namespaces.errors.en).toHaveProperty([code]);
      expect(namespaces.errors.hu).toHaveProperty([code]);
    }
  });
});
