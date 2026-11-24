import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FakeRedis } from "./fixtures/redis";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("ioredis", async () => ({
  Redis: (await import("./fixtures/redis")).FakeRedis,
}));

const { createApiKey } = await import("../packages/server/api-keys");
const { rateLimit, rateLimitWithRetry } = await import(
  "../packages/server/queue"
);
const { apiKeyRequestLimit, authFailureLimit, clientIp } = await import(
  "../apps/web/app/api/v1/handler"
);
const { GET } = await import("../apps/web/app/api/v1/clients/route");

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => FakeRedis.reset());

async function apiKey() {
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
  const c = {
    organizationId: org,
    clientId: client,
    userId: user,
    role: "OWNER" as const,
  };
  return createApiKey(c, "Growth Engine");
}

const call = (authorization?: string, ip = "198.51.100.7") =>
  GET(
    new Request("http://localhost/api/v1/clients", {
      headers: {
        "x-real-ip": ip,
        ...(authorization ? { authorization } : {}),
      },
    }),
  );

async function expectRateLimited(response: Response, retryAfter?: number) {
  expect(response.status).toBe(429);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const header = response.headers.get("retry-after");
  expect(header).toMatch(/^[1-9][0-9]*$/);
  if (retryAfter !== undefined) expect(Number(header)).toBe(retryAfter);
  expect(await response.json()).toEqual({
    error: { code: "RATE_LIMITED", message: "Too many requests. Retry later." },
  });
}

describe("rate limit helpers", () => {
  it("keeps rateLimit's boolean contract", async () => {
    for (let i = 0; i < 3; i++) expect(await rateLimit("legacy", 3)).toBe(true);
    expect(await rateLimit("legacy", 3)).toBe(false);
  });

  it("returns the remaining window and can check without counting", async () => {
    let now = 1_000_000;
    FakeRedis.now = () => now;
    expect(await rateLimitWithRetry("k", 2, 60)).toEqual({
      allowed: true,
      retryAfter: 60,
    });
    now += 20_000;
    expect(await rateLimitWithRetry("k", 2, 60, false)).toEqual({
      allowed: true,
      retryAfter: 40,
    });
    expect((await rateLimitWithRetry("k", 2, 60)).allowed).toBe(true);
    expect(await rateLimitWithRetry("k", 2, 60, false)).toEqual({
      allowed: false,
      retryAfter: 40,
    });
    expect(FakeRedis.store.get("rate:k")?.value).toBe(2);
  });

  it("takes the client IP like better-auth does", () => {
    const ip = (headers: Record<string, string>) =>
      clientIp(new Request("http://localhost/", { headers }));
    expect(
      ip({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" }),
    ).toBe("203.0.113.5");
    expect(ip({ "x-forwarded-for": " 203.0.113.6 , 10.0.0.1" })).toBe(
      "203.0.113.6",
    );
    expect(ip({})).toBe("unknown");
  });
});

describe("/api/v1 rate limits", () => {
  it("limits each API key by its id, with Retry-After from the window", async () => {
    let now = 5_000_000;
    FakeRedis.now = () => now;
    const key = await apiKey();
    const other = await apiKey();
    for (let i = 0; i < apiKeyRequestLimit; i++)
      expect((await call(`Bearer ${key.key}`)).status).toBe(200);
    now += 45_000;
    await expectRateLimited(await call(`Bearer ${key.key}`), 15);
    // Another key, even from the same address, has its own budget.
    expect((await call(`Bearer ${other.key}`)).status).toBe(200);
    const stored = [...FakeRedis.store.keys()];
    expect(stored).toContain(`rate:api-v1-key:${key.id}`);
    expect(stored.join()).not.toContain(key.key);
    now += 15_000;
    expect((await call(`Bearer ${key.key}`)).status).toBe(200);
  });

  it("blocks an IP after repeated failed authentication, before any key check", async () => {
    const key = await apiKey();
    for (let i = 0; i < authFailureLimit; i++)
      expect((await call("Bearer shk_live_wrong")).status).toBe(401);
    await expectRateLimited(await call("Bearer shk_live_wrong"));
    // Even a valid key is refused from that address, without being used.
    await expectRateLimited(await call(`Bearer ${key.key}`));
    expect(
      (
        await db.query("SELECT last_used_at FROM api_keys WHERE id=$1", [
          key.id,
        ])
      ).rows[0],
    ).toEqual({ last_used_at: null });
    expect([...FakeRedis.store.keys()]).not.toContain(
      `rate:api-v1-key:${key.id}`,
    );
    // Other addresses are unaffected.
    expect((await call(`Bearer ${key.key}`, "198.51.100.8")).status).toBe(200);
  });

  it("does not spend the failure budget on successful requests", async () => {
    const key = await apiKey();
    for (let i = 0; i < authFailureLimit + 5; i++)
      expect((await call(`Bearer ${key.key}`)).status).toBe(200);
    for (let i = 0; i < authFailureLimit; i++)
      expect((await call()).status).toBe(401);
    await expectRateLimited(await call());
  });

  it("uses the first x-forwarded-for address without x-real-ip", async () => {
    const request = (forwarded: string) =>
      GET(
        new Request("http://localhost/api/v1/clients", {
          headers: { "x-forwarded-for": forwarded },
        }),
      );
    for (let i = 0; i < authFailureLimit; i++)
      expect((await request(`203.0.113.9, 10.0.0.${i}`)).status).toBe(401);
    await expectRateLimited(await request("203.0.113.9, 10.0.0.99"));
    expect((await request("203.0.113.10, 10.0.0.1")).status).toBe(401);
  });

  it("answers 503 when Redis is unavailable instead of skipping the limit", async () => {
    const key = await apiKey();
    FakeRedis.failing = true;
    const response = await call(`Bearer ${key.key}`);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
