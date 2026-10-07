import { PGlite } from "@electric-sql/pglite";
import { createHmac, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PGlite();

// Server code talks to `pool`; route it to an in-memory PGlite database.
vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    },
  };
});

const { encrypt } = await import("../packages/core/security");
const { metaGrantHash } = await import("../packages/server/meta");
const {
  handleMetaDataDeletion,
  handleMetaDeauthorize,
  metaDeletionStatus,
  parseSignedRequest,
} = await import("../packages/server/meta-compliance");

const secret = "app-secret-for-tests";

function signedRequest(payload: object, key = secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(encoded)
    .digest("base64url");
  return `${signature}.${encoded}`;
}

beforeAll(async () => {
  Object.assign(process.env, {
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    META_INTEGRATION_ENABLED: "true",
    META_APP_ID: "123",
    META_APP_SECRET: secret,
    META_GRAPH_VERSION: "v26.0",
    APP_URL: "https://hub.example",
  });
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function connectedAccount(
  org: string,
  client: string,
  platform: string,
  grantId: string,
  withHash: boolean,
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status,token_health,avatar)
     VALUES($1,$2,$3,$4,'Page',$5,'direct','CONNECTED','HEALTHY','https://cdn.example/a.png')`,
    [id, org, client, platform, crypto.randomUUID()],
  );
  const sealed = encrypt(
    JSON.stringify({
      version: 1,
      grantId,
      userAccessToken: "user-token",
      pageAccessToken: "page-token",
      pageId: "page-1",
    }),
    `${org}:${client}:${id}`,
  );
  await db.query(
    `INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value,grant_hash)
     VALUES($1,$2,$3,$4,$5)`,
    [org, client, id, sealed, withHash ? metaGrantHash(grantId) : null],
  );
  return id;
}

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
    [client, org],
  );
  return { org, client };
}

describe("Meta signed requests", () => {
  it("accepts a correctly signed request", () => {
    expect(
      parseSignedRequest(
        signedRequest({ algorithm: "HMAC-SHA256", user_id: "42" }),
        secret,
      ),
    ).toEqual({ userId: "42" });
  });

  it("rejects forged, tampered or malformed requests", () => {
    const valid = signedRequest({ algorithm: "HMAC-SHA256", user_id: "42" });
    const [signature] = valid.split(".");
    const tampered = `${signature}.${Buffer.from(
      JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "43" }),
    ).toString("base64url")}`;
    for (const value of [
      signedRequest({ algorithm: "HMAC-SHA256", user_id: "42" }, "other"),
      tampered,
      signedRequest({ algorithm: "none", user_id: "42" }),
      signedRequest({ algorithm: "HMAC-SHA256" }),
      "not-a-signed-request",
      undefined,
    ])
      expect(() => parseSignedRequest(value, secret)).toThrow(
        expect.objectContaining({ code: "META_SIGNED_REQUEST_INVALID" }),
      );
  });
});

describe("Meta callbacks", () => {
  it("deletes the person's tokens in every workspace and reports a status", async () => {
    const one = await workspace(),
      two = await workspace();
    const page = await connectedAccount(
      one.org,
      one.client,
      "facebook",
      "user-1",
      true,
    );
    // Stored before grant hashes existed: found by decrypting.
    const legacy = await connectedAccount(
      two.org,
      two.client,
      "instagram",
      "user-1",
      false,
    );
    const other = await connectedAccount(
      one.org,
      one.client,
      "instagram",
      "user-2",
      true,
    );
    const result = await handleMetaDataDeletion(
      signedRequest({ algorithm: "HMAC-SHA256", user_id: "user-1" }),
    );
    expect(result.url).toBe(
      `https://hub.example/meta/deletion/${result.confirmation_code}`,
    );
    const accounts = (
      await db.query<{ id: string; status: string; avatar: string | null }>(
        "SELECT id,status,avatar FROM social_accounts WHERE id=ANY($1::uuid[])",
        [[page, legacy, other]],
      )
    ).rows;
    const byId = Object.fromEntries(accounts.map((row) => [row.id, row]));
    expect(byId[page]).toMatchObject({ status: "DISCONNECTED", avatar: null });
    expect(byId[legacy]).toMatchObject({
      status: "DISCONNECTED",
      avatar: null,
    });
    expect(byId[other].status).toBe("CONNECTED");
    const credentials = (
      await db.query<{ social_account_id: string }>(
        "SELECT social_account_id FROM social_credentials WHERE social_account_id=ANY($1::uuid[])",
        [[page, legacy, other]],
      )
    ).rows.map((row) => row.social_account_id);
    expect(credentials).toEqual([other]);
    expect(await metaDeletionStatus(result.confirmation_code)).toMatchObject({
      status: "COMPLETED",
    });
    expect(await metaDeletionStatus("unknown-code-123")).toBeNull();
    const stored = (
      await db.query<{ user_hash: string }>(
        "SELECT user_hash FROM meta_data_deletion_requests WHERE confirmation_code=$1",
        [result.confirmation_code],
      )
    ).rows[0];
    expect(stored.user_hash).not.toContain("user-1");
  });

  it("disconnects but keeps account details when the app is deauthorized", async () => {
    const { org, client } = await workspace();
    const account = await connectedAccount(
      org,
      client,
      "facebook",
      "user-3",
      true,
    );
    await expect(
      handleMetaDeauthorize(
        signedRequest({ algorithm: "HMAC-SHA256", user_id: "user-3" }),
      ),
    ).resolves.toEqual({ disconnected: 1 });
    const row = (
      await db.query<{ status: string; avatar: string | null }>(
        "SELECT status,avatar FROM social_accounts WHERE id=$1",
        [account],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "DISCONNECTED",
      avatar: "https://cdn.example/a.png",
    });
    const audit = (
      await db.query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE resource_id=$1",
        [account],
      )
    ).rows;
    expect(audit).toEqual([{ action: "meta.deauthorized" }]);
  });

  it("refuses a deauthorize call with a forged signature", async () => {
    await expect(
      handleMetaDeauthorize(
        signedRequest({ algorithm: "HMAC-SHA256", user_id: "x" }, "forged"),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
