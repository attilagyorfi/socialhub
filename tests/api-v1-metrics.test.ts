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
const { parseMetricsRange } = await import("../packages/server/api-v1-metrics");
const { GET } = await import(
  "../apps/web/app/api/v1/clients/[id]/metrics/route"
);

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function client(org: string, name = "Client") {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,$3)",
    [id, org, name],
  );
  return id;
}

async function account(org: string, clientId: string, platform = "facebook") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
     VALUES($1,$2,$3,$4,'Page',$5,'mock')`,
    [id, org, clientId, platform, `mock-${id}`],
  );
  return id;
}

async function daily(
  org: string,
  clientId: string,
  accountId: string,
  day: string,
  reach: number,
) {
  await db.query(
    `INSERT INTO analytics_daily(organization_id,client_id,social_account_id,day,provider,raw,normalized)
     VALUES($1,$2,$3,$4,'facebook','{"secret":"raw"}',$5)`,
    [org, clientId, accountId, day, JSON.stringify({ reach })],
  );
}

async function target(org: string, clientId: string, accountId: string) {
  const post = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.query(
    "INSERT INTO posts(id,organization_id,client_id,caption,status) VALUES($1,$2,$3,'Hello','PUBLISHED')",
    [post, org, clientId],
  );
  await db.query(
    `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption,status)
     VALUES($1,$2,$3,$4,$5,'Hello','PUBLISHED')`,
    [id, org, clientId, post, accountId],
  );
  return { post, id };
}

async function capture(
  org: string,
  clientId: string,
  targetId: string,
  at: string,
  likes: number,
) {
  await db.query(
    `INSERT INTO post_metrics(organization_id,client_id,target_id,provider,raw,normalized,captured_at)
     VALUES($1,$2,$3,'facebook','{"secret":"raw"}',$4,$5)`,
    [org, clientId, targetId, JSON.stringify({ likes }), at],
  );
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
  const key = await createApiKey(
    { organizationId: org, clientId, userId: user, role: "OWNER" },
    "Growth Engine",
  );
  return { org, user, clientId, key };
}

const call = (id: string, query: string, authorization: string | undefined) =>
  GET(
    new Request(`http://localhost/api/v1/clients/${id}/metrics?${query}`, {
      headers: authorization ? { authorization } : {},
    }),
    { params: Promise.resolve({ id }) },
  );

describe("metrics range", () => {
  it("accepts up to 92 days and returns UTC capture bounds", () => {
    const range = parseMetricsRange(
      new URLSearchParams("from=2026-01-01&to=2026-04-02"),
    );
    expect(range).toEqual({
      from: "2026-01-01",
      to: "2026-04-02",
      capturedFrom: "2026-01-01T00:00:00.000Z",
      capturedBefore: "2026-04-03T00:00:00.000Z",
    });
    expect(
      parseMetricsRange(new URLSearchParams("from=2026-05-05&to=2026-05-05"))
        .capturedBefore,
    ).toBe("2026-05-06T00:00:00.000Z");
  });
});

describe("GET /api/v1/clients/{id}/metrics", () => {
  it("returns stored daily and latest post metrics within the range", async () => {
    const w = await workspace();
    const a = await account(w.org, w.clientId);
    const b = await account(w.org, w.clientId, "instagram");
    await daily(w.org, w.clientId, a, "2026-03-02", 20);
    await daily(w.org, w.clientId, a, "2026-03-01", 10);
    await daily(w.org, w.clientId, a, "2026-03-31", 31);
    await daily(w.org, w.clientId, a, "2026-02-28", 999);
    await daily(w.org, w.clientId, a, "2026-04-01", 999);
    await daily(w.org, w.clientId, b, "2026-03-15", 15);

    const t1 = await target(w.org, w.clientId, a);
    await capture(w.org, w.clientId, t1.id, "2026-03-01T00:00:00Z", 1);
    await capture(w.org, w.clientId, t1.id, "2026-03-31T23:59:59Z", 3);
    await capture(w.org, w.clientId, t1.id, "2026-03-10T12:00:00Z", 2);
    await capture(w.org, w.clientId, t1.id, "2026-04-01T00:00:00Z", 999);
    const t2 = await target(w.org, w.clientId, b);
    await capture(w.org, w.clientId, t2.id, "2026-02-28T23:59:59Z", 999);
    await capture(w.org, w.clientId, t2.id, "2026-03-01T00:00:00Z", 7);
    // Only captured outside the range: left out entirely.
    const t3 = await target(w.org, w.clientId, b);
    await capture(w.org, w.clientId, t3.id, "2026-04-02T00:00:00Z", 999);

    // Another client of the same organization must not leak in.
    const sibling = await client(w.org, "Sibling");
    const siblingAccount = await account(w.org, sibling);
    await daily(w.org, sibling, siblingAccount, "2026-03-05", 999);
    const siblingTarget = await target(w.org, sibling, siblingAccount);
    await capture(
      w.org,
      sibling,
      siblingTarget.id,
      "2026-03-05T00:00:00Z",
      999,
    );

    const response = await call(
      w.clientId,
      "from=2026-03-01&to=2026-03-31",
      `Bearer ${w.key.key}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const [first, second] = [a, b].sort();
    const days: Record<string, { day: string; metrics: unknown }[]> = {
      [a]: [
        { day: "2026-03-01", metrics: { reach: 10 } },
        { day: "2026-03-02", metrics: { reach: 20 } },
        { day: "2026-03-31", metrics: { reach: 31 } },
      ],
      [b]: [{ day: "2026-03-15", metrics: { reach: 15 } }],
    };
    expect(body).toEqual({
      client_id: w.clientId,
      from: "2026-03-01",
      to: "2026-03-31",
      accounts: [
        {
          social_account_id: first,
          provider: "facebook",
          days: days[first],
        },
        {
          social_account_id: second,
          provider: "facebook",
          days: days[second],
        },
      ],
      posts: [
        {
          post_id: t1.post,
          target_id: t1.id,
          provider: "facebook",
          captured_at: "2026-03-31T23:59:59.000Z",
          metrics: { likes: 3 },
        },
        {
          post_id: t2.post,
          target_id: t2.id,
          provider: "facebook",
          captured_at: "2026-03-01T00:00:00.000Z",
          metrics: { likes: 7 },
        },
      ].sort((x, y) => x.post_id.localeCompare(y.post_id)),
    });
    const serialized = JSON.stringify(body);
    for (const absent of ["999", "secret", sibling, t3.id, siblingAccount])
      expect(serialized).not.toContain(absent);
  });

  it("returns empty lists when nothing is stored", async () => {
    const w = await workspace();
    const body = await (
      await call(
        w.clientId,
        "from=2026-01-01&to=2026-01-31",
        `Bearer ${w.key.key}`,
      )
    ).json();
    expect(body).toEqual({
      client_id: w.clientId,
      from: "2026-01-01",
      to: "2026-01-31",
      accounts: [],
      posts: [],
    });
  });

  it("rejects missing, malformed, reversed and too long ranges", async () => {
    const w = await workspace();
    for (const query of [
      "",
      "from=2026-03-01",
      "to=2026-03-01",
      "from=&to=2026-03-01",
      "from=2026-3-1&to=2026-03-10",
      "from=2026-03-01T00:00:00Z&to=2026-03-10",
      "from=01-03-2026&to=2026-03-10",
      "from=2026-02-30&to=2026-03-10",
      "from=2026-03-01&to=2026-13-01",
      "from=2026-03-10&to=2026-03-01",
      "from=2026-01-01&to=2026-04-03",
      "from=2025-01-01&to=2026-01-01",
    ]) {
      const response = await call(w.clientId, query, `Bearer ${w.key.key}`);
      expect(response.status, query).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        error: { code: "INVALID_QUERY", message: expect.any(String) },
      });
    }
  });

  it("requires a valid, unrevoked API key", async () => {
    const w = await workspace();
    const old = await createApiKey(
      {
        organizationId: w.org,
        clientId: w.clientId,
        userId: w.user,
        role: "OWNER",
      },
      "Old",
    );
    await revokeApiKey(
      {
        organizationId: w.org,
        clientId: w.clientId,
        userId: w.user,
        role: "OWNER",
      },
      old.id,
    );
    const query = "from=2026-03-01&to=2026-03-31";
    for (const authorization of [
      undefined,
      "Bearer shk_live_doesnotexist",
      `Bearer ${old.key}`,
    ]) {
      const response = await call(w.clientId, query, authorization);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_API_KEY",
          message: "A valid API key is required.",
        },
      });
    }
  });

  it("answers 404 for foreign, unknown and deleted clients without data", async () => {
    const w = await workspace();
    const other = await workspace();
    const foreignAccount = await account(other.org, other.clientId);
    await daily(other.org, other.clientId, foreignAccount, "2026-03-05", 999);
    const foreignTarget = await target(
      other.org,
      other.clientId,
      foreignAccount,
    );
    await capture(
      other.org,
      other.clientId,
      foreignTarget.id,
      "2026-03-05T00:00:00Z",
      999,
    );
    const deleted = await client(w.org, "Gone");
    const deletedAccount = await account(w.org, deleted);
    await daily(w.org, deleted, deletedAccount, "2026-03-05", 999);
    await db.query("UPDATE clients SET deleted_at=now() WHERE id=$1", [
      deleted,
    ]);

    for (const id of [
      other.clientId,
      deleted,
      crypto.randomUUID(),
      "not-a-uuid",
    ]) {
      const response = await call(
        id,
        "from=2026-03-01&to=2026-03-31",
        `Bearer ${w.key.key}`,
      );
      expect(response.status, id).toBe(404);
      const body = await response.json();
      expect(body).toEqual({
        error: { code: "NOT_FOUND", message: "Client not found." },
      });
    }
  });
});
