import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { createApiKey, revokeApiKey } = await import(
  "../packages/server/api-keys"
);
const { apiStatusCategory, requestHash } = await import(
  "../packages/server/api-v1-posts"
);
const { POST: postDrafts } = await import(
  "../apps/web/app/api/v1/clients/[id]/drafts/route"
);
const { GET: getPosts } = await import("../apps/web/app/api/v1/posts/route");

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function account(
  org: string,
  client: string,
  platform: string,
  status = "CONNECTED",
  deleted = false,
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status,deleted_at)
     VALUES($1,$2,$3,$4,'Account',$7,'mock',$5,$6)`,
    [id, org, client, platform, status, deleted ? new Date() : null, id],
  );
  return id;
}

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    sibling = crypto.randomUUID(),
    user = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'Client A'),($2,$3,'Client B')",
    [client, sibling, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  const c = {
    organizationId: org,
    clientId: client,
    userId: user,
    role: "OWNER" as const,
  };
  const key = await createApiKey(c, "Growth Engine");
  return {
    org,
    client,
    sibling,
    c,
    key,
    auth: `Bearer ${key.key}`,
    facebook: await account(org, client, "facebook"),
    linkedin: await account(org, client, "linkedin"),
    disconnected: await account(org, client, "instagram", "DISCONNECTED"),
    deleted: await account(org, client, "instagram", "CONNECTED", true),
    siblingAccount: await account(org, sibling, "facebook"),
  };
}

function drafts(
  clientId: string,
  options: {
    auth?: string;
    key?: string | null;
    body?: unknown;
    raw?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.auth) headers.authorization = options.auth;
  if (options.key !== null)
    headers["idempotency-key"] = options.key ?? crypto.randomUUID();
  return postDrafts(
    new Request(`http://localhost/api/v1/clients/${clientId}/drafts`, {
      method: "POST",
      headers,
      body: options.raw ?? JSON.stringify(options.body ?? {}),
    }),
    { params: Promise.resolve({ id: clientId }) },
  );
}

const posts = (query: string, auth?: string) =>
  getPosts(
    new Request(`http://localhost/api/v1/posts${query}`, {
      headers: auth ? { authorization: auth } : {},
    }),
  );

async function count(table: string, org: string) {
  return (
    await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE organization_id=$1`,
      [org],
    )
  ).rows[0].count;
}

async function counts(org: string) {
  return {
    posts: await count("posts", org),
    targets: await count("post_targets", org),
    versions: await count("post_versions", org),
    keys: await count("api_idempotency_keys", org),
  };
}

describe("API v1 authentication", () => {
  it("rejects missing and revoked keys before reading the request", async () => {
    const w = await workspace();
    const old = await createApiKey(w.c, "Old");
    await revokeApiKey(w.c, old.id);
    for (const auth of [undefined, `Bearer ${old.key}`]) {
      const created = await drafts(w.client, { auth, key: null, raw: "{" });
      expect(created.status).toBe(401);
      expect((await created.json()).error.code).toBe("INVALID_API_KEY");
      const listed = await posts("?limit=nope", auth);
      expect(listed.status).toBe(401);
      expect((await listed.json()).error.code).toBe("INVALID_API_KEY");
    }
    expect(await count("api_idempotency_keys", w.org)).toBe(0);
  });
});

describe("POST /api/v1/clients/{id}/drafts", () => {
  it("creates drafts that are never scheduled or sent for approval", async () => {
    const w = await workspace();
    const response = await drafts(w.client, {
      auth: w.auth,
      body: {
        drafts: [
          {
            text: "Main text",
            targets: [
              { social_account_id: w.facebook },
              { social_account_id: w.linkedin, text: "LinkedIn text" },
            ],
            suggested_at: "2026-12-01T09:30:00+01:00",
            media_urls: ["https://cdn.example.test/a.jpg"],
            pillar: "Education",
            source: "growth_engine",
          },
          { text: "Second", targets: [{ social_account_id: w.facebook }] },
        ],
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    for (const item of body.data)
      expect(item).toEqual({
        id: expect.any(String),
        status: "draft",
        raw_status: "DRAFT",
      });

    const rows = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM posts WHERE organization_id=$1 ORDER BY caption",
        [w.org],
      )
    ).rows;
    expect(rows.map((r) => r.id).sort()).toEqual(
      body.data.map((d: { id: string }) => d.id).sort(),
    );
    const first = rows.find((r) => r.caption === "Main text")!;
    expect(first).toMatchObject({
      client_id: w.client,
      status: "DRAFT",
      scheduled_at: null,
      author_id: null,
      pillar: "Education",
      source: "growth_engine",
      media_urls: ["https://cdn.example.test/a.jpg"],
    });
    expect((first.suggested_at as Date).toISOString()).toBe(
      "2026-12-01T08:30:00.000Z",
    );
    const second = rows.find((r) => r.caption === "Second")!;
    expect(second).toMatchObject({
      suggested_at: null,
      pillar: null,
      source: null,
      media_urls: null,
    });

    const targets = (
      await db.query<Record<string, unknown>>(
        "SELECT social_account_id,caption,status,media_ids FROM post_targets WHERE post_id=$1 ORDER BY caption",
        [first.id],
      )
    ).rows;
    expect(targets).toEqual([
      {
        social_account_id: w.linkedin,
        caption: "LinkedIn text",
        status: "DRAFT",
        media_ids: [],
      },
      {
        social_account_id: w.facebook,
        caption: "Main text",
        status: "DRAFT",
        media_ids: [],
      },
    ]);
    expect(await count("publish_jobs", w.org)).toBe(0);
    expect(await count("approval_requests", w.org)).toBe(0);
    expect(await count("media_assets", w.org)).toBe(0);

    const versions = (
      await db.query<{ post_id: string; revision: number }>(
        "SELECT post_id,revision FROM post_versions WHERE organization_id=$1",
        [w.org],
      )
    ).rows;
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.revision === 1)).toBe(true);
    const logs = (
      await db.query<{
        action: string;
        actor_id: string | null;
        client_id: string;
        resource_id: string;
        metadata: Record<string, unknown>;
      }>(
        "SELECT action,actor_id,client_id,resource_id,metadata FROM audit_logs WHERE organization_id=$1 AND action='post.created'",
        [w.org],
      )
    ).rows;
    expect(logs).toHaveLength(2);
    for (const log of logs)
      expect(log).toMatchObject({
        actor_id: null,
        client_id: w.client,
        metadata: { source: "api", api_key_id: w.key.id },
      });
  });

  it("replays the stored response for a repeated key without new posts", async () => {
    const w = await workspace();
    const key = crypto.randomUUID();
    const draft = {
      text: "Once",
      pillar: "News",
      targets: [{ social_account_id: w.facebook }],
    };
    const first = await drafts(w.client, {
      auth: w.auth,
      key,
      body: { drafts: [draft] },
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const before = await counts(w.org);

    // Same request, keys in a different order: still the same request.
    const again = await drafts(w.client, {
      auth: w.auth,
      key,
      raw: JSON.stringify({
        drafts: [
          {
            targets: draft.targets,
            pillar: "News",
            text: "Once",
          },
        ],
      }),
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(firstBody);
    expect(await counts(w.org)).toEqual(before);

    // The key belongs to the organization, not to a single API key.
    const second = await createApiKey(w.c, "Second integration");
    const other = await drafts(w.client, {
      auth: `Bearer ${second.key}`,
      key,
      body: { drafts: [draft] },
    });
    expect(other.status).toBe(201);
    expect(await other.json()).toEqual(firstBody);
    expect(await counts(w.org)).toEqual(before);
  });

  it("rejects a reused key with a different body or client without writing", async () => {
    const w = await workspace();
    const key = crypto.randomUUID();
    await drafts(w.client, {
      auth: w.auth,
      key,
      body: {
        drafts: [
          { text: "Original", targets: [{ social_account_id: w.facebook }] },
        ],
      },
    });
    const before = await counts(w.org);
    const changed = await drafts(w.client, {
      auth: w.auth,
      key,
      body: {
        drafts: [
          { text: "Changed", targets: [{ social_account_id: w.facebook }] },
        ],
      },
    });
    expect(changed.status).toBe(422);
    expect((await changed.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const otherClient = await drafts(w.sibling, {
      auth: w.auth,
      key,
      body: {
        drafts: [
          {
            text: "Original",
            targets: [{ social_account_id: w.siblingAccount }],
          },
        ],
      },
    });
    expect(otherClient.status).toBe(422);
    expect((await otherClient.json()).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await counts(w.org)).toEqual(before);
  });

  it("replays a response committed by a concurrent request with the same key", async () => {
    const w = await workspace();
    const key = crypto.randomUUID();
    const batch = [
      { text: "Race", targets: [{ social_account_id: w.facebook }] },
    ];
    const stored = { data: [{ id: crypto.randomUUID(), status: "draft" }] };
    // What the winning request leaves behind when it commits first.
    await db.query(
      `INSERT INTO api_idempotency_keys(organization_id,api_key_id,key,request_hash,response_status,response_body)
       VALUES($1,$2,$3,$4,201,$5)`,
      [
        w.org,
        w.key.id,
        key,
        requestHash(w.client, batch),
        JSON.stringify(stored),
      ],
    );
    const response = await drafts(w.client, {
      auth: w.auth,
      key,
      body: { drafts: batch },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(stored);
    expect(await count("posts", w.org)).toBe(0);
    await expect(
      db.query(
        `INSERT INTO api_idempotency_keys(organization_id,key,request_hash,response_status,response_body)
         VALUES($1,$2,$3,201,'{}')`,
        [w.org, key, "0".repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it("requires a well-formed Idempotency-Key header", async () => {
    const w = await workspace();
    const body = {
      drafts: [{ text: "Hi", targets: [{ social_account_id: w.facebook }] }],
    };
    for (const key of [
      null,
      "",
      "short",
      "has spaces in it",
      "x".repeat(129),
    ]) {
      const response = await drafts(w.client, { auth: w.auth, key, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: expect.any(String),
        },
      });
    }
    expect(await counts(w.org)).toMatchObject({ posts: 0, keys: 0 });
  });

  it("validates the body strictly and writes nothing on failure", async () => {
    const w = await workspace();
    const target = [{ social_account_id: w.facebook }];
    const cases: [unknown, number, string][] = [
      [{}, 422, "VALIDATION"],
      [{ drafts: [] }, 422, "VALIDATION"],
      [{ drafts: [{ text: "", targets: target }] }, 422, "VALIDATION"],
      [{ drafts: [{ text: "   ", targets: target }] }, 422, "VALIDATION"],
      [{ drafts: [{ text: "Hi", targets: [] }] }, 422, "VALIDATION"],
      [
        { drafts: [{ text: "Hi", targets: target, suggested_at: "tomorrow" }] },
        422,
        "VALIDATION",
      ],
      [
        {
          drafts: [
            {
              text: "Hi",
              targets: target,
              suggested_at: "2026-12-01T09:00:00",
            },
          ],
        },
        422,
        "VALIDATION",
      ],
      [
        {
          drafts: [
            {
              text: "Hi",
              targets: target,
              media_urls: ["http://x.test/a.jpg"],
            },
          ],
        },
        422,
        "VALIDATION",
      ],
      [
        { drafts: [{ text: "Hi", targets: target, scheduled_at: "now" }] },
        422,
        "VALIDATION",
      ],
      [
        {
          drafts: Array.from({ length: 51 }, () => ({
            text: "Hi",
            targets: target,
          })),
        },
        422,
        "VALIDATION",
      ],
      [
        {
          drafts: [
            {
              text: "Hi",
              targets: Array.from({ length: 16 }, () => ({
                social_account_id: crypto.randomUUID(),
              })),
            },
          ],
        },
        422,
        "VALIDATION",
      ],
      [
        {
          drafts: [{ text: "Hi", targets: [...target, ...target] }],
        },
        422,
        "DUPLICATE_TARGET",
      ],
    ];
    for (const [body, status, code] of cases) {
      const response = await drafts(w.client, { auth: w.auth, body });
      expect(response.status, JSON.stringify(body).slice(0, 120)).toBe(status);
      expect(await response.json()).toEqual({
        error: { code, message: expect.any(String) },
      });
    }
    const invalidJson = await drafts(w.client, { auth: w.auth, raw: "{" });
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json()).error.code).toBe("INVALID_JSON");
    const huge = await drafts(w.client, {
      auth: w.auth,
      raw: JSON.stringify({
        drafts: [{ text: "x".repeat(1_000_001), targets: target }],
      }),
    });
    expect(huge.status).toBe(413);
    expect((await huge.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(await counts(w.org)).toEqual({
      posts: 0,
      targets: 0,
      versions: 0,
      keys: 0,
    });
  });

  it("creates nothing when any draft in the batch is invalid", async () => {
    const w = await workspace();
    const key = crypto.randomUUID();
    const response = await drafts(w.client, {
      auth: w.auth,
      key,
      body: {
        drafts: [
          { text: "Fine", targets: [{ social_account_id: w.facebook }] },
          { text: "Broken", targets: [{ social_account_id: w.disconnected }] },
        ],
      },
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("ACCOUNT_NOT_CONNECTED");
    expect(await counts(w.org)).toEqual({
      posts: 0,
      targets: 0,
      versions: 0,
      keys: 0,
    });
    // A failed request does not consume its key.
    const retry = await drafts(w.client, {
      auth: w.auth,
      key,
      body: {
        drafts: [
          { text: "Fine", targets: [{ social_account_id: w.facebook }] },
        ],
      },
    });
    expect(retry.status).toBe(201);
  });

  it("returns 404 for another organization's client or a foreign account", async () => {
    const w = await workspace();
    const other = await workspace();
    const foreignClient = await drafts(other.client, {
      auth: w.auth,
      body: {
        drafts: [
          { text: "Hi", targets: [{ social_account_id: other.facebook }] },
        ],
      },
    });
    expect(foreignClient.status).toBe(404);
    expect((await foreignClient.json()).error.code).toBe("NOT_FOUND");
    const notUuid = await drafts("not-a-uuid", {
      auth: w.auth,
      body: {
        drafts: [{ text: "Hi", targets: [{ social_account_id: w.facebook }] }],
      },
    });
    expect(notUuid.status).toBe(404);
    for (const accountId of [w.siblingAccount, other.facebook, w.deleted]) {
      const response = await drafts(w.client, {
        auth: w.auth,
        body: {
          drafts: [
            { text: "Ok", targets: [{ social_account_id: w.facebook }] },
            { text: "Hi", targets: [{ social_account_id: accountId }] },
          ],
        },
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("ACCOUNT_NOT_FOUND");
    }
    expect(await counts(w.org)).toEqual({
      posts: 0,
      targets: 0,
      versions: 0,
      keys: 0,
    });
    expect(await counts(other.org)).toMatchObject({ posts: 0, keys: 0 });
  });
});

async function insertPost(
  org: string,
  client: string,
  status: string,
  updatedAt: string,
  extra: { deleted?: boolean } = {},
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,caption,status,updated_at,deleted_at)
     VALUES($1,$2,$3,'Post',$4,$5,$6)`,
    [id, org, client, status, updatedAt, extra.deleted ? new Date() : null],
  );
  return id;
}

describe("GET /api/v1/posts", () => {
  it("maps every post_status to a contract category", async () => {
    const values = (
      await db.query<{ value: string }>(
        "SELECT unnest(enum_range(NULL::post_status))::text AS value",
      )
    ).rows.map((r) => r.value);
    expect(Object.keys(apiStatusCategory).sort()).toEqual([...values].sort());
    const expected: Record<string, string> = {
      DRAFT: "draft",
      PENDING_APPROVAL: "pending_approval",
      APPROVED: "scheduled",
      SCHEDULED: "scheduled",
      QUEUED: "scheduled",
      PUBLISHING: "scheduled",
      PUBLISHED: "published",
      PARTIALLY_PUBLISHED: "published",
      FAILED: "failed",
      CANCELLED: "cancelled",
    };
    expect(apiStatusCategory).toEqual(expected);

    const w = await workspace();
    for (const [index, value] of values.entries())
      await insertPost(
        w.org,
        w.client,
        value,
        `2026-11-01T10:00:${String(index).padStart(2, "0")}Z`,
      );
    const body = await (await posts("?limit=200", w.auth)).json();
    expect(
      body.data.map((p: { raw_status: string; status: string }) => [
        p.raw_status,
        p.status,
      ]),
    ).toEqual(values.map((value) => [value, expected[value]]));
  });

  it("lists only the organization's live posts with targets", async () => {
    const w = await workspace();
    const other = await workspace();
    const live = await insertPost(
      w.org,
      w.client,
      "PARTIALLY_PUBLISHED",
      "2026-11-02T10:00:00Z",
    );
    await db.query(
      `INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,status,published_at,error_code)
       VALUES($1,$2,$3,$4,'a','PUBLISHED','2026-11-02T09:00:00Z',NULL),
             ($1,$2,$3,$5,'b','FAILED',NULL,'RATE_LIMITED')`,
      [w.org, w.client, live, w.facebook, w.linkedin],
    );
    await db.query(
      "UPDATE posts SET scheduled_at='2026-11-02T08:00:00Z' WHERE id=$1",
      [live],
    );
    const deleted = await insertPost(
      w.org,
      w.client,
      "DRAFT",
      "2026-11-02T10:00:00Z",
      { deleted: true },
    );
    const foreign = await insertPost(
      other.org,
      other.client,
      "DRAFT",
      "2026-11-02T10:00:00Z",
    );
    const response = await posts("", w.auth);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.next_cursor).toBeNull();
    expect(body.data).toHaveLength(1);
    const [post] = body.data;
    expect(post).toMatchObject({
      id: live,
      client_id: w.client,
      status: "published",
      raw_status: "PARTIALLY_PUBLISHED",
      scheduled_at: "2026-11-02T08:00:00.000Z",
      updated_at: "2026-11-02T10:00:00.000Z",
      suggested_at: null,
      media_urls: [],
    });
    expect(
      [...post.targets].sort((a: { network: string }, b: { network: string }) =>
        a.network.localeCompare(b.network),
      ),
    ).toEqual([
      {
        id: expect.any(String),
        social_account_id: w.facebook,
        network: "facebook",
        status: "published",
        raw_status: "PUBLISHED",
        published_at: "2026-11-02T09:00:00.000Z",
        error_code: null,
      },
      {
        id: expect.any(String),
        social_account_id: w.linkedin,
        network: "linkedin",
        status: "failed",
        raw_status: "FAILED",
        published_at: null,
        error_code: "RATE_LIMITED",
      },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(deleted);
    expect(serialized).not.toContain(foreign);
  });

  it("filters by client and since, and pages stably", async () => {
    const w = await workspace();
    const other = await workspace();
    const a = await insertPost(
      w.org,
      w.client,
      "DRAFT",
      "2026-11-03T10:00:00Z",
    );
    const b = await insertPost(
      w.org,
      w.client,
      "DRAFT",
      "2026-11-03T11:00:00Z",
    );
    const c = await insertPost(
      w.org,
      w.client,
      "DRAFT",
      "2026-11-03T11:00:00Z",
    );
    const d = await insertPost(
      w.org,
      w.sibling,
      "DRAFT",
      "2026-11-03T12:00:00Z",
    );

    const all = await (await posts("", w.auth)).json();
    const sameTime = [b, c].sort();
    expect(all.data.map((p: { id: string }) => p.id)).toEqual([
      a,
      ...sameTime,
      d,
    ]);

    const filtered = await (await posts(`?client=${w.sibling}`, w.auth)).json();
    expect(filtered.data.map((p: { id: string }) => p.id)).toEqual([d]);

    const since = await (
      await posts(
        `?since=${encodeURIComponent("2026-11-03T12:00:00+01:00")}`,
        w.auth,
      )
    ).json();
    expect(since.data.map((p: { id: string }) => p.id)).toEqual([
      ...sameTime,
      d,
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { id: string }[]; next_cursor: string | null } =
        await (
          await posts(
            `?client=${w.client}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
            w.auth,
          )
        ).json();
      expect(page.data.length).toBeLessThanOrEqual(1);
      seen.push(...page.data.map((p) => p.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual([a, ...sameTime]);

    const foreign = await posts(`?client=${other.client}`, w.auth);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Client not found." },
    });
  });

  it("rejects malformed query parameters", async () => {
    const w = await workspace();
    for (const query of [
      "?client=nope",
      "?since=yesterday",
      "?since=2026-11-03",
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?cursor=bm90LWpzb24",
    ]) {
      const response = await posts(query, w.auth);
      expect(response.status, query).toBe(400);
      const body = await response.json();
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    }
  });
});
