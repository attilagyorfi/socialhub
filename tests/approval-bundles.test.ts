import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
const rateLimit = vi.fn(async (_key: string) => true);
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: (key: string) => rateLimit(key),
}));

process.env.APP_URL = "http://localhost:3010";

const { hashToken, token } = await import("../packages/core/security");
const {
  bundleMedia,
  bundleStatus,
  bundleView,
  createApprovalBundle,
  decideBundle,
  listApprovalBundles,
  revokeApprovalBundle,
} = await import("../packages/server/approval-bundles");
const { decideApproval } = await import("../packages/server/approvals");
const route = await import("../apps/web/app/api/approval-bundle/[token]/route");

type Role = "OWNER" | "ADMIN" | "SOCIAL_MANAGER" | "CONTENT_CREATOR";

const period = {
  periodStart: "2026-12-01T00:00:00Z",
  periodEnd: "2027-01-01T00:00:00Z",
};
const uuidPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => {
  rateLimit.mockClear();
  rateLimit.mockImplementation(async () => true);
});

async function workspace(role: Role = "OWNER", org = crypto.randomUUID()) {
  const client = crypto.randomUUID(),
    user = crypto.randomUUID(),
    account = crypto.randomUUID();
  const created = await db.query(
    "INSERT INTO organizations(id,name) VALUES($1,'agency') ON CONFLICT DO NOTHING RETURNING id",
    [org],
  );
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client A')",
    [client, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
     VALUES($1,$2,$3,'facebook','Client page','remote-1','mock')`,
    [account, org, client],
  );
  // Every workspace subscribes to approval webhooks, so the outbox shows
  // exactly which events a decision produced.
  if (created.rows.length)
    await db.query(
      `INSERT INTO webhook_endpoints(organization_id,url,secret_ciphertext,secret_prefix,events)
       VALUES($1,'https://hooks.example.com/social','unused','whsec_test',
         ARRAY['post.approved','post.changes_requested'])`,
      [org],
    );
  return {
    org,
    client,
    account,
    c: { organizationId: org, clientId: client, userId: user, role },
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function post(
  w: Workspace,
  options: {
    at?: string;
    status?: string;
    review?: "EXTERNAL" | "INTERNAL" | null;
    caption?: string;
  } = {},
) {
  const id = crypto.randomUUID();
  const caption = options.caption ?? "December launch";
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,caption,status,scheduled_at)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      id,
      w.org,
      w.client,
      caption,
      options.status ?? "PENDING_APPROVAL",
      options.at ?? "2026-12-10T09:00:00Z",
    ],
  );
  await db.query(
    `INSERT INTO post_versions(organization_id,client_id,post_id,revision,snapshot)
     VALUES($1,$2,$3,1,$4)`,
    [
      w.org,
      w.client,
      id,
      JSON.stringify({
        targets: [{ accountId: w.account, caption, mediaIds: [] }],
      }),
    ],
  );
  const secret = token();
  const review = options.review === undefined ? "EXTERNAL" : options.review;
  if (review)
    await db.query(
      `INSERT INTO approval_requests(
         organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind
       ) VALUES($1,$2,$3,1,$4,now()+interval '7 days',$5)`,
      [w.org, w.client, id, hashToken(secret), review],
    );
  return { id, secret };
}

async function bundleSecret(w: Workspace) {
  const bundle = await createApprovalBundle(w.c, period);
  return { ...bundle, secret: bundle.url.split("/").at(-1)! };
}

async function events(org: string) {
  return (
    await db.query<{ event_type: string; payload: { data: { post_id: string } } }>(
      "SELECT event_type,payload FROM webhook_deliveries WHERE organization_id=$1 ORDER BY created_at",
      [org],
    )
  ).rows.map((row) => [row.event_type, row.payload.data.post_id]);
}

async function postStatus(id: string) {
  return (
    await db.query<{ status: string }>("SELECT status FROM posts WHERE id=$1", [
      id,
    ])
  ).rows[0].status;
}

function get(secret: string) {
  return route.GET(
    new Request(`http://localhost:3010/api/approval-bundle/${secret}`),
    { params: Promise.resolve({ token: secret }) },
  );
}
function post_(secret: string, body: unknown, origin = "http://localhost:3010") {
  return route.POST(
    new Request(`http://localhost:3010/api/approval-bundle/${secret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token: secret }) },
  );
}

describe("creating a bundle", () => {
  it("takes only this client's posts waiting for client review in the period", async () => {
    const w = await workspace();
    const sameOrgOtherClient = await workspace("OWNER", w.org);
    const otherOrg = await workspace();
    const first = await post(w, { at: "2026-12-20T09:00:00Z" });
    const second = await post(w, { at: "2026-12-02T09:00:00Z" });
    await post(w, { status: "DRAFT", review: null });
    await post(w, { review: "INTERNAL" });
    await post(w, { status: "APPROVED", review: null });
    await post(w, { at: "2027-01-01T00:00:00Z" });
    await post(sameOrgOtherClient);
    await post(otherOrg);

    const bundle = await bundleSecret(w);
    expect(bundle).toMatchObject({
      items: 2,
      skipped: 3,
      skippedReasons: {
        DRAFT: 1,
        INTERNAL_REVIEW: 1,
        EXPIRED_REVIEW: 0,
        NOT_PENDING: 1,
      },
    });
    expect(bundle.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const items = (
      await db.query<{ post_id: string; position: number }>(
        "SELECT post_id,position FROM approval_bundle_posts WHERE bundle_id=$1 ORDER BY position",
        [bundle.id],
      )
    ).rows;
    expect(items).toEqual([
      { post_id: second.id, position: 1 },
      { post_id: first.id, position: 2 },
    ]);
    const stored = (
      await db.query<{ token_hash: string; created_by: string }>(
        "SELECT * FROM approval_bundles WHERE id=$1",
        [bundle.id],
      )
    ).rows[0];
    expect(stored.token_hash).toBe(hashToken(bundle.secret));
    expect(JSON.stringify(stored)).not.toContain(bundle.secret);
    expect(stored.created_by).toBe(w.c.userId);
  });

  it("rejects empty bundles, long periods and long expiries", async () => {
    const w = await workspace();
    await expect(createApprovalBundle(w.c, period)).rejects.toMatchObject({
      code: "BUNDLE_EMPTY",
    });
    await post(w);
    await expect(
      createApprovalBundle(w.c, {
        periodStart: "2026-12-01T00:00:00Z",
        periodEnd: "2027-02-02T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PERIOD" });
    await expect(
      createApprovalBundle(w.c, {
        periodStart: period.periodEnd,
        periodEnd: period.periodStart,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PERIOD" });
    await expect(
      createApprovalBundle(w.c, { ...period, expiresInDays: 31 }),
    ).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
  });

  it("is limited to managers and to the caller's own organization", async () => {
    const w = await workspace();
    const other = await workspace();
    const creator = await workspace("CONTENT_CREATOR");
    await post(w);
    await post(creator);
    await expect(createApprovalBundle(creator.c, period)).rejects.toMatchObject(
      { status: 403 },
    );
    const bundle = await bundleSecret(w);
    // A foreign organization cannot reach the bundle, even with its ID.
    const foreign = { ...other.c, clientId: w.client };
    expect(await listApprovalBundles(other.c)).toEqual([]);
    expect(await listApprovalBundles(foreign)).toEqual([]);
    await expect(bundleStatus(foreign, bundle.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(revokeApprovalBundle(foreign, bundle.id)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      revokeApprovalBundle(other.c, bundle.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await bundleView(bundle.secret)).summary.pending).toBe(1);
    const [listed] = await listApprovalBundles(w.c);
    expect(listed).toMatchObject({ id: bundle.id, state: "ACTIVE" });
    expect(JSON.stringify(listed)).not.toContain(bundle.secret);
  });
});

describe("deciding on a bundle", () => {
  it("approves every waiting post at once, one webhook per post", async () => {
    const w = await workspace();
    const posts = [await post(w), await post(w), await post(w)];
    const bundle = await bundleSecret(w);
    // One post is approved on its own link before the client opens the bundle.
    await decideApproval(posts[0].secret, "approve", "");

    expect(await decideBundle(bundle.secret, { action: "approve_all" })).toEqual(
      { approved: 2, skipped: 1 },
    );
    for (const p of posts) expect(await postStatus(p.id)).toBe("APPROVED");
    const recorded = await events(w.org);
    expect(recorded).toHaveLength(3);
    expect(recorded.every(([type]) => type === "post.approved")).toBe(true);
    expect(new Set(recorded.map(([, id]) => id))).toEqual(
      new Set(posts.map((p) => p.id)),
    );
    const audits = (
      await db.query<{ metadata: { bundleId?: string } }>(
        "SELECT metadata FROM audit_logs WHERE organization_id=$1 AND action='approval.approve'",
        [w.org],
      )
    ).rows;
    expect(audits.filter((a) => a.metadata.bundleId === bundle.id)).toHaveLength(
      2,
    );

    // Nothing left to decide: no further events.
    expect(await decideBundle(bundle.secret, { action: "approve_all" })).toEqual(
      { approved: 0, skipped: 3 },
    );
    expect(await events(w.org)).toHaveLength(3);
    expect((await bundleStatus(w.c, bundle.id)).summary).toEqual({
      total: 3,
      approved: 3,
      changesRequested: 0,
      pending: 0,
      unavailable: 0,
    });
  });

  it("records a change request like the per-post link does", async () => {
    const w = await workspace();
    const target = await post(w);
    const bundle = await bundleSecret(w);
    await expect(
      decideBundle(bundle.secret, { action: "changes", item: 1, comment: " " }),
    ).rejects.toMatchObject({ code: "COMMENT_REQUIRED" });
    expect(
      await decideBundle(bundle.secret, {
        action: "changes",
        item: 1,
        comment: "Use the new logo",
      }),
    ).toEqual({ item: 1, status: "CHANGES_REQUESTED" });
    expect(await postStatus(target.id)).toBe("DRAFT");
    const comments = (
      await db.query<{ author: string; body: string }>(
        `SELECT c.author,c.body FROM approval_comments c
         JOIN approval_requests ar ON ar.id=c.approval_request_id
         WHERE ar.post_id=$1`,
        [target.id],
      )
    ).rows;
    expect(comments).toEqual([
      { author: "External reviewer", body: "Use the new logo" },
    ]);
    expect(await events(w.org)).toEqual([
      ["post.changes_requested", target.id],
    ]);
    const audit = (
      await db.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_logs WHERE resource_id=$1 AND action='approval.changes'",
        [target.id],
      )
    ).rows[0];
    expect(audit.metadata).toMatchObject({
      actor: "external-reviewer",
      bundleId: bundle.id,
    });
    const view = await bundleView(bundle.secret);
    expect(view.items[0]).toMatchObject({
      state: "CHANGES_REQUESTED",
      comments: [{ author: "External reviewer", body: "Use the new logo" }],
    });
  });

  it("keeps partial decisions and shows them on return", async () => {
    const w = await workspace();
    await post(w, { at: "2026-12-03T09:00:00Z", caption: "First" });
    await post(w, { at: "2026-12-04T09:00:00Z", caption: "Second" });
    await post(w, { at: "2026-12-05T09:00:00Z", caption: "Third" });
    const bundle = await bundleSecret(w);
    await decideBundle(bundle.secret, { action: "approve", item: 2, comment: "" });
    const view = await bundleView(bundle.secret);
    expect(
      view.items.map((item) => [item.item, item.caption, item.state]),
    ).toEqual([
      [1, "First", "PENDING"],
      [2, "Second", "APPROVED"],
      [3, "Third", "PENDING"],
    ]);
    expect(view.summary).toMatchObject({ total: 3, approved: 1, pending: 2 });
    expect(view.items[0].versions).toEqual([
      {
        platform: "facebook",
        name: "Client page",
        caption: "First",
        media: [],
      },
    ]);
  });

  it("never decides a post twice, whichever link comes first", async () => {
    const w = await workspace();
    const viaBundle = await post(w, { at: "2026-12-03T09:00:00Z" });
    const viaLink = await post(w, { at: "2026-12-04T09:00:00Z" });
    const bundle = await bundleSecret(w);

    await decideBundle(bundle.secret, { action: "approve", item: 1, comment: "" });
    await expect(
      decideBundle(bundle.secret, { action: "approve", item: 1, comment: "" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      decideBundle(bundle.secret, {
        action: "changes",
        item: 1,
        comment: "Too late",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      decideApproval(viaBundle.secret, "approve", ""),
    ).rejects.toMatchObject({ status: 409 });

    await decideApproval(viaLink.secret, "approve", "");
    const response = await post_(bundle.secret, {
      action: "approve",
      item: 2,
    });
    expect(response.status).toBe(409);
    expect((await bundleView(bundle.secret)).items[1].state).toBe("APPROVED");

    expect(await events(w.org)).toEqual([
      ["post.approved", viaBundle.id],
      ["post.approved", viaLink.id],
    ]);
  });
});

describe("public bundle endpoint", () => {
  it("shows the bundle without internal IDs", async () => {
    const w = await workspace();
    await post(w);
    const bundle = await bundleSecret(w);
    const response = await get(bundle.secret);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await response.json();
    expect(body.client_name).toBe("Client A");
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(uuidPattern);
  });

  it("answers expired, revoked, deleted and unknown links identically", async () => {
    const expired = await workspace();
    await post(expired);
    const expiredBundle = await bundleSecret(expired);
    await db.query(
      "UPDATE approval_bundles SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [expiredBundle.id],
    );
    const revoked = await workspace();
    const revokedPost = await post(revoked);
    const revokedBundle = await bundleSecret(revoked);
    await revokeApprovalBundle(revoked.c, revokedBundle.id);
    expect((await listApprovalBundles(revoked.c))[0].state).toBe("REVOKED");
    const deleted = await workspace();
    await post(deleted);
    const deletedBundle = await bundleSecret(deleted);
    await db.query("UPDATE clients SET deleted_at=now() WHERE id=$1", [
      deleted.client,
    ]);

    const secrets = [
      expiredBundle.secret,
      revokedBundle.secret,
      deletedBundle.secret,
      token(),
      "not-a-token",
    ];
    const answers = [];
    for (const secret of secrets) {
      const read = await get(secret);
      const write = await post_(secret, { action: "approve_all" });
      answers.push([read.status, await read.json()]);
      answers.push([write.status, await write.json()]);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([
        JSON.stringify([
          404,
          {
            error: "This approval link is invalid or expired.",
            code: "EXPIRED",
          },
        ]),
      ]),
    );
    expect(await postStatus(revokedPost.id)).toBe("PENDING_APPROVAL");
    expect(await events(revoked.org)).toEqual([]);
  });

  it("serves only the bundle's own ready attachments", async () => {
    const w = await workspace();
    const other = await workspace();
    const media = async (owner: Workspace, status = "READY") => {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
         VALUES($1,$2,$3,'photo.jpg',$4,'image/jpeg',10,$5)`,
        [id, owner.org, owner.client, `${owner.org}/${id}`, status],
      );
      return id;
    };
    const ready = await media(w);
    const processing = await media(w, "PROCESSING");
    const foreign = await media(other);
    const target = await post(w);
    await db.query("UPDATE post_versions SET snapshot=$1 WHERE post_id=$2", [
      JSON.stringify({
        targets: [
          {
            accountId: w.account,
            caption: "With photos",
            mediaIds: [ready, processing, foreign],
          },
        ],
      }),
      target.id,
    ]);
    const bundle = await bundleSecret(w);
    const view = await bundleView(bundle.secret);
    expect(view.items[0].versions[0].media).toEqual([
      { file: "0-0", name: "photo.jpg", mime_type: "image/jpeg" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(uuidPattern);
    expect(await bundleMedia(bundle.secret, 1, "0-0")).toEqual({
      object_key: `${w.org}/${ready}`,
      mime_type: "image/jpeg",
    });
    for (const [item, file] of [
      [1, "0-1"],
      [1, "0-2"],
      [1, "1-0"],
      [2, "0-0"],
    ] as const)
      await expect(bundleMedia(bundle.secret, item, file)).rejects.toMatchObject(
        { status: 404 },
      );
    await revokeApprovalBundle(w.c, bundle.id);
    await expect(bundleMedia(bundle.secret, 1, "0-0")).rejects.toMatchObject({
      status: 404,
      code: "EXPIRED",
    });
  });

  it("checks origin and rate limits decisions by token hash", async () => {
    const w = await workspace();
    const target = await post(w);
    const bundle = await bundleSecret(w);
    expect(
      (await post_(bundle.secret, { action: "approve_all" }, "https://evil.test"))
        .status,
    ).toBe(403);
    rateLimit.mockImplementation(async () => false);
    expect((await post_(bundle.secret, { action: "approve_all" })).status).toBe(
      429,
    );
    expect(rateLimit).toHaveBeenCalledWith(
      `approval-bundle:${hashToken(bundle.secret)}`,
    );
    expect(await postStatus(target.id)).toBe("PENDING_APPROVAL");
    rateLimit.mockImplementation(async () => true);
    expect(
      (await post_(bundle.secret, { action: "changes", item: 1 })).status,
    ).toBe(400);
    const approved = await post_(bundle.secret, { action: "approve_all" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ approved: 1, skipped: 0 });
  });
});
