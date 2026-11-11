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

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

const {
  buildLinkedInAuthorizationUrl,
  completeLinkedInOAuth,
  handleLinkedInCallback,
  linkedInCommentary,
  linkedInConfig,
  LinkedInClient,
  publishLinkedIn,
  startLinkedInOAuth,
} = await import("../packages/server/linkedin");
const { executePublish } = await import("../packages/server/publishing");
const { processPublishReconciliationJobsWith } = await import(
  "../packages/server/publish-reconciliation"
);
const { hashToken } = await import("../packages/core/security");

const ACCESS = "AQX-access-token-secret";
const REFRESH = "AQR-refresh-token-secret";
const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://hub.example/api/oauth/linkedin/callback",
  apiVersion: "202510",
};
const env = {
  LINKEDIN_INTEGRATION_ENABLED: "true",
  LINKEDIN_CLIENT_ID: config.clientId,
  LINKEDIN_CLIENT_SECRET: config.clientSecret,
  LINKEDIN_REDIRECT_URI: config.redirectUri,
  LINKEDIN_API_VERSION: config.apiVersion,
};

type Call = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

// Recorded LinkedIn responses; nothing leaves the process.
function linkedInFetch(
  routes: Partial<
    Record<
      "token" | "userinfo" | "initialize" | "upload" | "posts",
      (call: Call) => Response | Promise<Response>
    >
  > = {},
) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(call);
    const path = call.url.pathname;
    const route =
      path === "/oauth/v2/accessToken"
        ? "token"
        : path === "/v2/userinfo"
          ? "userinfo"
          : path === "/rest/images"
            ? "initialize"
            : path.startsWith("/dms-uploads/")
              ? "upload"
              : path === "/rest/posts"
                ? "posts"
                : undefined;
    const handler = route && routes[route];
    if (handler) return handler(call);
    if (route === "token")
      return Response.json({
        access_token: ACCESS,
        expires_in: 5_184_000,
        scope: "openid,profile,w_member_social",
      });
    if (route === "userinfo")
      return Response.json({ sub: "abc123", name: "Kiss Anna" });
    if (route === "initialize")
      return Response.json({
        value: {
          uploadUrl: "https://www.linkedin.com/dms-uploads/upload-1",
          image: "urn:li:image:C4D1",
        },
      });
    if (route === "upload") return new Response(null, { status: 201 });
    if (route === "posts")
      return new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:7001" },
      });
    throw new Error(`Unexpected request ${call.url}`);
  });
  return { impl: impl as unknown as typeof fetch, spy: impl, calls };
}

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => Object.assign(process.env, env));
afterEach(() => {
  for (const key of Object.keys(env)) delete process.env[key];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

async function connect(w: Workspace, token: Record<string, unknown> = {}) {
  const net = linkedInFetch({
    token: () =>
      Response.json({
        access_token: ACCESS,
        expires_in: 5_184_000,
        scope: "openid profile w_member_social",
        ...token,
      }),
  });
  const result = await completeLinkedInOAuth(
    w.c,
    "auth-code",
    new LinkedInClient(config, net.impl),
  );
  return result.accountId;
}

async function publishJob(w: Workspace, accountId: string, caption: string) {
  const postId = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,author_id,caption,status)
     VALUES($1,$2,$3,$4,$5,'SCHEDULED')`,
    [postId, w.org, w.client, w.user, caption],
  );
  const targetId = crypto.randomUUID();
  await db.query(
    `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption,status)
     VALUES($1,$2,$3,$4,$5,$6,'QUEUED')`,
    [targetId, w.org, w.client, postId, accountId, caption],
  );
  const jobId = (
    await db.query<{ id: string }>(
      `INSERT INTO publish_jobs(organization_id,client_id,target_id,run_at)
       VALUES($1,$2,$3,now()-interval '1 second') RETURNING id`,
      [w.org, w.client, targetId],
    )
  ).rows[0].id;
  return { postId, targetId, jobId };
}

// Receipts reference a real publish job.
async function jobKey(w: Workspace, accountId: string) {
  const job = await publishJob(w, accountId, "caption");
  return (
    await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM publish_jobs WHERE id=$1",
      [job.jobId],
    )
  ).rows[0].idempotency_key;
}

const image = (id = crypto.randomUUID(), mime = "image/png") => ({
  id,
  mime_type: mime,
  size_bytes: 4,
  status: "READY",
  object_key: `org/client/${id}`,
});

describe("LinkedIn configuration", () => {
  it.each(Object.keys(env))(
    "stays PROVIDER_NOT_CONFIGURED without %s and starts no OAuth",
    async (missing) => {
      delete process.env[missing];
      const w = await workspace();
      const net = linkedInFetch();
      vi.stubGlobal("fetch", net.impl);
      expect(() => linkedInConfig()).toThrowError(
        expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }),
      );
      await expect(startLinkedInOAuth(w.c)).rejects.toMatchObject({
        code: "PROVIDER_NOT_CONFIGURED",
      });
      await expect(
        handleLinkedInCallback(
          { state: "x", code: "y", error: null },
          async () => w.c,
        ),
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
      const states = await db.query(
        "SELECT 1 FROM oauth_states WHERE user_id=$1",
        [w.user],
      );
      expect(states.rows).toHaveLength(0);
      expect(net.spy).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed API version and a foreign redirect path", () => {
    process.env.LINKEDIN_API_VERSION = "latest";
    expect(() => linkedInConfig()).toThrowError(
      expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }),
    );
    process.env.LINKEDIN_API_VERSION = "202510";
    process.env.LINKEDIN_REDIRECT_URI = "https://hub.example/elsewhere";
    expect(() => linkedInConfig()).toThrowError(
      expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }),
    );
  });
});

describe("LinkedIn OAuth", () => {
  it("stores a hashed, expiring state and asks for the member scopes", async () => {
    const w = await workspace();
    const { url } = await startLinkedInOAuth(w.c);
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(authorize.searchParams.get("scope")).toBe(
      "openid profile w_member_social",
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    const state = authorize.searchParams.get("state")!;
    const row = (
      await db.query<{
        state_hash: string;
        provider: string;
        minutes: number;
      }>(
        "SELECT state_hash,provider,extract(epoch FROM expires_at-now())/60 AS minutes FROM oauth_states WHERE user_id=$1",
        [w.user],
      )
    ).rows[0];
    expect(row.provider).toBe("linkedin");
    expect(row.state_hash).toBe(hashToken(state));
    expect(row.state_hash).not.toContain(state);
    expect(Number(row.minutes)).toBeGreaterThan(9);
    expect(Number(row.minutes)).toBeLessThanOrEqual(10);
  });

  it("builds the authorization URL from the configuration", () => {
    const url = new URL(buildLinkedInAuthorizationUrl(config, "opaque"));
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("opaque");
  });

  it("rejects missing, forged, expired, reused and foreign states", async () => {
    const w = await workspace();
    const other = await workspace();
    const net = linkedInFetch();
    const client = new LinkedInClient(config, net.impl);
    const callback = (state: string | null, c = w.c) =>
      handleLinkedInCallback(
        { state, code: "auth-code", error: null },
        async () => c,
        client,
      );
    await expect(callback(null)).rejects.toMatchObject({
      code: "OAUTH_STATE_MISSING",
    });
    await expect(callback("forged")).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID",
    });

    const expired = new URL(
      (await startLinkedInOAuth(w.c)).url,
    ).searchParams.get("state")!;
    await db.query(
      "UPDATE oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
      [hashToken(expired)],
    );
    await expect(callback(expired)).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID",
    });

    const state = new URL((await startLinkedInOAuth(w.c)).url).searchParams.get(
      "state",
    )!;
    // Another organization, or the same client with another user.
    await expect(callback(state, other.c)).rejects.toMatchObject({
      code: "OAUTH_SESSION_MISMATCH",
    });
    await expect(
      callback(state, { ...w.c, clientId: other.client }),
    ).rejects.toMatchObject({ code: "OAUTH_SESSION_MISMATCH" });
    await expect(
      callback(state, { ...w.c, userId: other.user }),
    ).rejects.toMatchObject({ code: "OAUTH_SESSION_MISMATCH" });
    expect(net.spy).not.toHaveBeenCalled();

    await expect(callback(state)).resolves.toMatchObject({ connected: 1 });
    await expect(callback(state)).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID",
    });
  });

  it("refuses a grant without w_member_social and stores nothing", async () => {
    const w = await workspace();
    const net = linkedInFetch({
      token: () =>
        Response.json({
          access_token: ACCESS,
          expires_in: 3600,
          scope: "openid,profile",
        }),
    });
    await expect(
      completeLinkedInOAuth(w.c, "code", new LinkedInClient(config, net.impl)),
    ).rejects.toMatchObject({ code: "LINKEDIN_SCOPE_MISSING" });
    expect(net.calls.map((call) => call.url.pathname)).toEqual([
      "/oauth/v2/accessToken",
    ]);
    const accounts = await db.query(
      "SELECT 1 FROM social_accounts WHERE client_id=$1",
      [w.client],
    );
    const credentials = await db.query(
      "SELECT 1 FROM social_credentials WHERE client_id=$1",
      [w.client],
    );
    expect(accounts.rows).toHaveLength(0);
    expect(credentials.rows).toHaveLength(0);
  });

  it("connects the member profile with an encrypted, expiring token", async () => {
    const w = await workspace();
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
    ];
    const net = linkedInFetch({
      token: (call) => {
        const body = call.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(config.redirectUri);
        return Response.json({
          access_token: ACCESS,
          expires_in: 5_184_000,
          refresh_token: REFRESH,
          refresh_token_expires_in: 31_536_000,
          scope: "openid,profile,w_member_social",
        });
      },
    });
    const result = await completeLinkedInOAuth(
      w.c,
      "auth-code",
      new LinkedInClient(config, net.impl),
    );
    expect(JSON.stringify(result)).not.toMatch(/AQX|AQR/);
    const userinfo = net.calls.find(
      (call) => call.url.pathname === "/v2/userinfo",
    );
    expect(userinfo?.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    const account = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM social_accounts WHERE id=$1",
        [result.accountId],
      )
    ).rows[0];
    expect(account).toMatchObject({
      platform: "linkedin",
      mode: "direct",
      remote_id: "urn:li:person:abc123",
      name: "Kiss Anna",
      status: "CONNECTED",
      token_health: "HEALTHY",
    });
    const credential = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM social_credentials WHERE social_account_id=$1",
        [result.accountId],
      )
    ).rows[0];
    expect(credential.expires_at).toBeInstanceOf(Date);
    expect(
      (credential.expires_at as Date).getTime() - Date.now(),
    ).toBeGreaterThan(59 * 86400000);
    expect(JSON.stringify([account, credential])).not.toMatch(/AQX|AQR/);
    for (const spy of logged)
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/AQX|AQR/);
  });
});

describe("LinkedIn publishing", () => {
  it("publishes a text post once and stores the receipt", async () => {
    const w = await workspace();
    const accountId = await connect(w);
    const net = linkedInFetch();
    vi.stubGlobal("fetch", net.impl);
    const job = await publishJob(w, accountId, "Hello #LinkedIn (launch)");
    await expect(executePublish(job.jobId)).resolves.toMatchObject({
      status: "PUBLISHED",
    });
    const posts = net.calls.filter(
      (call) => call.url.pathname === "/rest/posts",
    );
    expect(net.calls).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    expect(posts[0].headers).toMatchObject({
      Authorization: `Bearer ${ACCESS}`,
      "LinkedIn-Version": "202510",
      "X-Restli-Protocol-Version": "2.0.0",
    });
    const body = JSON.parse(String(posts[0].body));
    expect(body).toMatchObject({
      author: "urn:li:person:abc123",
      commentary: "Hello {hashtag|\\#|LinkedIn} \\(launch\\)",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
    expect(body.content).toBeUndefined();
    const receipt = (
      await db.query<{ provider: string; remote_id: string }>(
        "SELECT r.provider,r.remote_id FROM provider_receipts r JOIN publish_jobs j ON j.idempotency_key=r.idempotency_key WHERE j.id=$1",
        [job.jobId],
      )
    ).rows[0];
    expect(receipt).toEqual({
      provider: "linkedin",
      remote_id: "urn:li:share:7001",
    });
    const target = (
      await db.query<{ status: string; remote_id: string }>(
        "SELECT status,remote_id FROM post_targets WHERE id=$1",
        [job.targetId],
      )
    ).rows[0];
    expect(target).toEqual({
      status: "PUBLISHED",
      remote_id: "urn:li:share:7001",
    });
  });

  it("uploads one stored image before creating the post", async () => {
    const w = await workspace();
    const accountId = await connect(w);
    const net = linkedInFetch();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const media = image();
    const readObject = vi.fn(async () => bytes);
    const result = await publishLinkedIn(
      {
        organizationId: w.org,
        clientId: w.client,
        accountId,
        content: { caption: "Picture", media: [media] },
        idempotencyKey: await jobKey(w, accountId),
      },
      { client: new LinkedInClient(config, net.impl), readObject },
    );
    expect(result.remoteId).toBe("urn:li:share:7001");
    expect(readObject).toHaveBeenCalledWith(media.object_key);
    expect(
      net.calls.map((call) => `${call.method} ${call.url.pathname}`),
    ).toEqual([
      "POST /rest/images",
      "PUT /dms-uploads/upload-1",
      "POST /rest/posts",
    ]);
    const [initialize, upload, post] = net.calls;
    expect(initialize.url.searchParams.get("action")).toBe("initializeUpload");
    expect(JSON.parse(String(initialize.body))).toEqual({
      initializeUploadRequest: { owner: "urn:li:person:abc123" },
    });
    expect(upload.url.toString()).toBe(
      "https://www.linkedin.com/dms-uploads/upload-1",
    );
    expect(upload.body).toBe(bytes);
    expect(JSON.parse(String(post.body)).content).toEqual({
      media: { id: "urn:li:image:C4D1" },
    });
  });

  it("does not send the token to an upload URL outside LinkedIn", async () => {
    const w = await workspace();
    const accountId = await connect(w);
    const net = linkedInFetch({
      initialize: () =>
        Response.json({
          value: {
            uploadUrl: "https://169.254.169.254/latest",
            image: "urn:li:image:X",
          },
        }),
    });
    await expect(
      publishLinkedIn(
        {
          organizationId: w.org,
          clientId: w.client,
          accountId,
          content: { caption: "Picture", media: [image()] },
          idempotencyKey: await jobKey(w, accountId),
        },
        {
          client: new LinkedInClient(config, net.impl),
          readObject: async () => new Uint8Array([1]),
        },
      ),
    ).rejects.toMatchObject({ code: "LINKEDIN_UPLOAD_URL_INVALID" });
    expect(net.calls.map((call) => call.url.hostname)).toEqual([
      "api.linkedin.com",
    ]);
  });

  it.each([
    ["several images", [image(), image()], "LINKEDIN_MEDIA_UNSUPPORTED"],
    ["a video", [image(undefined, "video/mp4")], "LINKEDIN_MEDIA_UNSUPPORTED"],
  ])("rejects %s without a network call", async (_name, media, code) => {
    const w = await workspace();
    const accountId = await connect(w);
    const net = linkedInFetch();
    await expect(
      publishLinkedIn(
        {
          organizationId: w.org,
          clientId: w.client,
          accountId,
          content: { caption: "Many", media },
          idempotencyKey: await jobKey(w, accountId),
        },
        { client: new LinkedInClient(config, net.impl) },
      ),
    ).rejects.toMatchObject({ code });
    expect(net.spy).not.toHaveBeenCalled();
  });

  it("rejects a company page author without a network call", async () => {
    const w = await workspace();
    const accountId = await connect(w);
    await db.query(
      "UPDATE social_accounts SET remote_id='urn:li:organization:42' WHERE id=$1",
      [accountId],
    );
    const net = linkedInFetch();
    await expect(
      publishLinkedIn(
        {
          organizationId: w.org,
          clientId: w.client,
          accountId,
          content: { caption: "Company", media: [] },
          idempotencyKey: await jobKey(w, accountId),
        },
        { client: new LinkedInClient(config, net.impl) },
      ),
    ).rejects.toMatchObject({ code: "LINKEDIN_ORGANIZATION_UNSUPPORTED" });
    expect(net.spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", () => new Response("{}", { status: 503 })],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ])(
    "marks %s after the post request as uncertain and reconciles it by hand",
    async (_name, posts) => {
      const w = await workspace();
      const accountId = await connect(w);
      const net = linkedInFetch({ posts });
      vi.stubGlobal("fetch", net.impl);
      const job = await publishJob(w, accountId, "Maybe live");
      await expect(executePublish(job.jobId)).resolves.toMatchObject({
        status: "FAILED",
        errorCode: "LINKEDIN_DELIVERY_UNCERTAIN",
      });
      const state = (
        await db.query<{ status: string; last_error: string }>(
          "SELECT status,last_error FROM publish_jobs WHERE id=$1",
          [job.jobId],
        )
      ).rows[0];
      expect(state).toEqual({
        status: "DEAD",
        last_error: "LINKEDIN_DELIVERY_UNCERTAIN",
      });
      await db.query(
        "UPDATE publish_reconciliation_jobs SET run_at=now()-interval '1 second' WHERE publish_job_id=$1",
        [job.jobId],
      );
      const findMeta = vi.fn(async () => []);
      const outcome = await processPublishReconciliationJobsWith(
        5,
        findMeta,
        w.org,
      );
      expect(outcome).toMatchObject({ confirmed: 0, unresolved: 1 });
      expect(findMeta).not.toHaveBeenCalled();
      const reconciliation = (
        await db.query<{ status: string; last_error: string }>(
          "SELECT status,last_error FROM publish_reconciliation_jobs WHERE publish_job_id=$1",
          [job.jobId],
        )
      ).rows[0];
      expect(reconciliation).toEqual({
        status: "UNRESOLVED",
        last_error: "LINKEDIN_RECONCILIATION_MANUAL",
      });
      // Exactly one delivery attempt and nothing else: no retry, no Graph call.
      expect(
        net.calls.filter((call) => call.url.pathname === "/rest/posts"),
      ).toHaveLength(1);
      expect(
        net.calls.every((call) => call.url.hostname.endsWith("linkedin.com")),
      ).toBe(true);
      await executePublish(job.jobId);
      expect(
        net.calls.filter((call) => call.url.pathname === "/rest/posts"),
      ).toHaveLength(1);
    },
  );

  it("refreshes an expired token before publishing", async () => {
    const w = await workspace();
    const accountId = await connect(w, {
      refresh_token: REFRESH,
      refresh_token_expires_in: 31_536_000,
    });
    await db.query(
      "UPDATE social_credentials SET expires_at=now()-interval '1 minute' WHERE social_account_id=$1",
      [accountId],
    );
    const before = (
      await db.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM social_credentials WHERE social_account_id=$1",
        [accountId],
      )
    ).rows[0].encrypted_value;
    const net = linkedInFetch({
      token: (call) => {
        const body = call.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe(REFRESH);
        return Response.json({
          access_token: "AQX-renewed-token",
          expires_in: 5_184_000,
          refresh_token: REFRESH,
          refresh_token_expires_in: 30_000_000,
          scope: "openid,profile,w_member_social",
        });
      },
    });
    await publishLinkedIn(
      {
        organizationId: w.org,
        clientId: w.client,
        accountId,
        content: { caption: "Fresh", media: [] },
        idempotencyKey: await jobKey(w, accountId),
      },
      { client: new LinkedInClient(config, net.impl) },
    );
    const post = net.calls.find((call) => call.url.pathname === "/rest/posts");
    expect(post?.headers.Authorization).toBe("Bearer AQX-renewed-token");
    const stored = (
      await db.query<{ encrypted_value: string; expires_at: Date }>(
        "SELECT encrypted_value,expires_at FROM social_credentials WHERE social_account_id=$1",
        [accountId],
      )
    ).rows[0];
    expect(stored.encrypted_value).not.toBe(before);
    expect(stored.encrypted_value).not.toMatch(/AQX|AQR/);
    expect(stored.expires_at.getTime()).toBeGreaterThan(
      Date.now() + 59 * 86400000,
    );
    const health = (
      await db.query<{ token_health: string }>(
        "SELECT token_health FROM social_accounts WHERE id=$1",
        [accountId],
      )
    ).rows[0].token_health;
    expect(health).toBe("HEALTHY");
  });

  it.each([
    ["no refresh token", {}, undefined],
    [
      "a refused refresh",
      { refresh_token: REFRESH, refresh_token_expires_in: 31_536_000 },
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    ],
  ])(
    "asks for a reconnect with %s and does not publish",
    async (_name, grant, token) => {
      const w = await workspace();
      const accountId = await connect(w, grant);
      await db.query(
        "UPDATE social_credentials SET expires_at=now()-interval '1 minute' WHERE social_account_id=$1",
        [accountId],
      );
      const net = linkedInFetch(token ? { token } : {});
      vi.stubGlobal("fetch", net.impl);
      const job = await publishJob(w, accountId, "Stale");
      await expect(executePublish(job.jobId)).resolves.toMatchObject({
        status: "FAILED",
        errorCode: "LINKEDIN_TOKEN_EXPIRED",
      });
      expect(
        net.calls.filter((call) => call.url.pathname === "/rest/posts"),
      ).toHaveLength(0);
      const health = (
        await db.query<{ token_health: string }>(
          "SELECT token_health FROM social_accounts WHERE id=$1",
          [accountId],
        )
      ).rows[0].token_health;
      expect(health).toBe("EXPIRED");
      const state = (
        await db.query<{ status: string }>(
          "SELECT status FROM publish_jobs WHERE id=$1",
          [job.jobId],
        )
      ).rows[0].status;
      expect(state).toBe("DEAD");
    },
  );
});

describe("LinkedIn commentary", () => {
  it("escapes little-format markup and appends a missing link", () => {
    expect(linkedInCommentary("a_b @c [d]", "https://x.example/p")).toBe(
      "a\\_b \\@c \\[d\\]\n\nhttps://x.example/p",
    );
    expect(
      linkedInCommentary("see https://x.example", "https://x.example"),
    ).toBe("see https://x.example");
  });
});
