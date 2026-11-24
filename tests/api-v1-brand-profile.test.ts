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
// The /api/v1 rate limits count in Redis.
vi.mock("ioredis", async () => ({
  Redis: (await import("./fixtures/redis")).FakeRedis,
}));

const { createApiKey, revokeApiKey } = await import(
  "../packages/server/api-keys"
);
const { generateContent } = await import("../packages/server/ai");
const { saveLocalBrandProfile } = await import("../packages/server/clients");
const { requestApproval } = await import("../packages/server/approvals");
const { PUT } = await import(
  "../apps/web/app/api/v1/clients/[id]/brand-profile/route"
);

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

const localProfile = {
  brandName: "Acme",
  forbiddenTerminology: "cheap",
  toneOfVoice: "Local tone",
};

async function client(org: string, withProfile = true) {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client')",
    [id, org],
  );
  if (withProfile)
    await db.query(
      "INSERT INTO brand_profiles(organization_id,client_id,profile,updated_at) VALUES($1,$2,$3,'2026-01-01T00:00:00Z')",
      [org, id, JSON.stringify(localProfile)],
    );
  return id;
}

async function workspace() {
  const org = crypto.randomUUID(),
    user = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  const clientId = await client(org);
  const context = {
    organizationId: org,
    clientId,
    userId: user,
    role: "OWNER" as const,
  };
  const key = await createApiKey(context, "Growth Engine");
  return { org, user, clientId, key, context };
}

const body = {
  voice: "  Warm and direct  ",
  required_phrases: ["#acme", " G2A ", "g2a", ""],
  forbidden_phrases: ["miracle", "free, forever"],
  required_disclaimer: "Terms, conditions apply",
  pillars: [
    { name: "Education", description: "How-tos" },
    { name: "Community" },
  ],
};

const put = (id: string, payload: unknown, authorization?: string) =>
  PUT(
    new Request(`http://localhost/api/v1/clients/${id}/brand-profile`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );

const row = async (clientId: string) =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM brand_profiles WHERE client_id=$1",
      [clientId],
    )
  ).rows[0];

const syncAudits = async (clientId: string) =>
  (
    await db.query<{
      actor_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      "SELECT actor_id,metadata FROM audit_logs WHERE client_id=$1 AND action='brand.synced' ORDER BY created_at",
      [clientId],
    )
  ).rows;

describe("PUT /api/v1/clients/{id}/brand-profile", () => {
  it("stores the normalized synced profile and leaves the local profile alone", async () => {
    const w = await workspace();
    const before = await row(w.clientId);
    const response = await put(w.clientId, body, `Bearer ${w.key.key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json).toEqual({
      client_id: w.clientId,
      voice: "Warm and direct",
      required_phrases: ["#acme", "G2A"],
      forbidden_phrases: ["free, forever", "miracle"],
      required_disclaimer: "Terms, conditions apply",
      pillars: [
        { name: "Education", description: "How-tos" },
        { name: "Community", description: null },
      ],
      synced_source: "growth_engine",
      synced_at: expect.any(String),
    });
    const after = await row(w.clientId);
    expect(after.profile).toEqual(localProfile);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.synced_by_api_key_id).toBe(w.key.id);
    expect(after.synced_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: the same body writes and audits once", async () => {
    const w = await workspace();
    const first = await (
      await put(w.clientId, body, `Bearer ${w.key.key}`)
    ).json();
    const stored = await row(w.clientId);
    // Same content in another order and spacing normalizes to the same hash.
    const second = await put(
      w.clientId,
      {
        ...body,
        forbidden_phrases: ["free, forever ", "miracle", "Miracle"],
        required_phrases: ["G2A", "#acme"],
      },
      `Bearer ${w.key.key}`,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
    const third = await put(w.clientId, body, `Bearer ${w.key.key}`);
    expect(await third.json()).toEqual(first);
    expect(await row(w.clientId)).toEqual(stored);
    const audits = await syncAudits(w.clientId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_id: null,
      metadata: {
        source: "api",
        api_key_id: w.key.id,
        previous_hash: null,
        hash: stored.synced_hash,
        changed_fields: [
          "voice",
          "required_phrases",
          "forbidden_phrases",
          "required_disclaimer",
          "pillars",
        ],
      },
    });
  });

  it("replaces the whole profile and audits the changed fields", async () => {
    const w = await workspace();
    await put(w.clientId, body, `Bearer ${w.key.key}`);
    const firstHash = (await row(w.clientId)).synced_hash;
    const response = await put(
      w.clientId,
      { voice: "Warm and direct", forbidden_phrases: ["miracle"] },
      `Bearer ${w.key.key}`,
    );
    expect(await response.json()).toMatchObject({
      voice: "Warm and direct",
      required_phrases: [],
      forbidden_phrases: ["miracle"],
      required_disclaimer: null,
      pillars: [],
    });
    const audits = await syncAudits(w.clientId);
    expect(audits).toHaveLength(2);
    expect(audits[1].metadata).toEqual({
      source: "api",
      api_key_id: w.key.id,
      previous_hash: firstHash,
      hash: (await row(w.clientId)).synced_hash,
      changed_fields: [
        "required_phrases",
        "forbidden_phrases",
        "required_disclaimer",
        "pillars",
      ],
    });
  });

  it("creates the brand profile row when the client has none", async () => {
    const w = await workspace();
    const bare = await client(w.org, false);
    const response = await put(bare, body, `Bearer ${w.key.key}`);
    expect(response.status).toBe(200);
    const created = await row(bare);
    expect(created.profile).toEqual({});
    expect(created.synced_source).toBe("growth_engine");
  });

  it("rejects a missing, invalid or revoked API key with 401", async () => {
    const w = await workspace();
    expect((await put(w.clientId, body)).status).toBe(401);
    expect((await put(w.clientId, body, "Bearer shk_live_nope")).status).toBe(
      401,
    );
    await revokeApiKey(w.context, w.key.id);
    const revoked = await put(w.clientId, body, `Bearer ${w.key.key}`);
    expect(revoked.status).toBe(401);
    expect((await row(w.clientId)).synced_profile).toBeNull();
  });

  it("answers 404 the same way for unknown, deleted and foreign clients", async () => {
    const w = await workspace();
    const other = await workspace();
    const deleted = await client(w.org);
    await db.query("UPDATE clients SET deleted_at=now() WHERE id=$1", [
      deleted,
    ]);
    for (const id of [
      "not-a-uuid",
      crypto.randomUUID(),
      deleted,
      other.clientId,
    ]) {
      const response = await put(id, body, `Bearer ${w.key.key}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Client not found." },
      });
    }
    expect((await row(other.clientId)).synced_profile).toBeNull();
  });

  it("rejects invalid bodies with 400 in the v1 error format", async () => {
    const w = await workspace();
    const invalid: unknown[] = [
      { ...body, tone: "x" },
      { ...body, voice: 42 },
      { ...body, voice: "x".repeat(2001) },
      { ...body, forbidden_phrases: "miracle" },
      { ...body, forbidden_phrases: ["x".repeat(201)] },
      {
        ...body,
        required_phrases: Array.from({ length: 101 }, (_, i) => `p${i}`),
      },
      { ...body, required_disclaimer: ["Ad"] },
      { ...body, pillars: [{ description: "No name" }] },
      { ...body, pillars: [{ name: "A", color: "red" }] },
      [],
    ];
    for (const payload of invalid) {
      const response = await put(w.clientId, payload, `Bearer ${w.key.key}`);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error.code).toBe("VALIDATION");
      expect(typeof json.error.message).toBe("string");
    }
    const broken = await put(w.clientId, "{", `Bearer ${w.key.key}`);
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.code).toBe("INVALID_JSON");
    expect((await row(w.clientId)).synced_profile).toBeNull();
  });
});

describe("synced brand rules in Social Hub", () => {
  it("AI generation checks and snapshots the synced rules", async () => {
    const w = await workspace();
    await put(w.clientId, body, `Bearer ${w.key.key}`);
    const result = await generateContent(w.context, {
      operation: "generate",
      text: "A miracle offer",
      platforms: [],
    });
    const codes = result.guardrails.issues.map((issue) => issue.code);
    expect(codes).toContain("FORBIDDEN_TERM");
    expect(codes).toContain("DISCLAIMER_MISSING");
    const snapshot = (
      await db.query<{ brand_snapshot: Record<string, unknown> }>(
        "SELECT brand_snapshot FROM ai_generations WHERE id=$1",
        [result.id],
      )
    ).rows[0].brand_snapshot;
    expect(snapshot).toMatchObject({
      brandName: "Acme",
      toneOfVoice: "Warm and direct",
      forbiddenTerminology: ["cheap", "free, forever", "miracle"],
      requiredDisclaimer: ["Terms, conditions apply"],
      contentPillars: body.pillars.map((p) => ({
        name: p.name,
        description: p.description ?? null,
      })),
    });
  });

  it("approval requests are blocked by a synced forbidden phrase", async () => {
    const w = await workspace();
    const account = crypto.randomUUID(),
      post = crypto.randomUUID();
    await db.query(
      `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
       VALUES($1,$2,$3,'facebook','Page',$4,'mock')`,
      [account, w.org, w.clientId, `mock-${account}`],
    );
    const caption = "A miracle offer. Terms, conditions apply";
    await db.query(
      "INSERT INTO posts(id,organization_id,client_id,author_id,caption,status) VALUES($1,$2,$3,$4,$5,'DRAFT')",
      [post, w.org, w.clientId, w.user, caption],
    );
    await db.query(
      `INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,status)
       VALUES($1,$2,$3,$4,$5,'DRAFT')`,
      [w.org, w.clientId, post, account, caption],
    );
    await put(w.clientId, body, `Bearer ${w.key.key}`);
    await expect(requestApproval(w.context, post)).rejects.toMatchObject({
      code: "BRAND_GUARDRAIL",
      message: expect.stringContaining("miracle"),
    });
  });

  it("the local save keeps synced columns and drops synced* keys", async () => {
    const w = await workspace();
    await put(w.clientId, body, `Bearer ${w.key.key}`);
    const synced = await row(w.clientId);
    await saveLocalBrandProfile(w.context, {
      brandName: "Acme 2",
      synced_profile: "hack",
      syncedAt: "2020-01-01",
      synced_source: ["x"],
    });
    const after = await row(w.clientId);
    expect(after.profile).toEqual({ brandName: "Acme 2" });
    for (const column of [
      "synced_profile",
      "synced_at",
      "synced_source",
      "synced_by_api_key_id",
      "synced_hash",
    ])
      expect(after[column]).toEqual(synced[column]);
  });
});
