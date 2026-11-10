import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
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

const { createApiKey, generateApiKey, listApiKeys, revokeApiKey } =
  await import("../packages/server/api-keys");
const { updateClientExternalRef } = await import("../packages/server/clients");
const { GET } = await import("../apps/web/app/api/v1/clients/route");

type Role = "OWNER" | "ADMIN" | "SOCIAL_MANAGER" | "CONTENT_CREATOR" | "VIEWER";

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function workspace(role: Role = "OWNER") {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    user = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client A')",
    [client, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  return {
    org,
    client,
    c: { organizationId: org, clientId: client, userId: user, role },
  };
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const call = (authorization?: string) =>
  GET(
    new Request("http://localhost/api/v1/clients", {
      headers: authorization ? { authorization } : {},
    }),
  );

describe("API key management", () => {
  it("generates long random keys with a recognizable prefix", () => {
    const a = generateApiKey(),
      b = generateApiKey();
    expect(a.raw).toMatch(/^shk_live_[A-Za-z0-9_-]{43}$/);
    expect(a.raw).not.toBe(b.raw);
    expect(a.prefix).toBe(a.raw.slice(0, 15));
    expect(a.hash).toBe(sha256(a.raw));
  });

  it("stores only the SHA-256 hash and returns the raw key once", async () => {
    const w = await workspace();
    const created = await createApiKey(w.c, "Growth Engine");
    expect(created.key).toMatch(/^shk_live_/);
    const stored = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM api_keys WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(stored.key_hash).not.toBe(created.key);
    expect(stored.key_hash).toBe(sha256(created.key));
    expect(stored.key_prefix).toBe(created.key.slice(0, 15));
    expect(JSON.stringify(stored)).not.toContain(created.key);

    const listed = await listApiKeys(w.c);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual([
      "created_at",
      "id",
      "key_prefix",
      "last_used_at",
      "name",
      "revoked_at",
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });

  it("audits creation and revocation without the key or its hash", async () => {
    const w = await workspace("ADMIN");
    const created = await createApiKey(w.c, "Reporting");
    const revoked = await revokeApiKey(w.c, created.id);
    expect(revoked.revoked_at).toBeTruthy();
    const logs = (
      await db.query<{ action: string; metadata: Record<string, unknown> }>(
        "SELECT action,metadata FROM audit_logs WHERE resource_id=$1 ORDER BY created_at,action",
        [created.id],
      )
    ).rows;
    expect(logs.map((l) => l.action).sort()).toEqual([
      "api_key.created",
      "api_key.revoked",
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(created.key);
    expect(serialized).not.toContain(sha256(created.key));
    expect(logs[0].metadata).toMatchObject({
      name: "Reporting",
      prefix: created.key_prefix,
    });
    const row = (
      await db.query<{ revoked_by_user_id: string }>(
        "SELECT revoked_by_user_id FROM api_keys WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(row.revoked_by_user_id).toBe(w.c.userId);
    await expect(revokeApiKey(w.c, created.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("requires an organization owner or administrator", async () => {
    const owner = await workspace();
    const created = await createApiKey(owner.c, "Owner key");
    for (const role of ["SOCIAL_MANAGER", "VIEWER"] as const) {
      const c = { ...owner.c, role };
      await expect(createApiKey(c, "Nope")).rejects.toMatchObject({
        status: 403,
      });
      await expect(revokeApiKey(c, created.id)).rejects.toMatchObject({
        status: 403,
      });
      await expect(listApiKeys(c)).rejects.toMatchObject({ status: 403 });
    }
    const keys = await listApiKeys(owner.c);
    expect(keys).toHaveLength(1);
    expect(keys[0].revoked_at).toBeNull();
  });

  it("cannot revoke another organization's key", async () => {
    const one = await workspace();
    const two = await workspace();
    const created = await createApiKey(one.c, "Foreign");
    await expect(revokeApiKey(two.c, created.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await listApiKeys(one.c))[0].revoked_at).toBeNull();
  });
});

describe("GET /api/v1/clients", () => {
  it("rejects missing, invalid and revoked keys with the same error", async () => {
    const w = await workspace();
    const revoked = await createApiKey(w.c, "Old");
    await revokeApiKey(w.c, revoked.id);
    const responses = [
      await call(),
      await call("Bearer shk_live_doesnotexist"),
      await call(`Basic ${revoked.key}`),
      await call(`Bearer ${revoked.key}`),
    ];
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(bodies[index]).toEqual(bodies[0]);
    }
    expect(bodies[0]).toEqual({
      error: {
        code: "INVALID_API_KEY",
        message: "A valid API key is required.",
      },
    });
  });

  it("returns only the key organization's active clients and accounts", async () => {
    const w = await workspace();
    const other = await workspace();
    const deletedClient = crypto.randomUUID(),
      account = crypto.randomUUID(),
      deletedAccount = crypto.randomUUID(),
      foreignAccount = crypto.randomUUID();
    await db.query(
      "INSERT INTO clients(id,organization_id,name,deleted_at) VALUES($1,$2,'Gone',now())",
      [deletedClient, w.org],
    );
    await db.query(
      `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status,capabilities,deleted_at)
       VALUES($1,$3,$4,'facebook','Client Page','secret-remote-page','mock','CONNECTED','["publish"]',NULL),
             ($2,$3,$4,'instagram','Removed','secret-remote-removed','mock','CONNECTED','[]',now())`,
      [account, deletedAccount, w.org, w.client],
    );
    await db.query(
      `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
       VALUES($1,$2,$3,'linkedin','Foreign','secret-remote-foreign','mock')`,
      [foreignAccount, other.org, other.client],
    );
    await db.query(
      `INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value)
       VALUES($1,$2,$3,'encrypted-token-value')`,
      [w.org, w.client, account],
    );
    const key = await createApiKey(w.c, "Growth Engine");
    expect((await listApiKeys(w.c))[0].last_used_at).toBeNull();

    const response = await call(`Bearer ${key.key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      data: [
        {
          id: w.client,
          name: "Client A",
          external_ref: null,
          accounts: [
            {
              id: account,
              platform: "facebook",
              name: "Client Page",
              status: "CONNECTED",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(body);
    for (const secret of [
      "secret-remote",
      "encrypted-token-value",
      "publish",
      other.client,
      foreignAccount,
      deletedClient,
      deletedAccount,
    ])
      expect(serialized).not.toContain(secret);

    expect((await listApiKeys(w.c))[0].last_used_at).not.toBeNull();
  });
});

describe("client external_ref", () => {
  const stored = async (client: string) =>
    (
      await db.query<{ external_ref: string | null }>(
        "SELECT external_ref FROM clients WHERE id=$1",
        [client],
      )
    ).rows[0].external_ref;

  it("lets owners and admins set and clear it, with an audit entry", async () => {
    const w = await workspace();
    expect(await updateClientExternalRef(w.c, " viba-team ")).toEqual({
      external_ref: "viba-team",
    });
    expect(await stored(w.client)).toBe("viba-team");
    const admin = { ...w.c, role: "ADMIN" as const };
    await updateClientExternalRef(admin, "mmi");
    expect(await stored(w.client)).toBe("mmi");
    await updateClientExternalRef(admin, "");
    expect(await stored(w.client)).toBeNull();
    await updateClientExternalRef(w.c, "mmi");
    await updateClientExternalRef(w.c, null);
    expect(await stored(w.client)).toBeNull();

    const logs = (
      await db.query<{ action: string; actor_id: string; metadata: unknown }>(
        "SELECT action,actor_id,metadata FROM audit_logs WHERE resource_id=$1 ORDER BY created_at,id",
        [w.client],
      )
    ).rows;
    expect(logs.map((l) => l.metadata)).toEqual([
      { from: null, to: "viba-team" },
      { from: "viba-team", to: "mmi" },
      { from: "mmi", to: null },
      { from: null, to: "mmi" },
      { from: "mmi", to: null },
    ]);
    expect(new Set(logs.map((l) => l.action))).toEqual(
      new Set(["client.external_ref_updated"]),
    );
    expect(logs[0].actor_id).toBe(w.c.userId);
  });

  it("forbids other roles on the server", async () => {
    const w = await workspace();
    await updateClientExternalRef(w.c, "kept");
    for (const role of [
      "SOCIAL_MANAGER",
      "CONTENT_CREATOR",
      "VIEWER",
    ] as const) {
      await expect(
        updateClientExternalRef({ ...w.c, role }, "changed"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        updateClientExternalRef({ ...w.c, role }, null),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(await stored(w.client)).toBe("kept");
  });

  it("rejects malformed values with a 400", async () => {
    const w = await workspace();
    for (const value of [
      "Viba",
      "viba team",
      "viba_team",
      "á",
      "a".repeat(65),
      42,
      undefined,
    ])
      await expect(updateClientExternalRef(w.c, value)).rejects.toMatchObject({
        status: 400,
        code: "EXTERNAL_REF_INVALID",
        message: expect.stringContaining("kisbetűt"),
      });
    await updateClientExternalRef(w.c, "a".repeat(64));
    expect(await stored(w.client)).toBe("a".repeat(64));
  });

  it("is unique within an organization but not across them", async () => {
    const w = await workspace();
    const sibling = crypto.randomUUID();
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client B')",
      [sibling, w.org],
    );
    await updateClientExternalRef(w.c, "mmi");
    await expect(
      updateClientExternalRef({ ...w.c, clientId: sibling }, "mmi"),
    ).rejects.toMatchObject({
      status: 409,
      code: "EXTERNAL_REF_TAKEN",
      message: "Ez az azonosító már foglalt ennél a szervezetnél.",
    });
    expect(await stored(sibling)).toBeNull();

    const other = await workspace();
    await updateClientExternalRef(other.c, "mmi");
    expect(await stored(other.client)).toBe("mmi");
    // Setting the same value again is not a conflict with itself.
    await updateClientExternalRef(w.c, "mmi");
  });

  it("does not touch another organization's client", async () => {
    const one = await workspace();
    const two = await workspace();
    await expect(
      updateClientExternalRef({ ...two.c, clientId: one.client }, "stolen"),
    ).rejects.toMatchObject({ status: 404 });
    expect(await stored(one.client)).toBeNull();
  });

  it("is returned by GET /api/v1/clients", async () => {
    const w = await workspace();
    const sibling = crypto.randomUUID();
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client B')",
      [sibling, w.org],
    );
    await updateClientExternalRef(w.c, "viba-team");
    const key = await createApiKey(w.c, "Growth Engine");
    const body = await (await call(`Bearer ${key.key}`)).json();
    expect(
      body.data.map((c: { id: string; external_ref: string | null }) => [
        c.id,
        c.external_ref,
      ]),
    ).toEqual([
      [w.client, "viba-team"],
      [sibling, null],
    ]);
  });
});
