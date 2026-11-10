import { PGlite } from "@electric-sql/pglite";
import { createHmac, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import type { WebhookRequest } from "../packages/server/webhooks";
import {
  afterAll,
  afterEach,
  beforeAll,
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
  assertPublicWebhookUrl,
  createWebhookEndpoint,
  enqueueWebhookEvent,
  listWebhookEndpoints,
  maxWebhookAttempts,
  pinnedHttpsSend,
  pinnedLookup,
  processWebhookDeliveries,
  revokeWebhookEndpoint,
  rotateWebhookSecret,
  sendWebhook,
  signWebhook,
  webhookTimeoutMs,
} = await import("../packages/server/webhooks");
const { transaction } = await import("../packages/server/transaction");
const { decideApproval } = await import("../packages/server/approvals");
const { executePublish } = await import("../packages/server/publishing");
const { processPublishReconciliationJobsWith } = await import(
  "../packages/server/publish-reconciliation"
);
const { operationalSummary } = await import("../packages/server/operations");

type Role = "OWNER" | "ADMIN" | "SOCIAL_MANAGER" | "CONTENT_CREATOR" | "VIEWER";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
afterEach(() => vi.useRealTimers());

async function workspace(role: Role = "OWNER") {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    user = crypto.randomUUID(),
    author = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name,external_ref) VALUES($1,$2,'Client A','ge-42')",
    [client, org],
  );
  await db.query(
    `INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2),($3,'Author',$4)`,
    [user, `${user}@example.test`, author, `${author}@example.test`],
  );
  return {
    org,
    client,
    author,
    c: { organizationId: org, clientId: client, userId: user, role },
  };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

async function endpoint(w: Workspace, events?: string[]) {
  return createWebhookEndpoint(
    w.c,
    {
      url: "https://hooks.example.com/social",
      events: (events ?? [
        "post.approved",
        "post.changes_requested",
        "post.published",
        "post.failed",
      ]) as never,
    },
    publicLookup,
  );
}

async function deliveries(org: string) {
  return (
    await db.query<{
      event_id: string;
      event_type: string;
      payload: Record<string, unknown> & { data: Record<string, unknown> };
      status: string;
      attempts: number;
      last_error: string | null;
      last_status_code: number | null;
      run_at: Date;
      endpoint_id: string;
    }>(
      "SELECT * FROM webhook_deliveries WHERE organization_id=$1 ORDER BY created_at",
      [org],
    )
  ).rows;
}

async function post(w: Workspace, status = "PENDING_APPROVAL") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,author_id,caption,status)
     VALUES($1,$2,$3,$4,'Secret launch caption',$5)`,
    [id, w.org, w.client, w.author, status],
  );
  return id;
}

async function approvalRequest(
  w: Workspace,
  postId: string,
  stepKind: "INTERNAL" | "EXTERNAL",
  remaining: string[] = [],
) {
  const secret = crypto.randomUUID();
  await db.query(
    `INSERT INTO approval_requests(
       organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind,remaining_steps
     ) VALUES($1,$2,$3,1,$4,now()+interval '1 day',$5,$6)`,
    [
      w.org,
      w.client,
      postId,
      createHmac("sha256", "unused").update(secret).digest("hex"),
      stepKind,
      JSON.stringify(remaining),
    ],
  );
  return secret;
}

describe("SSRF protection", () => {
  const rejected = [
    "http://hooks.example.com/",
    "https://localhost/",
    "https://api.localhost/",
    "https://127.0.0.1/",
    "https://127.5.6.7/",
    "https://0.0.0.0/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://172.31.255.255/",
    "https://192.168.1.1/",
    "https://100.64.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://224.0.0.1/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fd12:3456::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://2130706433/",
    "https://user:pass@hooks.example.com/",
    "not a url",
  ];
  for (const url of rejected)
    it(`rejects ${url}`, async () => {
      const lookup = vi.fn(publicLookup);
      await expect(assertPublicWebhookUrl(url, lookup)).rejects.toMatchObject({
        code: "WEBHOOK_URL_BLOCKED",
      });
    });

  it("checks every resolved address of a host", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      assertPublicWebhookUrl("https://rebind.example.com/", lookup),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(lookup).toHaveBeenCalledWith("rebind.example.com");
    for (const address of ["127.0.0.1", "::1", "fe80::1", "::ffff:127.0.0.1"])
      await expect(
        assertPublicWebhookUrl("https://a.example.com/", async () => [
          { address, family: address.includes(":") ? 6 : 4 },
        ]),
      ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
  });

  it("rejects unresolvable hosts and accepts public HTTPS hosts", async () => {
    await expect(
      assertPublicWebhookUrl("https://missing.example.com/", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_UNRESOLVABLE" });
    const url = await assertPublicWebhookUrl(
      "https://hooks.example.com/in?x=1",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ],
    );
    expect(url.toString()).toBe("https://hooks.example.com/in?x=1");
  });
});

describe("signing and sending", () => {
  it("signs timestamp.body with HMAC-SHA256", () => {
    expect(signWebhook("whsec_test", 1700000000, '{"id":"evt"}')).toBe(
      "sha256=a94cea056df1fbb92eadafcf2c5cd541dbe0c6ef736e4748202dd53f86694a3e",
    );
  });

  it("sends the contract headers to the checked addresses", async () => {
    const send = vi.fn(async (_request: WebhookRequest) => 204);
    const result = await sendWebhook(
      {
        url: "https://hooks.example.com/",
        secret: "whsec_test",
        eventId: "evt-1",
        type: "post.approved",
      },
      '{"id":"evt"}',
      { send, lookup: publicLookup, now: () => 1700000000_500 },
    );
    expect(result).toEqual({ ok: true, statusCode: 204 });
    const [request] = send.mock.calls[0];
    expect(request.url.toString()).toBe("https://hooks.example.com/");
    expect(request.addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-SocialHub-Event-Id": "evt-1",
      "X-SocialHub-Event": "post.approved",
      "X-SocialHub-Timestamp": "1700000000",
      "X-SocialHub-Signature": signWebhook(
        "whsec_test",
        1700000000,
        '{"id":"evt"}',
      ),
    });
  });

  it("treats redirects as failures and never calls blocked hosts", async () => {
    const send = vi.fn(async () => 302);
    const delivery = {
      url: "https://hooks.example.com/",
      secret: "s",
      eventId: "e",
      type: "post.failed",
    };
    expect(
      await sendWebhook(delivery, "{}", {
        send,
        lookup: publicLookup,
        now: Date.now,
      }),
    ).toEqual({ ok: false, statusCode: 302, error: "WEBHOOK_REDIRECT" });
    expect(send).toHaveBeenCalledTimes(1);
    const blocked = vi.fn();
    expect(
      await sendWebhook(delivery, "{}", {
        send: blocked,
        lookup: async () => [{ address: "192.168.0.10", family: 4 }],
        now: Date.now,
      }),
    ).toEqual({ ok: false, error: "WEBHOOK_URL_BLOCKED" });
    expect(blocked).not.toHaveBeenCalled();
  });

  it("aborts slow receivers after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const send = vi.fn(
      (request: WebhookRequest) =>
        new Promise<number>((_resolve, reject) =>
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    );
    const pending = sendWebhook(
      {
        url: "https://hooks.example.com/",
        secret: "s",
        eventId: "e",
        type: "post.failed",
      },
      "{}",
      { send, lookup: publicLookup, now: Date.now },
    );
    await vi.advanceTimersByTimeAsync(webhookTimeoutMs - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: "WEBHOOK_TIMEOUT" });
  });
});

describe("DNS rebinding protection", () => {
  const checked = [
    { address: "93.184.216.34", family: 4 as const },
    { address: "2606:2800:220:1::1", family: 6 as const },
  ];
  const resolve = (
    lookup: ReturnType<typeof pinnedLookup>,
    options: { all?: boolean; family?: number },
  ) =>
    new Promise<unknown>((done, fail) =>
      lookup("hooks.example.com", options as never, (error, address, family) =>
        error ? fail(error) : done(options.all ? address : { address, family }),
      ),
    );

  it("answers lookups only with the checked addresses", async () => {
    const lookup = pinnedLookup(checked);
    expect(await resolve(lookup, { all: true })).toEqual(checked);
    expect(await resolve(lookup, {})).toEqual(checked[0]);
    expect(await resolve(lookup, { family: 6 })).toEqual(checked[1]);
    await expect(
      resolve(pinnedLookup([checked[0]]), { family: 6 }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("connects to the first checked address even if DNS changes to a private one", async () => {
    // The first resolution (the check) is public, any later one is loopback.
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const connected: unknown[] = [];
    let options: Record<string, unknown> = {};
    let body = "";
    const request = vi.fn((opts: Record<string, unknown>, onResponse) => {
      options = opts;
      // What the socket would connect to, in both lookup forms node:net uses.
      const pinned = opts.lookup as ReturnType<typeof pinnedLookup>;
      pinned("hooks.example.com", { all: true }, (_e, addresses) =>
        connected.push(...(addresses as unknown as { address: string }[])),
      );
      pinned("hooks.example.com", {}, (_e, address) =>
        connected.push({ address }),
      );
      const destroy = vi.fn();
      return {
        on: vi.fn(),
        end: (chunk: string) => {
          body = chunk;
          onResponse({ statusCode: 204, destroy });
        },
      };
    });
    const result = await sendWebhook(
      {
        url: "https://hooks.example.com:8443/in?x=1",
        secret: "s",
        eventId: "e",
        type: "post.approved",
      },
      '{"id":"evt"}',
      {
        send: pinnedHttpsSend(request as unknown as typeof httpsRequest),
        lookup,
        now: Date.now,
      },
    );
    expect(result).toEqual({ ok: true, statusCode: 204 });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connected).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.34" },
    ]);
    expect(JSON.stringify(connected)).not.toContain("127.0.0.1");
    // SNI and Host stay the webhook's hostname; TLS settings are untouched.
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "hooks.example.com",
      servername: "hooks.example.com",
      port: "8443",
      path: "/in?x=1",
      method: "POST",
      agent: false,
    });
    expect(options.headers).toMatchObject({
      Host: "hooks.example.com:8443",
      "Content-Length": String(body.length),
    });
    expect(options).not.toHaveProperty("rejectUnauthorized");
    expect(options).not.toHaveProperty("checkServerIdentity");
    expect(body).toBe('{"id":"evt"}');
  });

  it("opens the real socket to the pinned address with the original SNI", async () => {
    // A plain TCP server stands in for the pinned address: hooks.example.com
    // is never resolved, and the TLS ClientHello names the original host.
    let hello = Buffer.alloc(0);
    const server = createServer((socket) =>
      socket.once("data", (chunk) => {
        hello = chunk;
        socket.destroy();
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        pinnedHttpsSend()({
          url: new URL(`https://hooks.example.com:${port}/`),
          addresses: [{ address: "127.0.0.1", family: 4 }],
          headers: {},
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
    expect(hello.includes(Buffer.from("hooks.example.com"))).toBe(true);
  });
});

describe("webhook endpoint management", () => {
  it("forbids non-administrators", async () => {
    for (const role of [
      "SOCIAL_MANAGER",
      "CONTENT_CREATOR",
      "VIEWER",
    ] as const) {
      const w = await workspace(role);
      await expect(endpoint(w)).rejects.toMatchObject({ status: 403 });
      await expect(listWebhookEndpoints(w.c)).rejects.toMatchObject({
        status: 403,
      });
      const id = crypto.randomUUID();
      await expect(revokeWebhookEndpoint(w.c, id)).rejects.toMatchObject({
        status: 403,
      });
      await expect(rotateWebhookSecret(w.c, id)).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  it("rejects non-HTTPS and private destinations when saving", async () => {
    const w = await workspace("ADMIN");
    for (const url of [
      "http://hooks.example.com/",
      "https://127.0.0.1/",
      "https://localhost/",
    ])
      await expect(
        createWebhookEndpoint(
          w.c,
          { url, events: ["post.approved"] },
          publicLookup,
        ),
      ).rejects.toMatchObject({ status: 422 });
    await expect(
      createWebhookEndpoint(
        w.c,
        { url: "https://intranet.example.com/", events: ["post.approved"] },
        async () => [{ address: "192.168.10.2", family: 4 }],
      ),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
    expect(await listWebhookEndpoints(w.c)).toEqual([]);
  });

  it("encrypts the secret, shows it once and audits every change", async () => {
    const w = await workspace();
    const created = await endpoint(w, ["post.published"]);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const stored = (
      await db.query<Record<string, string>>(
        "SELECT * FROM webhook_endpoints WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(JSON.stringify(stored)).not.toContain(created.secret);
    expect(stored.secret_ciphertext.split(".")).toHaveLength(3);
    const listed = await listWebhookEndpoints(w.c);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(listed[0]).not.toHaveProperty("secret");
    expect(listed[0]).not.toHaveProperty("secret_ciphertext");

    const rotated = await rotateWebhookSecret(w.c, created.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret_rotated_at).toBeTruthy();
    await revokeWebhookEndpoint(w.c, created.id);
    await expect(rotateWebhookSecret(w.c, created.id)).rejects.toMatchObject({
      status: 404,
    });

    const audits = (
      await db.query<{ action: string; metadata: unknown }>(
        "SELECT action,metadata FROM audit_logs WHERE organization_id=$1 ORDER BY created_at,action",
        [w.org],
      )
    ).rows;
    expect(audits.map((a) => a.action).sort()).toEqual([
      "webhook.created",
      "webhook.revoked",
      "webhook.secret_rotated",
    ]);
    const text = JSON.stringify(audits);
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain(rotated.secret);
  });

  it("limits active endpoints per organization", async () => {
    const w = await workspace();
    for (let i = 0; i < 10; i++) await endpoint(w);
    await expect(endpoint(w)).rejects.toMatchObject({ code: "WEBHOOK_LIMIT" });
    const [first] = await listWebhookEndpoints(w.c);
    await revokeWebhookEndpoint(w.c, first.id);
    await expect(endpoint(w)).resolves.toHaveProperty("secret");
  });
});

describe("event capture", () => {
  it("records the final internal approval with a safe payload", async () => {
    const w = await workspace();
    const hook = await endpoint(w);
    const postId = await post(w);
    await approvalRequest(w, postId, "INTERNAL");
    await decideApproval(postId, "approve", "", w.c);
    const [delivery] = await deliveries(w.org);
    expect(delivery.event_type).toBe("post.approved");
    expect(delivery.endpoint_id).toBe(hook.id);
    expect(delivery.status).toBe("PENDING");
    expect(delivery.payload).toEqual({
      id: delivery.event_id,
      type: "post.approved",
      created_at: expect.any(String),
      data: {
        post_id: postId,
        client_id: w.client,
        client_external_ref: "ge-42",
        organization_id: w.org,
        status: "APPROVED",
      },
    });
    const text = JSON.stringify(delivery.payload);
    expect(text).not.toContain("Secret launch caption");
    expect(text).not.toContain(hook.secret);
  });

  it("skips intermediate workflow steps and records the client approval", async () => {
    const w = await workspace();
    await endpoint(w);
    const postId = await post(w);
    await approvalRequest(w, postId, "INTERNAL", ["EXTERNAL"]);
    const result = await decideApproval(postId, "approve", "", w.c);
    expect(result.status).toBe("PENDING_APPROVAL");
    expect(await deliveries(w.org)).toEqual([]);

    const external = result.url!.split("/").pop()!;
    await decideApproval(external, "approve", "");
    expect((await deliveries(w.org)).map((d) => d.event_type)).toEqual([
      "post.approved",
    ]);
  });

  it("records change requests", async () => {
    const w = await workspace();
    await endpoint(w);
    const postId = await post(w);
    await approvalRequest(w, postId, "INTERNAL");
    await decideApproval(postId, "changes", "Fix the date", w.c);
    const [delivery] = await deliveries(w.org);
    expect(delivery.event_type).toBe("post.changes_requested");
    expect(delivery.payload.data.status).toBe("CHANGES_REQUESTED");
    expect(JSON.stringify(delivery.payload)).not.toContain("Fix the date");
  });

  it("only targets active, subscribed endpoints of the organization", async () => {
    const w = await workspace();
    const other = await workspace();
    await endpoint(other);
    const subscribed = await endpoint(w, ["post.approved"]);
    await endpoint(w, ["post.published"]);
    const revoked = await endpoint(w, ["post.approved"]);
    await revokeWebhookEndpoint(w.c, revoked.id);
    const postId = await post(w);
    await approvalRequest(w, postId, "INTERNAL");
    await decideApproval(postId, "approve", "", w.c);
    const rows = await deliveries(w.org);
    expect(rows.map((r) => r.endpoint_id)).toEqual([subscribed.id]);
    expect(await deliveries(other.org)).toEqual([]);
  });

  it("writes nothing when the state change rolls back", async () => {
    const w = await workspace();
    await endpoint(w);
    const postId = await post(w);
    await expect(
      transaction(async (tx) => {
        await tx.query("UPDATE posts SET status='APPROVED' WHERE id=$1", [
          postId,
        ]);
        await enqueueWebhookEvent(tx, "post.approved", {
          organizationId: w.org,
          clientId: w.client,
          postId,
          status: "APPROVED",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await deliveries(w.org)).toEqual([]);
    expect(
      (await db.query("SELECT status FROM posts WHERE id=$1", [postId]))
        .rows[0],
    ).toEqual({ status: "PENDING_APPROVAL" });
  });
});

async function publishJob(
  w: Workspace,
  caption: string,
  account: { platform?: string; mode?: string } = {},
) {
  const accountId = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
     VALUES($1,$2,$3,$4,'Page',$5,$6)`,
    [
      accountId,
      w.org,
      w.client,
      account.platform ?? "linkedin",
      crypto.randomUUID(),
      account.mode ?? "mock",
    ],
  );
  const postId = await post(w, "SCHEDULED");
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
  return { postId, targetId, jobId, accountId };
}

describe("publishing events", () => {
  it("records post.published for a successful target", async () => {
    const w = await workspace();
    const hook = await endpoint(w);
    const job = await publishJob(w, "Hello from the mock");
    await executePublish(job.jobId);
    const [delivery] = await deliveries(w.org);
    expect(delivery.event_type).toBe("post.published");
    expect(delivery.payload.data).toMatchObject({
      post_id: job.postId,
      post_target_id: job.targetId,
      platform: "linkedin",
      platform_post_id: expect.stringMatching(/^mock-linkedin-/),
      status: "PUBLISHED",
      client_external_ref: "ge-42",
    });
    const text = JSON.stringify(delivery.payload);
    expect(text).not.toContain("Hello from the mock");
    expect(text).not.toContain(hook.secret);
  });

  it("records post.failed only for final failures", async () => {
    const w = await workspace();
    await endpoint(w);
    const retried = await publishJob(w, "Busy [mock:rate-limit]");
    await executePublish(retried.jobId);
    expect(await deliveries(w.org)).toEqual([]);

    const failed = await publishJob(w, "Broken [mock:fail]");
    await executePublish(failed.jobId);
    const [delivery] = await deliveries(w.org);
    expect(delivery.event_type).toBe("post.failed");
    expect(delivery.payload.data).toMatchObject({
      post_target_id: failed.targetId,
      platform: "linkedin",
      status: "FAILED",
      error_code: "MOCK_REJECTED",
    });
  });

  async function uncertainDelivery(w: Workspace) {
    const job = await publishJob(w, "Uncertain caption", {
      platform: "facebook",
      mode: "direct",
    });
    await db.query(
      "UPDATE publish_jobs SET status='DEAD',attempts=1,last_error='META_DELIVERY_UNCERTAIN' WHERE id=$1",
      [job.jobId],
    );
    await db.query(
      `INSERT INTO publish_attempts(organization_id,client_id,publish_job_id,attempt,status,error_code,finished_at)
       VALUES($1,$2,$3,1,'FAILED','META_DELIVERY_UNCERTAIN',now())`,
      [w.org, w.client, job.jobId],
    );
    await db.query(
      "UPDATE post_targets SET status='FAILED',error_code='META_DELIVERY_UNCERTAIN' WHERE id=$1",
      [job.targetId],
    );
    await db.query(
      `INSERT INTO publish_reconciliation_jobs(organization_id,client_id,publish_job_id,run_at)
       VALUES($1,$2,$3,now()-interval '1 second')`,
      [w.org, w.client, job.jobId],
    );
    return job;
  }
  const reconcile = (w: Workspace) =>
    processPublishReconciliationJobsWith(
      5,
      async () => [
        {
          id: "123_456",
          caption: "Uncertain caption",
          createdAt: new Date().toISOString(),
          permalink: "https://www.facebook.com/123/posts/456",
        },
      ],
      w.org,
    );

  // Makes the last statement of a state-change transaction fail for one
  // organization, so the whole transaction rolls back after the enqueue.
  async function failAuditFor(w: Workspace, action: string) {
    const name = `fail_${w.org.replaceAll("-", "")}`;
    await db.exec(`
      CREATE FUNCTION ${name}() RETURNS trigger AS $$
      BEGIN
        IF NEW.organization_id='${w.org}' AND NEW.action='${action}' THEN
          RAISE EXCEPTION 'forced failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION ${name}();`);
    return () => db.exec(`DROP TRIGGER ${name} ON audit_logs`);
  }

  it("records post.published when reconciliation confirms a delivery", async () => {
    const w = await workspace();
    await endpoint(w);
    const job = await uncertainDelivery(w);
    expect((await reconcile(w)).confirmed).toBe(1);
    const [delivery] = await deliveries(w.org);
    expect(delivery.event_type).toBe("post.published");
    expect(delivery.payload.data).toMatchObject({
      post_target_id: job.targetId,
      platform: "facebook",
      platform_post_id: "123_456",
      published_url: "https://www.facebook.com/123/posts/456",
      status: "PUBLISHED",
    });
    expect(JSON.stringify(delivery.payload)).not.toContain("Uncertain caption");
  });

  it("drops the reconciliation event when its transaction rolls back", async () => {
    const w = await workspace();
    await endpoint(w);
    const job = await uncertainDelivery(w);
    const restore = await failAuditFor(w, "post.publish_reconciled");
    try {
      expect((await reconcile(w)).confirmed).toBe(0);
    } finally {
      await restore();
    }
    expect(await deliveries(w.org)).toEqual([]);
    expect(
      (
        await db.query("SELECT status FROM post_targets WHERE id=$1", [
          job.targetId,
        ])
      ).rows[0],
    ).toEqual({ status: "FAILED" });
  });

  it("drops the publish event when the outcome transaction rolls back", async () => {
    const w = await workspace();
    await endpoint(w);
    const job = await publishJob(w, "Hello from the mock");
    const restore = await failAuditFor(w, "post.published");
    try {
      await expect(executePublish(job.jobId)).rejects.toThrow("forced failure");
    } finally {
      await restore();
    }
    expect(await deliveries(w.org)).toEqual([]);
  });
});

describe("webhook delivery worker", () => {
  async function queued(w: Workspace) {
    const postId = await post(w);
    await transaction((tx) =>
      enqueueWebhookEvent(tx, "post.approved", {
        organizationId: w.org,
        clientId: w.client,
        postId,
        status: "APPROVED",
      }),
    );
  }
  const transport = (status: number | Error) => {
    const send = vi.fn(async (_request: WebhookRequest) => {
      if (status instanceof Error) throw status;
      return status;
    });
    return {
      send,
      transport: { send, lookup: publicLookup, now: Date.now },
    };
  };

  it("delivers signed requests with the current secret", async () => {
    const w = await workspace();
    const hook = await endpoint(w);
    await queued(w);
    const rotated = await rotateWebhookSecret(w.c, hook.id);
    const { send, transport: t } = transport(200);
    expect(await processWebhookDeliveries(10, t, w.org)).toMatchObject({
      delivered: 1,
    });
    const [delivery] = await deliveries(w.org);
    expect(delivery).toMatchObject({
      status: "DONE",
      attempts: 1,
      last_status_code: 200,
    });
    const init = send.mock.calls[0][0];
    const headers = init.headers;
    expect(headers["X-SocialHub-Event-Id"]).toBe(delivery.event_id);
    expect(JSON.parse(String(init.body))).toEqual(delivery.payload);
    expect(headers["X-SocialHub-Signature"]).toBe(
      signWebhook(
        rotated.secret,
        Number(headers["X-SocialHub-Timestamp"]),
        String(init.body),
      ),
    );
  });

  it("retries with backoff and stores only codes", async () => {
    const w = await workspace();
    await endpoint(w);
    await queued(w);
    const { transport: t } = transport(500);
    expect(await processWebhookDeliveries(10, t, w.org)).toMatchObject({
      retried: 1,
    });
    const [delivery] = await deliveries(w.org);
    expect(delivery).toMatchObject({
      status: "RETRY",
      attempts: 1,
      last_error: "WEBHOOK_HTTP_ERROR",
      last_status_code: 500,
    });
    expect(new Date(delivery.run_at).getTime()).toBeGreaterThan(Date.now());
    const stored = JSON.stringify(
      (
        await db.query(
          "SELECT * FROM webhook_deliveries WHERE organization_id=$1",
          [w.org],
        )
      ).rows,
    );
    expect(stored).not.toContain("receiver secret body");

    await db.query(
      "UPDATE webhook_deliveries SET run_at=now()-interval '1 second' WHERE organization_id=$1",
      [w.org],
    );
    await processWebhookDeliveries(
      10,
      transport(new TypeError("fetch failed")).transport,
      w.org,
    );
    expect((await deliveries(w.org))[0]).toMatchObject({
      status: "RETRY",
      attempts: 2,
      last_error: "WEBHOOK_NETWORK",
      last_status_code: null,
    });
  });

  it("gives up after the maximum number of attempts", async () => {
    const w = await workspace();
    await endpoint(w);
    await queued(w);
    await db.query(
      "UPDATE webhook_deliveries SET status='RETRY',attempts=$2 WHERE organization_id=$1",
      [w.org, maxWebhookAttempts - 1],
    );
    expect(
      await processWebhookDeliveries(10, transport(503).transport, w.org),
    ).toMatchObject({ failed: 1 });
    expect((await deliveries(w.org))[0]).toMatchObject({
      status: "DEAD",
      attempts: maxWebhookAttempts,
    });
  });

  it("never sends waiting deliveries of a revoked endpoint", async () => {
    const w = await workspace();
    const hook = await endpoint(w);
    await queued(w);
    await revokeWebhookEndpoint(w.c, hook.id);
    // A row that slipped back to PENDING is still skipped by the worker.
    await db.query(
      "UPDATE webhook_deliveries SET status='PENDING',last_error=NULL WHERE organization_id=$1",
      [w.org],
    );
    const { send, transport: t } = transport(200);
    expect(await processWebhookDeliveries(10, t, w.org)).toMatchObject({
      delivered: 0,
      skipped: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect((await deliveries(w.org))[0]).toMatchObject({
      status: "DEAD",
      last_error: "ENDPOINT_REVOKED",
    });
  });

  it("shows dead deliveries in operations for the own organization only", async () => {
    const w = await workspace();
    const other = await workspace();
    for (const x of [w, other]) {
      await endpoint(x);
      await queued(x);
      await db.query(
        "UPDATE webhook_deliveries SET status='DEAD',last_error='WEBHOOK_HTTP_ERROR' WHERE organization_id=$1",
        [x.org],
      );
    }
    await queued(w);
    const summary = await operationalSummary(w.c);
    expect(summary.webhookDead).toBe(1);
    expect(summary.webhookWaiting).toBe(1);
    expect(summary.needsAttention).toBe(true);
  });
});
