import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
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

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
// Storage stays local: objects "exist" and get a recognizable signed URL.
const signed = vi.hoisted(() => vi.fn());
vi.mock("../packages/server/media", async (original) => ({
  ...(await original<typeof import("../packages/server/media")>()),
  assertStoredObject: vi.fn(async () => {}),
  instagramImageObjectKey: vi.fn(
    async (media: { object_key: string }) => media.object_key,
  ),
  signedObjectUrl: signed,
  mediaUrl: vi.fn(
    async (_c: unknown, id: string) => `https://media.example/view/${id}`,
  ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { MetaGraphClient, publishMeta, findMetaPublishedMatches } = await import(
  "../packages/server/meta"
);
const { executePublish } = await import("../packages/server/publishing");
const { processPublishReconciliationJobsWith } = await import(
  "../packages/server/publish-reconciliation"
);
const { createPost, schedulePost } = await import("../packages/server/posts");
const { editDraft } = await import("../packages/server/post-lifecycle");
const { postInput } = await import("../packages/server/validation");
const { approvalView } = await import("../packages/server/approvals");
const { encrypt, hashToken, token } = await import("../packages/core/security");
const {
  capabilities,
  inMediaOrder,
  MEDIA_ERRORS,
  mediaErrorText,
  moveMedia,
  validatePost,
} = await import("../packages/core/domain");

const config = {
  appId: "app-123",
  appSecret: "secret-456",
  graphVersion: "v99.0",
  redirectUri: "https://hub.example/api/oauth/meta/callback",
};
const env = {
  META_INTEGRATION_ENABLED: "true",
  META_APP_ID: config.appId,
  META_APP_SECRET: config.appSecret,
  META_GRAPH_VERSION: config.graphVersion,
};

type Call = { method: string; path: string; params: URLSearchParams };

// Recorded Graph responses; nothing leaves the process.
function graphFetch(
  handler: (call: Call, calls: Call[]) => unknown | Promise<unknown>,
) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call = {
      method,
      path: url.pathname.replace("/v99.0/", ""),
      params:
        method === "GET"
          ? url.searchParams
          : new URLSearchParams(init?.body as URLSearchParams),
    };
    calls.push(call);
    const value = await handler(call, calls);
    return value instanceof Response ? value : Response.json(value);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

// Standard happy-path Graph for both networks.
function happyGraph(overrides: (call: Call) => unknown = () => undefined) {
  let next = 0;
  return graphFetch((call) => {
    const custom = overrides(call);
    if (custom !== undefined) return custom;
    if (call.method === "GET") return { status_code: "FINISHED" };
    if (call.path === "ig-1/media") return { id: `container-${++next}` };
    if (call.path === "ig-1/media_publish") return { id: "ig-carousel-1" };
    if (call.path === "page-1/photos") return { id: `photo-${++next}` };
    if (call.path === "page-1/feed") return { id: "page-1_post-9" };
    throw new Error(`Unexpected request ${call.method} ${call.path}`);
  });
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => {
  Object.assign(process.env, env);
  signed.mockReset();
  signed.mockImplementation(
    async (key: string, ttl: number) =>
      `https://media.example/${key}?expires=${ttl}`,
  );
});
afterEach(() => {
  for (const key of Object.keys(env)) delete process.env[key];
  vi.unstubAllGlobals();
});

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    user = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client')",
    [client, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  return {
    org,
    client,
    user,
    c: {
      organizationId: org,
      clientId: client,
      userId: user,
      role: "OWNER" as const,
    },
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function account(
  w: Workspace,
  platform: "facebook" | "instagram" | "linkedin" | "google",
  mode: "direct" | "mock" = "direct",
) {
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO social_accounts(organization_id,client_id,platform,name,remote_id,mode,status,token_health,capabilities)
       VALUES($1,$2,$3,'Account',$4,$5,'CONNECTED','HEALTHY','[]') RETURNING id`,
      [w.org, w.client, platform, crypto.randomUUID(), mode],
    )
  ).rows[0].id;
  if (mode === "direct" && ["facebook", "instagram"].includes(platform))
    await db.query(
      `INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value)
       VALUES($1,$2,$3,$4)`,
      [
        w.org,
        w.client,
        id,
        encrypt(
          JSON.stringify({
            version: 1,
            grantId: "grant-1",
            userAccessToken: "user-token",
            pageAccessToken: "page-token",
            pageId: "page-1",
            instagramBusinessId: "ig-1",
          }),
          `${w.org}:${w.client}:${id}`,
        ),
      ],
    );
  return id;
}

async function asset(w: Workspace, mime = "image/jpeg") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
     VALUES($1,$2,$3,$4,$5,$6,10,'READY')`,
    [id, w.org, w.client, `${id}.jpg`, `${w.org}/${id}`, mime],
  );
  return id;
}

// Inserted in reverse so an unordered id=ANY(...) read returns them reversed.
async function images(w: Workspace, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) ids.unshift(await asset(w));
  return ids;
}

async function publishJob(
  w: Workspace,
  accountId: string,
  mediaIds: string[],
  caption = "Carousel caption",
) {
  const postId = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,author_id,caption,status)
     VALUES($1,$2,$3,$4,$5,'SCHEDULED')`,
    [postId, w.org, w.client, w.user, caption],
  );
  const targetId = crypto.randomUUID();
  await db.query(
    `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption,status,media_ids)
     VALUES($1,$2,$3,$4,$5,$6,'QUEUED',$7)`,
    [targetId, w.org, w.client, postId, accountId, caption, mediaIds],
  );
  const job = (
    await db.query<{ id: string; idempotency_key: string }>(
      `INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at)
       VALUES($1,$2,$3,now()-interval '1 second') RETURNING id,idempotency_key`,
      [w.org, w.client, targetId],
    )
  ).rows[0];
  return { postId, targetId, jobId: job.id, key: job.idempotency_key };
}

const target = async (id: string) =>
  (
    await db.query<{ status: string; remote_id: string; error_code: string }>(
      "SELECT status,remote_id,error_code FROM post_targets WHERE id=$1",
      [id],
    )
  ).rows[0];
const receipts = async (key: string) =>
  (
    await db.query<{ remote_id: string }>(
      "SELECT remote_id FROM provider_receipts WHERE idempotency_key=$1",
      [key],
    )
  ).rows.map((row) => row.remote_id);
const urlOf = (w: Workspace, id: string) =>
  `https://media.example/${w.org}/${id}?expires=900`;

const media = (id: string, mime = "image/jpeg") => ({
  id,
  mime_type: mime,
  size_bytes: 10,
  status: "READY",
});

describe("multi-image platform limits", () => {
  const many = (count: number, mime = "image/jpeg") =>
    Array.from({ length: count }, (_, index) => media(`m${index}`, mime));

  it.each(["instagram", "facebook"] as const)(
    "accepts 2–10 images on %s and refuses 11, mixed media and repeats in Hungarian",
    (platform) => {
      for (const count of [1, 2, 10])
        expect(
          validatePost(platform, { caption: "x", media: many(count) }),
        ).toEqual([]);
      expect(validatePost(platform, { caption: "x", media: many(11) })).toEqual(
        [MEDIA_ERRORS.tooMany],
      );
      expect(
        validatePost(platform, {
          caption: "x",
          media: [media("a"), media("b", "video/mp4")],
        }),
      ).toEqual([MEDIA_ERRORS.imagesOnly]);
      expect(
        validatePost(platform, {
          caption: "x",
          media: [media("a"), media("a")],
        }),
      ).toEqual([MEDIA_ERRORS.duplicate]);
      // One video keeps today's Reel / Page video route.
      expect(
        validatePost(platform, {
          caption: "x",
          media: [media("v", "video/mp4")],
        }),
      ).toEqual([]);
    },
  );

  it.each(["linkedin", "google"] as const)(
    "refuses several images on %s instead of dropping them",
    (platform) => {
      expect(capabilities[platform]).not.toContain("MULTI_IMAGE");
      expect(validatePost(platform, { caption: "x", media: many(1) })).toEqual(
        [],
      );
      expect(validatePost(platform, { caption: "x", media: many(2) })).toEqual([
        MEDIA_ERRORS.single,
      ]);
    },
  );

  it("refuses more than ten attachments in the request schema", () => {
    const result = postInput.safeParse({
      clientId: crypto.randomUUID(),
      caption: "x",
      targets: [
        {
          accountId: crypto.randomUUID(),
          caption: "x",
          mediaIds: Array.from({ length: 11 }, () => crypto.randomUUID()),
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      mediaErrorText(MEDIA_ERRORS.tooMany),
    );
  });

  it("keeps media_ids order whatever order rows come back in", () => {
    const rows = [{ id: "c" }, { id: "b" }, { id: "a" }];
    expect(inMediaOrder(["a", "b", "c"], rows).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(inMediaOrder(["a", "x"], rows).map((row) => row.id)).toEqual(["a"]);
  });

  it("moves attachments up and down for the composer", () => {
    expect(moveMedia(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveMedia(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveMedia(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveMedia(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("saving and scheduling several images", () => {
  const draft = (accountId: string, mediaIds: string[]) => ({
    clientId: crypto.randomUUID(),
    caption: "Caption",
    targets: [{ accountId, caption: "Caption", mediaIds }],
  });

  it("saves an Instagram carousel and keeps the order set in the composer", async () => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const ids = await images(w, 3);
    const post = await createPost(w.c, draft(instagram, ids));
    const reordered = moveMedia(ids, 2, -1);
    await editDraft(w.c, post.id, draft(instagram, reordered));
    expect(
      (
        await db.query<{ media_ids: string[] }>(
          "SELECT media_ids FROM post_targets WHERE post_id=$1",
          [post.id],
        )
      ).rows[0].media_ids,
    ).toEqual(reordered);
  });

  it.each(["linkedin", "google"] as const)(
    "refuses several images on %s when saving",
    async (platform) => {
      const w = await workspace();
      const id = await account(w, platform, "mock");
      const ids = await images(w, 2);
      await expect(createPost(w.c, draft(id, ids))).rejects.toMatchObject({
        status: 422,
        code: "MEDIA_UNSUPPORTED",
        message: expect.stringContaining(mediaErrorText(MEDIA_ERRORS.single)),
      });
      const post = await createPost(w.c, draft(id, ids.slice(0, 1)));
      await expect(
        editDraft(w.c, post.id, draft(id, ids)),
      ).rejects.toMatchObject({ code: "MEDIA_UNSUPPORTED" });
    },
  );

  it("refuses a video among Facebook images and repeated images with a clear message", async () => {
    const w = await workspace();
    const facebook = await account(w, "facebook");
    const [image] = await images(w, 1);
    const video = await asset(w, "video/mp4");
    await expect(
      createPost(w.c, draft(facebook, [image!, video])),
    ).rejects.toMatchObject({
      code: "MEDIA_UNSUPPORTED",
      message: `Facebook: ${mediaErrorText(MEDIA_ERRORS.imagesOnly)}`,
    });
    await expect(
      createPost(w.c, draft(facebook, [image!, image!])),
    ).rejects.toMatchObject({
      status: 422,
      code: "DUPLICATE_MEDIA",
      message: mediaErrorText(MEDIA_ERRORS.duplicate),
    });
  });

  it("refuses to schedule several images for LinkedIn", async () => {
    const w = await workspace();
    const linkedin = await account(w, "linkedin", "mock");
    const ids = await images(w, 2);
    const post = await createPost(w.c, draft(linkedin, ids.slice(0, 1)));
    // Bypasses the save check, as an older draft would.
    await db.query("UPDATE post_targets SET media_ids=$1 WHERE post_id=$2", [
      ids,
      post.id,
    ]);
    await db.query("UPDATE posts SET status='APPROVED' WHERE id=$1", [post.id]);
    await expect(
      schedulePost(w.c, post.id, new Date(Date.now() + 3600_000).toISOString()),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(mediaErrorText(MEDIA_ERRORS.single)),
    });
  });
});

describe("approval page", () => {
  it("shows every image of the post in media_ids order", async () => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const ids = await images(w, 3);
    const post = await createPost(w.c, {
      clientId: w.client,
      caption: "Carousel",
      targets: [{ accountId: instagram, caption: "Carousel", mediaIds: ids }],
    });
    const secret = token();
    await db.query(
      `INSERT INTO approval_requests(organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind)
       VALUES($1,$2,$3,1,$4,now()+interval '7 days','EXTERNAL')`,
      [w.org, w.client, post.id, hashToken(secret)],
    );
    const view = await approvalView(secret);
    expect(view.versions[0].media.map((m: { id: string }) => m.id)).toEqual(
      ids,
    );
    expect(view.versions[0].media.map((m: { url: string }) => m.url)).toEqual(
      ids.map((id) => `https://media.example/view/${id}`),
    );
  });
});

describe("Meta adapter guard", () => {
  it.each([
    ["eleven images", Array.from({ length: 11 }, () => "image/jpeg")],
    ["an image and a video", ["image/jpeg", "video/mp4"]],
  ])("refuses %s before any Graph call", async (_name, mimes) => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const graph = happyGraph();
    vi.stubGlobal("fetch", graph.impl);
    await expect(
      publishMeta({
        organizationId: w.org,
        clientId: w.client,
        accountId: instagram,
        platform: "instagram",
        content: {
          caption: "x",
          media: mimes.map((mime) => {
            const id = crypto.randomUUID();
            return { ...media(id, mime), object_key: `${w.org}/${id}` };
          }),
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION" });
    expect(graph.calls).toEqual([]);
    expect(signed).not.toHaveBeenCalled();
  });
});

describe("Instagram carousel publishing", () => {
  it("keeps a rate-limited carousel item retryable", async () => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const job = await publishJob(w, instagram, await images(w, 2));
    const graph = happyGraph((call) =>
      call.path === "ig-1/media" && posts(graph.calls).length === 2
        ? Response.json({ error: { code: 4 } }, { status: 400 })
        : undefined,
    );
    vi.stubGlobal("fetch", graph.impl);
    expect(await executePublish(job.jobId)).toMatchObject({
      errorCode: "META_RATE_LIMIT",
    });
    expect((await target(job.targetId)).status).toBe("QUEUED");
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM publish_jobs WHERE id=$1",
          [job.jobId],
        )
      ).rows[0].status,
    ).toBe("RETRY");
    expect(graph.calls.some((c) => c.path.endsWith("media_publish"))).toBe(
      false,
    );
  });

  it("creates items in media order, waits for them, then the carousel and publishes once", async () => {
    const graph = happyGraph();
    const client = new MetaGraphClient(config, graph.impl, async () => {});
    await expect(
      client.publishInstagramCarousel("ig-1", "page-token", "Hello", [
        "https://media.example/a",
        "https://media.example/b",
        "https://media.example/c",
      ]),
    ).resolves.toEqual({ id: "ig-carousel-1" });
    expect(graph.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST ig-1/media",
      "GET container-1",
      "POST ig-1/media",
      "GET container-2",
      "POST ig-1/media",
      "GET container-3",
      "POST ig-1/media",
      "GET container-4",
      "POST ig-1/media_publish",
    ]);
    const items = posts(graph.calls).slice(0, 3);
    expect(items.map((c) => c.params.get("image_url"))).toEqual([
      "https://media.example/a",
      "https://media.example/b",
      "https://media.example/c",
    ]);
    expect(
      items.every((c) => c.params.get("is_carousel_item") === "true"),
    ).toBe(true);
    expect(items.every((c) => !c.params.has("caption"))).toBe(true);
    const parent = posts(graph.calls)[3]!;
    expect(parent.params.get("media_type")).toBe("CAROUSEL");
    expect(parent.params.get("children")).toBe(
      "container-1,container-2,container-3",
    );
    expect(parent.params.get("caption")).toBe("Hello");
    expect(posts(graph.calls)[4]!.params.get("creation_id")).toBe(
      "container-4",
    );
  });

  it("publishes a carousel through the worker in media_ids order with one receipt", async () => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const ids = await images(w, 3);
    // The rows really come back in a different order than media_ids.
    expect(
      (
        await db.query<{ id: string }>(
          "SELECT id FROM media_assets WHERE id=ANY($1::uuid[])",
          [ids],
        )
      ).rows.map((row) => row.id),
    ).not.toEqual(ids);
    const job = await publishJob(w, instagram, ids);
    const graph = happyGraph();
    vi.stubGlobal("fetch", graph.impl);
    await executePublish(job.jobId);
    expect(
      posts(graph.calls)
        .slice(0, 3)
        .map((c) => c.params.get("image_url")),
    ).toEqual(ids.map((id) => urlOf(w, id)));
    expect(await target(job.targetId)).toMatchObject({
      status: "PUBLISHED",
      remote_id: "ig-carousel-1",
    });
    expect(await receipts(job.key)).toEqual(["ig-carousel-1"]);

    // The same idempotency key never reaches media_publish again.
    const again = happyGraph();
    vi.stubGlobal("fetch", again.impl);
    await expect(
      publishMeta({
        organizationId: w.org,
        clientId: w.client,
        accountId: instagram,
        platform: "instagram",
        content: {
          caption: "Carousel caption",
          media: ids.map((id) => ({
            ...media(id),
            object_key: `${w.org}/${id}`,
          })),
        },
        idempotencyKey: job.key,
      }),
    ).resolves.toEqual({ remoteId: "ig-carousel-1" });
    expect(again.calls).toEqual([]);
    expect(await receipts(job.key)).toEqual(["ig-carousel-1"]);
  });

  it.each([
    [
      "a refused item",
      (call: Call, calls: Call[]) =>
        call.path === "ig-1/media" && posts(calls).length === 2
          ? Response.json(
              { error: { code: 100, message: "Invalid image" } },
              { status: 400 },
            )
          : undefined,
    ],
    [
      "an item in ERROR",
      (call: Call) =>
        call.path === "container-2" ? { status_code: "ERROR" } : undefined,
    ],
  ])("stops before the carousel container on %s", async (_name, failure) => {
    const w = await workspace();
    const instagram = await account(w, "instagram");
    const job = await publishJob(w, instagram, await images(w, 3));
    const graph = graphFetch((call, calls) => {
      const custom = failure(call, calls);
      if (custom !== undefined) return custom;
      if (call.method === "GET") return { status_code: "FINISHED" };
      if (call.path === "ig-1/media")
        return { id: `container-${posts(calls).length}` };
      throw new Error(`Unexpected request ${call.method} ${call.path}`);
    });
    vi.stubGlobal("fetch", graph.impl);
    const result = await executePublish(job.jobId);
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "META_MEDIA_REJECTED",
    });
    expect(
      posts(graph.calls).some(
        (c) =>
          c.params.get("media_type") === "CAROUSEL" ||
          c.path.endsWith("media_publish"),
      ),
    ).toBe(false);
    expect(await target(job.targetId)).toMatchObject({
      status: "FAILED",
      error_code: "META_MEDIA_REJECTED",
      remote_id: null,
    });
    expect(await receipts(job.key)).toEqual([]);
  });
});

describe("Facebook multi-photo publishing", () => {
  it("uploads unpublished photos in media_ids order and attaches them to one feed post", async () => {
    const w = await workspace();
    const facebook = await account(w, "facebook");
    const ids = await images(w, 3);
    const job = await publishJob(w, facebook, ids);
    const graph = happyGraph();
    vi.stubGlobal("fetch", graph.impl);
    await executePublish(job.jobId);
    expect(graph.calls.map((c) => c.path)).toEqual([
      "page-1/photos",
      "page-1/photos",
      "page-1/photos",
      "page-1/feed",
    ]);
    const uploads = graph.calls.slice(0, 3);
    expect(uploads.map((c) => c.params.get("url"))).toEqual(
      ids.map((id) => urlOf(w, id)),
    );
    expect(uploads.every((c) => c.params.get("published") === "false")).toBe(
      true,
    );
    const feed = graph.calls[3]!.params;
    expect(feed.get("message")).toBe("Carousel caption");
    expect([0, 1, 2].map((i) => feed.get(`attached_media[${i}]`))).toEqual([
      '{"media_fbid":"photo-1"}',
      '{"media_fbid":"photo-2"}',
      '{"media_fbid":"photo-3"}',
    ]);
    expect(await target(job.targetId)).toMatchObject({
      status: "PUBLISHED",
      remote_id: "page-1_post-9",
    });
    expect(await receipts(job.key)).toEqual(["page-1_post-9"]);

    const again = happyGraph();
    vi.stubGlobal("fetch", again.impl);
    await expect(
      publishMeta({
        organizationId: w.org,
        clientId: w.client,
        accountId: facebook,
        platform: "facebook",
        content: {
          caption: "Carousel caption",
          media: ids.map((id) => ({
            ...media(id),
            object_key: `${w.org}/${id}`,
          })),
        },
        idempotencyKey: job.key,
      }),
    ).resolves.toEqual({ remoteId: "page-1_post-9" });
    expect(again.calls).toEqual([]);
  });

  it("never posts to the feed when a photo upload fails", async () => {
    const w = await workspace();
    const facebook = await account(w, "facebook");
    const job = await publishJob(w, facebook, await images(w, 3));
    let uploads = 0;
    // The second photo is refused; the others would succeed.
    const graph = happyGraph((call) =>
      call.path === "page-1/photos" && ++uploads === 2
        ? Response.json(
            { error: { code: 324, message: "Bad photo" } },
            { status: 400 },
          )
        : undefined,
    );
    vi.stubGlobal("fetch", graph.impl);
    expect(await executePublish(job.jobId)).toMatchObject({
      status: "FAILED",
      errorCode: "META_MEDIA_REJECTED",
    });
    expect(graph.calls.some((c) => c.path === "page-1/feed")).toBe(false);
    expect(await target(job.targetId)).toMatchObject({
      status: "FAILED",
      error_code: "META_MEDIA_REJECTED",
    });
    expect(await receipts(job.key)).toEqual([]);
  });
});

describe("uncertain multi-image delivery", () => {
  const timeout = (path: string) => (call: Call) => {
    if (call.path === path) throw new DOMException("timed out", "TimeoutError");
    return undefined;
  };

  it.each([
    ["instagram", "ig-1/media_publish"],
    ["facebook", "page-1/feed"],
  ] as const)(
    "marks a lost %s response as uncertain without resending",
    async (platform, path) => {
      const w = await workspace();
      const id = await account(w, platform);
      const job = await publishJob(w, id, await images(w, 2));
      const graph = happyGraph(timeout(path));
      vi.stubGlobal("fetch", graph.impl);
      expect(await executePublish(job.jobId)).toMatchObject({
        status: "FAILED",
        errorCode: "META_DELIVERY_UNCERTAIN",
      });
      expect(graph.calls.filter((c) => c.path === path)).toHaveLength(1);
      const stored = (
        await db.query<{ status: string }>(
          "SELECT status FROM publish_jobs WHERE id=$1",
          [job.jobId],
        )
      ).rows[0];
      expect(stored.status).toBe("DEAD");
      expect(await receipts(job.key)).toEqual([]);
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM publish_reconciliation_jobs WHERE publish_job_id=$1",
            [job.jobId],
          )
        ).rows[0]?.status,
      ).toBe("PENDING");
    },
  );

  async function uncertainCarousel(w: Workspace, caption: string) {
    const instagram = await account(w, "instagram");
    const job = await publishJob(w, instagram, await images(w, 2), caption);
    vi.stubGlobal("fetch", happyGraph(timeout("ig-1/media_publish")).impl);
    await executePublish(job.jobId);
    await db.query(
      "UPDATE publish_reconciliation_jobs SET run_at=now()-interval '1 second' WHERE publish_job_id=$1",
      [job.jobId],
    );
    return job;
  }
  const listing = (items: unknown[]) =>
    graphFetch((call) => {
      expect(call.path).toBe("ig-1/media");
      return { data: items };
    });
  const album = (id: string, caption: string) => ({
    id,
    caption,
    media_type: "CAROUSEL_ALBUM",
    timestamp: new Date().toISOString(),
  });

  it("confirms a carousel listed as CAROUSEL_ALBUM with the matching caption", async () => {
    const w = await workspace();
    const caption = `Album ${crypto.randomUUID()}`;
    const job = await uncertainCarousel(w, caption);
    const graph = listing([album("ig-album-7", caption)]);
    const client = new MetaGraphClient(config, graph.impl);
    await processPublishReconciliationJobsWith(
      5,
      (input) => findMetaPublishedMatches(input, client),
      w.org,
    );
    expect(await target(job.targetId)).toMatchObject({
      status: "PUBLISHED",
      remote_id: "ig-album-7",
    });
    expect(await receipts(job.key)).toEqual(["ig-album-7"]);
  });

  it("confirms an uncertain Facebook multi-photo post from the Page's posts", async () => {
    const w = await workspace();
    const caption = `Photos ${crypto.randomUUID()}`;
    const facebook = await account(w, "facebook");
    const job = await publishJob(w, facebook, await images(w, 3), caption);
    vi.stubGlobal("fetch", happyGraph(timeout("page-1/feed")).impl);
    await executePublish(job.jobId);
    await db.query(
      "UPDATE publish_reconciliation_jobs SET run_at=now()-interval '1 second' WHERE publish_job_id=$1",
      [job.jobId],
    );
    const client = new MetaGraphClient(
      config,
      graphFetch((call) => {
        expect(call.path).toBe("page-1/published_posts");
        return {
          data: [
            {
              id: "page-1_post-42",
              message: caption,
              created_time: new Date().toISOString(),
            },
          ],
        };
      }).impl,
    );
    await processPublishReconciliationJobsWith(
      5,
      (input) => findMetaPublishedMatches(input, client),
      w.org,
    );
    expect(await target(job.targetId)).toMatchObject({
      status: "PUBLISHED",
      remote_id: "page-1_post-42",
    });
    expect(await receipts(job.key)).toEqual(["page-1_post-42"]);
  });

  it.each([
    ["two matches", 2, "UNRESOLVED"],
    ["no match", 0, "RETRY"],
  ] as const)(
    "keeps the carousel unpublished on %s",
    async (_name, count, status) => {
      const w = await workspace();
      const caption = `Album ${crypto.randomUUID()}`;
      const job = await uncertainCarousel(w, caption);
      const items = Array.from({ length: count }, (_, i) =>
        album(`ig-album-${i}`, caption),
      );
      const client = new MetaGraphClient(config, listing(items).impl);
      await processPublishReconciliationJobsWith(
        5,
        (input) => findMetaPublishedMatches(input, client),
        w.org,
      );
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM publish_reconciliation_jobs WHERE publish_job_id=$1",
            [job.jobId],
          )
        ).rows[0].status,
      ).toBe(status);
      expect((await target(job.targetId)).status).toBe("FAILED");
      expect(await receipts(job.key)).toEqual([]);
      if (count) return;
      // After the last lookup an unmatched carousel is left for a person.
      await db.query(
        "UPDATE publish_reconciliation_jobs SET attempts=3,run_at=now()-interval '1 second' WHERE publish_job_id=$1",
        [job.jobId],
      );
      await processPublishReconciliationJobsWith(
        5,
        (input) => findMetaPublishedMatches(input, client),
        w.org,
      );
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM publish_reconciliation_jobs WHERE publish_job_id=$1",
            [job.jobId],
          )
        ).rows[0].status,
      ).toBe("UNRESOLVED");
    },
  );
});
