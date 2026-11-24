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
vi.mock("../packages/server/media", async (original) => ({
  ...(await original<typeof import("../packages/server/media")>()),
  assertStoredObject: vi.fn(async () => {}),
  instagramImageObjectKey: vi.fn(
    async (media: { object_key: string }) => media.object_key,
  ),
  signedObjectUrl: vi.fn(async (key: string) => `https://media.example/${key}`),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { MetaGraphClient, findMetaPublishedMatches } = await import(
  "../packages/server/meta"
);
const { executePublish } = await import("../packages/server/publishing");
const { processPublishReconciliationJobsWith } = await import(
  "../packages/server/publish-reconciliation"
);
const { enqueueFirstComment, executeFirstComment, processFirstComments } =
  await import("../packages/server/first-comments");
const { createPost } = await import("../packages/server/posts");
const { editDraft } = await import("../packages/server/post-lifecycle");
const { listHashtagSets, saveHashtagSet, deleteHashtagSet } = await import(
  "../packages/server/hashtag-sets"
);
const { postInput, hashtagSetInput } = await import(
  "../packages/server/validation"
);
const { transaction } = await import("../packages/server/transaction");
const { encrypt, hashToken } = await import("../packages/core/security");
const { approvalView } = await import("../packages/server/approvals");
const {
  appendHashtags,
  FIRST_COMMENT_LIMIT,
  MEDIA_ERRORS,
  MEDIA_ERROR_TEXT,
  MULTI_IMAGE_LIMIT,
  normalizeHashtags,
  validatePost,
} = await import("../packages/core/domain");
const composerMessages = (await import("../apps/web/i18n/messages/composer"))
  .default;

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
function graphFetch(handler: (call: Call) => unknown) {
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
    const value = await handler(call);
    return value instanceof Response ? value : Response.json(value);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
// Publishing: a Facebook text post and an Instagram single image.
const publishGraph = (lose?: string) =>
  graphFetch((call) => {
    if (call.path === lose) throw new DOMException("timed out", "TimeoutError");
    if (call.method === "GET") return { status_code: "FINISHED" };
    if (call.path === "page-1/feed") return { id: "page-1_post-9" };
    if (call.path === "ig-1/media") return { id: "container-1" };
    if (call.path === "ig-1/media_publish") return { id: "ig-media-1" };
    throw new Error(`Unexpected request ${call.method} ${call.path}`);
  });
const commentGraph = (handler: (call: Call) => unknown) => {
  const graph = graphFetch(handler);
  return { ...graph, client: new MetaGraphClient(config, graph.impl) };
};
const graphError = (status: number, code: number) =>
  Response.json({ error: { message: "x", code } }, { status });

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => {
  Object.assign(process.env, env);
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
  platform: "facebook" | "instagram" | "linkedin",
) {
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO social_accounts(organization_id,client_id,platform,name,remote_id,mode,status,token_health,capabilities)
       VALUES($1,$2,$3,'Account',$4,'direct','CONNECTED','HEALTHY','[]') RETURNING id`,
      [w.org, w.client, platform, crypto.randomUUID()],
    )
  ).rows[0].id;
  if (platform !== "linkedin")
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

// A scheduled target with a first comment, due now.
async function publishJob(
  w: Workspace,
  platform: "facebook" | "instagram",
  firstComment: string | null = "#first #comment",
) {
  const accountId = await account(w, platform);
  const mediaIds: string[] = [];
  if (platform === "instagram") {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
       VALUES($1,$2,$3,'a.jpg',$4,'image/jpeg',10,'READY')`,
      [id, w.org, w.client, `${w.org}/${id}`],
    );
    mediaIds.push(id);
  }
  const postId = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,author_id,caption,status)
     VALUES($1,$2,$3,$4,'Caption','SCHEDULED')`,
    [postId, w.org, w.client, w.user],
  );
  const targetId = crypto.randomUUID();
  await db.query(
    `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption,status,media_ids,first_comment)
     VALUES($1,$2,$3,$4,$5,'Caption','QUEUED',$6,$7)`,
    [targetId, w.org, w.client, postId, accountId, mediaIds, firstComment],
  );
  const job = (
    await db.query<{ id: string; idempotency_key: string }>(
      `INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at)
       VALUES($1,$2,$3,now()-interval '1 second') RETURNING id,idempotency_key`,
      [w.org, w.client, targetId],
    )
  ).rows[0];
  return {
    postId,
    targetId,
    accountId,
    jobId: job.id,
    key: job.idempotency_key,
  };
}

const commentJobs = async (targetId: string) =>
  (
    await db.query<{
      id: string;
      status: string;
      attempts: number;
      idempotency_key: string;
      remote_id: string | null;
      last_error: string | null;
      due: boolean;
    }>(
      "SELECT *,run_at<=now() AS due FROM first_comment_jobs WHERE target_id=$1",
      [targetId],
    )
  ).rows;
const targetRow = async (id: string) =>
  (
    await db.query<{ status: string; remote_id: string }>(
      "SELECT t.status,t.remote_id,p.status AS post_status FROM post_targets t JOIN posts p ON p.id=t.post_id WHERE t.id=$1",
      [id],
    )
  ).rows[0];
const commentPosts = (calls: Call[]) =>
  calls.filter((call) => call.path.endsWith("/comments"));

async function published(w: Workspace, platform: "facebook" | "instagram") {
  const job = await publishJob(w, platform);
  vi.stubGlobal("fetch", publishGraph().impl);
  expect(await executePublish(job.jobId)).toMatchObject({
    status: "PUBLISHED",
  });
  return job;
}

describe("first comment after publishing", () => {
  it.each([
    ["facebook", "page-1_post-9"],
    ["instagram", "ig-media-1"],
  ] as const)(
    "queues exactly one job after a %s post and comments once",
    async (platform, remoteId) => {
      const w = await workspace();
      const job = await published(w, platform);
      // A repeated enqueue (e.g. reconciliation racing the worker) is a no-op.
      await transaction((tx) => enqueueFirstComment(tx, job.targetId));
      const [queued, ...rest] = await commentJobs(job.targetId);
      expect(rest).toEqual([]);
      expect(queued).toMatchObject({ status: "PENDING", attempts: 0 });
      const stableKey = (
        await db.query<{ key: string }>(
          "SELECT md5($1||':first_comment')::uuid::text AS key",
          [job.targetId],
        )
      ).rows[0].key;
      expect(queued.idempotency_key).toBe(stableKey);

      const graph = commentGraph(() => ({ id: "comment-1" }));
      expect(await executeFirstComment(queued.id, graph.client)).toMatchObject({
        status: "SENT",
      });
      expect(commentPosts(graph.calls)).toHaveLength(1);
      expect(graph.calls[0].path).toBe(`${remoteId}/comments`);
      expect(graph.calls[0].params.get("message")).toBe("#first #comment");

      // A second run, or the same job forced back to pending, never posts again.
      expect(
        await executeFirstComment(queued.id, graph.client),
      ).toBeUndefined();
      await db.query(
        "UPDATE first_comment_jobs SET status='PENDING',run_at=now()-interval '1 second' WHERE id=$1",
        [queued.id],
      );
      await executeFirstComment(queued.id, graph.client);
      expect(commentPosts(graph.calls)).toHaveLength(1);
      const receipts = (
        await db.query<{ provider: string; remote_id: string }>(
          "SELECT provider,remote_id FROM first_comment_receipts WHERE idempotency_key=$1",
          [queued.idempotency_key],
        )
      ).rows;
      expect(receipts).toEqual([
        { provider: `meta:${platform}:comment`, remote_id: "comment-1" },
      ]);
      expect((await commentJobs(job.targetId))[0]).toMatchObject({
        status: "SENT",
        remote_id: "comment-1",
      });
    },
  );

  it("queues nothing without a first comment", async () => {
    const w = await workspace();
    const job = await publishJob(w, "facebook", "   ");
    vi.stubGlobal("fetch", publishGraph().impl);
    await executePublish(job.jobId);
    expect(await commentJobs(job.targetId)).toEqual([]);
  });

  it.each([
    [429, 4, "META_RATE_LIMIT"],
    [500, 1, "META_UNAVAILABLE"],
  ])(
    "retries a %s answer later and then comments",
    async (status, code, error) => {
      const w = await workspace();
      const job = await published(w, "facebook");
      const [queued] = await commentJobs(job.targetId);
      const failing = commentGraph(() => graphError(status, code));
      expect(
        await executeFirstComment(queued.id, failing.client),
      ).toMatchObject({ status: "RETRY", errorCode: error });
      const retry = (await commentJobs(job.targetId))[0];
      expect(retry).toMatchObject({ status: "RETRY", attempts: 1, due: false });
      // Not due yet: the worker leaves it alone.
      await processFirstComments(20, failing.client);
      expect(commentPosts(failing.calls)).toHaveLength(1);
      await db.query(
        "UPDATE first_comment_jobs SET run_at=now()-interval '1 second' WHERE id=$1",
        [queued.id],
      );
      const ok = commentGraph(() => ({ id: "comment-2" }));
      expect(await processFirstComments(20, ok.client)).toMatchObject({
        sent: 1,
      });
      expect((await commentJobs(job.targetId))[0]).toMatchObject({
        status: "SENT",
        attempts: 2,
      });
    },
  );

  it("marks a lost response uncertain and never resends it", async () => {
    const w = await workspace();
    const job = await published(w, "instagram");
    const [queued] = await commentJobs(job.targetId);
    const graph = commentGraph(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await executeFirstComment(queued.id, graph.client)).toMatchObject({
      status: "UNCERTAIN",
      errorCode: "META_DELIVERY_UNCERTAIN",
    });
    await db.query(
      "UPDATE first_comment_jobs SET run_at=now()-interval '1 hour' WHERE id=$1",
      [queued.id],
    );
    await processFirstComments(20, graph.client);
    expect(commentPosts(graph.calls)).toHaveLength(1);
    expect((await commentJobs(job.targetId))[0].status).toBe("UNCERTAIN");
    expect(await targetRow(job.targetId)).toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("turns a job left running by a dead worker uncertain", async () => {
    const w = await workspace();
    const job = await published(w, "facebook");
    const [queued] = await commentJobs(job.targetId);
    await db.query(
      "UPDATE first_comment_jobs SET status='RUNNING',updated_at=now()-interval '1 hour' WHERE id=$1",
      [queued.id],
    );
    const graph = commentGraph(() => ({ id: "never" }));
    expect(await processFirstComments(20, graph.client)).toMatchObject({
      uncertain: 1,
    });
    expect(graph.calls).toHaveLength(0);
  });

  it("marks only the comment failed on a final error; the post stays published", async () => {
    const w = await workspace();
    const job = await published(w, "facebook");
    const [queued] = await commentJobs(job.targetId);
    const graph = commentGraph(() => graphError(400, 100));
    expect(await executeFirstComment(queued.id, graph.client)).toMatchObject({
      status: "FAILED",
      errorCode: "META_REJECTED",
    });
    expect((await commentJobs(job.targetId))[0]).toMatchObject({
      status: "FAILED",
      last_error: "META_REJECTED",
    });
    expect(await targetRow(job.targetId)).toMatchObject({
      status: "PUBLISHED",
      post_status: "PUBLISHED",
      remote_id: "page-1_post-9",
    });
    const notes = (
      await db.query<{ message: string }>(
        "SELECT message FROM notifications WHERE resource_id=$1",
        [job.postId],
      )
    ).rows.map((row) => row.message);
    expect(notes).toContain("First comment failed on facebook: META_REJECTED");
  });

  it("queues no comment for an uncertain post, only once reconciliation confirms it", async () => {
    const w = await workspace();
    const job = await publishJob(w, "facebook");
    vi.stubGlobal("fetch", publishGraph("page-1/feed").impl);
    expect(await executePublish(job.jobId)).toMatchObject({
      errorCode: "META_DELIVERY_UNCERTAIN",
    });
    expect(await commentJobs(job.targetId)).toEqual([]);
    await db.query(
      "UPDATE publish_reconciliation_jobs SET run_at=now()-interval '1 second' WHERE publish_job_id=$1",
      [job.jobId],
    );
    const listing = new MetaGraphClient(
      config,
      graphFetch(() => ({
        data: [
          {
            id: "page-1_post-77",
            message: "Caption",
            created_time: new Date().toISOString(),
          },
        ],
      })).impl,
    );
    await processPublishReconciliationJobsWith(
      5,
      (input) => findMetaPublishedMatches(input, listing),
      w.org,
    );
    expect(await targetRow(job.targetId)).toMatchObject({
      status: "PUBLISHED",
    });
    expect(await commentJobs(job.targetId)).toHaveLength(1);
  });
});

describe("first comment on drafts", () => {
  const draft = (accountId: string, firstComment?: string) => ({
    clientId: crypto.randomUUID(),
    caption: "Hello",
    targets: [{ accountId, caption: "Hello", mediaIds: [], firstComment }],
  });

  it("refuses a first comment on LinkedIn", async () => {
    const w = await workspace();
    const linkedin = await account(w, "linkedin");
    await expect(
      createPost(w.c, { ...draft(linkedin, "#tag"), clientId: w.client }),
    ).rejects.toMatchObject({ status: 422, code: "FIRST_COMMENT_UNSUPPORTED" });
    // Blank text is simply no first comment.
    await expect(
      createPost(w.c, { ...draft(linkedin, "  "), clientId: w.client }),
    ).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("limits the first comment to 2200 characters", () => {
    const id = crypto.randomUUID();
    expect(
      postInput.safeParse(draft(id, "x".repeat(FIRST_COMMENT_LIMIT))).success,
    ).toBe(true);
    const result = postInput.safeParse(
      draft(id, "x".repeat(FIRST_COMMENT_LIMIT + 1)),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("2200");
  });

  it("keeps the first comment in the snapshot; editing it needs a new revision", async () => {
    const w = await workspace();
    const facebook = await account(w, "facebook");
    const post = await createPost(w.c, {
      ...draft(facebook, "#one"),
      clientId: w.client,
    });
    await db.query(
      `INSERT INTO approval_requests(organization_id,client_id,post_id,revision,token_hash,expires_at)
       VALUES($1,$2,$3,1,$4,now()+interval '1 day')`,
      [w.org, w.client, post.id, hashToken("review-secret")],
    );
    await db.query(
      "UPDATE approval_requests SET step_kind='EXTERNAL' WHERE post_id=$1",
      [post.id],
    );
    // The client sees the first comment of the revision under review.
    expect((await approvalView("review-secret")).versions[0]).toMatchObject({
      platform: "facebook",
      caption: "Hello",
      firstComment: "#one",
    });
    await editDraft(w.c, post.id, {
      ...draft(facebook, "#two"),
      clientId: w.client,
    });
    const versions = (
      await db.query<{ revision: number; comment: string }>(
        "SELECT revision,snapshot->'targets'->0->>'firstComment' AS comment FROM post_versions WHERE post_id=$1 ORDER BY revision",
        [post.id],
      )
    ).rows;
    expect(versions).toEqual([
      { revision: 1, comment: "#one" },
      { revision: 2, comment: "#two" },
    ]);
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM approval_requests WHERE post_id=$1",
          [post.id],
        )
      ).rows[0].status,
    ).toBe("SUPERSEDED");
    expect(
      (
        await db.query<{ first_comment: string }>(
          "SELECT first_comment FROM post_targets WHERE post_id=$1",
          [post.id],
        )
      ).rows[0].first_comment,
    ).toBe("#two");
  });
});

describe("client hashtag sets", () => {
  const input = (name: string, hashtags: string[]) =>
    hashtagSetInput.parse({ name, hashtags });

  it("normalizes hashtags and limits their number", () => {
    expect(
      normalizeHashtags(["marketing ##Budapest, #marketing", " "]),
    ).toEqual(["#marketing", "#Budapest"]);
    expect(input("Set", ["a b", "#c"]).hashtags).toEqual(["#a", "#b", "#c"]);
    const many = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    expect(
      hashtagSetInput.safeParse({ name: "x", hashtags: many }).success,
    ).toBe(false);
    expect(
      hashtagSetInput.safeParse({ name: "x", hashtags: [" "] }).success,
    ).toBe(false);
    expect(appendHashtags("Text  ", ["#a", "#b"])).toBe("Text\n\n#a #b");
    expect(appendHashtags("", ["#a"])).toBe("#a");
  });

  it("keeps names unique per client", async () => {
    const w = await workspace();
    await saveHashtagSet(w.c, input("Nyár", ["#nyar"]));
    await expect(
      saveHashtagSet(w.c, input("nyár", ["#mas"])),
    ).rejects.toMatchObject({ status: 409, code: "HASHTAG_SET_EXISTS" });
    // Another client may use the same name.
    const other = await workspace();
    await expect(
      saveHashtagSet(other.c, input("Nyár", ["#nyar"])),
    ).resolves.toMatchObject({ name: "Nyár" });
  });

  it("lets only the owning organization's client read and write its sets", async () => {
    const owner = await workspace();
    const set = await saveHashtagSet(owner.c, input("Brand", ["#brand"]));
    const updated = await saveHashtagSet(
      owner.c,
      input("Brand 2", ["#brand", "#two"]),
      set.id,
    );
    expect(updated).toMatchObject({
      name: "Brand 2",
      hashtags: ["#brand", "#two"],
    });
    expect(await listHashtagSets(owner.c)).toHaveLength(1);

    const stranger = await workspace();
    expect(await listHashtagSets(stranger.c)).toEqual([]);
    await expect(
      saveHashtagSet(stranger.c, input("Steal", ["#x"]), set.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deleteHashtagSet(stranger.c, set.id)).rejects.toMatchObject({
      status: 404,
    });
    // A context naming the owner's client from another organization.
    const forged = { ...stranger.c, clientId: owner.client };
    await expect(listHashtagSets(forged)).resolves.toEqual([]);
    await expect(
      saveHashtagSet(forged, input("New", ["#x"])),
    ).rejects.toMatchObject({ status: 404 });

    await deleteHashtagSet(owner.c, set.id);
    expect(await listHashtagSets(owner.c)).toEqual([]);
  });
});

describe("receipts", () => {
  it("publish receipts keep their foreign keys to publish_jobs", async () => {
    const w = await workspace();
    const job = await publishJob(w, "facebook");
    const insert = (org: string, client: string, key = job.key) =>
      db.query(
        "INSERT INTO provider_receipts(idempotency_key,organization_id,client_id,provider,remote_id) VALUES($1,$2,$3,'meta:facebook','post-1')",
        [key, org, client],
      );
    const other = await workspace();
    await expect(insert(other.org, other.client)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insert(w.org, other.client)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      insert(w.org, w.client, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "23503" });
    await insert(w.org, w.client);
    await db.query("DELETE FROM publish_jobs WHERE id=$1", [job.jobId]);
    expect(
      (
        await db.query(
          "SELECT 1 FROM provider_receipts WHERE idempotency_key=$1",
          [job.key],
        )
      ).rows,
    ).toEqual([]);
  });

  it("first-comment receipts are scoped to their job and go with it", async () => {
    const w = await workspace();
    const job = await published(w, "facebook");
    const [queued] = await commentJobs(job.targetId);
    const insert = (org: string, client: string, key = queued.idempotency_key) =>
      db.query(
        "INSERT INTO first_comment_receipts(idempotency_key,organization_id,client_id,provider,remote_id) VALUES($1,$2,$3,'meta:facebook:comment','comment-1')",
        [key, org, client],
      );
    const other = await workspace();
    await expect(insert(other.org, other.client)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insert(w.org, other.client)).rejects.toMatchObject({
      code: "23503",
    });
    // A publish job's key is not a first-comment job: rejected.
    await expect(insert(w.org, w.client, job.key)).rejects.toMatchObject({
      code: "23503",
    });
    await insert(w.org, w.client);
    await db.query("DELETE FROM first_comment_jobs WHERE id=$1", [queued.id]);
    expect(
      (
        await db.query(
          "SELECT 1 FROM first_comment_receipts WHERE idempotency_key=$1",
          [queued.idempotency_key],
        )
      ).rows,
    ).toEqual([]);
  });
});

describe("media error codes", () => {
  it("uses stable codes and takes the image limit from MULTI_IMAGE_LIMIT", () => {
    expect(Object.values(MEDIA_ERRORS)).toEqual([
      "media.duplicate",
      "media.too_many",
      "media.images_only",
      "media.single",
    ]);
    expect(MEDIA_ERROR_TEXT["media.too_many"]).toContain(
      String(MULTI_IMAGE_LIMIT),
    );
    for (const locale of ["en", "hu"] as const)
      expect(composerMessages[locale]["validation.mediaTooMany"]).toContain(
        "{limit}",
      );
    const media = (id: string) => ({
      id,
      mime_type: "image/jpeg",
      size_bytes: 1,
      status: "READY",
    });
    expect(
      validatePost("linkedin", {
        caption: "x",
        media: [media("a"), media("b")],
      }),
    ).toEqual([MEDIA_ERRORS.single]);
  });
});
