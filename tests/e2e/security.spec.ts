import { test, expect } from "@playwright/test";
import { Pool } from "pg";
const baseURL = process.env.APP_URL!;
test("tenant isolation, viewer permissions and CSRF are enforced by the API", async ({
  playwright,
}) => {
  const owner = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const other = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    expect(
      (
        await owner.post("/api/auth/sign-in/email", {
          data: {
            email: process.env.DEMO_EMAIL,
            password: process.env.DEMO_PASSWORD,
          },
        })
      ).ok(),
    ).toBe(true);
    const workspace = await (await owner.get("/api/hub")).json();
    const secretClient = workspace.clients.find(
      (c: any) => c.name === "Terra Studio",
    );
    const created = await other.post("/api/auth/sign-up/email", {
      data: {
        name: "Isolated test user",
        email: `isolation-${Date.now()}@example.test`,
        password: crypto.randomUUID() + "-strong",
      },
    });
    expect(created.ok()).toBe(true);
    const newUser = (await created.json()).user;
    expect([403, 404]).toContain(
      (await other.get(`/api/hub?clientId=${secretClient.id}`)).status(),
    );
    expect(
      (
        await other.post("/api/hub", {
          data: {
            action: "client.create",
            name: "Forbidden",
            organizationId: secretClient.organization_id,
          },
        })
      ).status(),
    ).toBe(403);
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'VIEWER')",
      [secretClient.organization_id, newUser.id],
    );
    // Being an organization member does not grant client access.
    expect(
      (await other.get(`/api/hub?clientId=${secretClient.id}`)).status(),
    ).toBe(403);
    await db.query(
      "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,'VIEWER')",
      [secretClient.organization_id, secretClient.id, newUser.id],
    );
    expect((await other.get(`/api/hub?clientId=${secretClient.id}`)).ok()).toBe(
      true,
    );
    for (const action of [
      "account.connect",
      "brand.save",
      "post.create",
      "post.schedule",
    ])
      expect(
        (
          await other.post("/api/hub", {
            data: { action, clientId: secretClient.id },
          })
        ).status(),
      ).toBe(403);
    const crossOrigin = await owner.post("/api/hub", {
      headers: { origin: "https://untrusted.example" },
      data: { action: "brand.save", clientId: secretClient.id, brand: {} },
    });
    expect(crossOrigin.status()).toBe(403);
    const own = await (
      await owner.get(`/api/hub?clientId=${secretClient.id}`)
    ).json();
    expect(JSON.stringify(own)).not.toMatch(
      /encrypted_value|accessToken|refreshToken|client_secret/,
    );
    const ownClient = await (
      await other.post("/api/hub", {
        data: {
          action: "client.create",
          name: `Isolated own workspace ${Date.now()}`,
        },
      })
    ).json();
    const attempt = await other.post("/api/hub", {
      data: {
        action: "post.create",
        clientId: ownClient.id,
        caption: "Invalid cross-client target",
        targets: [
          { accountId: own.accounts[0].id, caption: "Test", mediaIds: [] },
        ],
      },
    });
    expect(attempt.status()).toBe(422);
  } finally {
    await owner.dispose();
    await other.dispose();
    await db.end();
  }
});

test("worker retries, partial results and repeated schedule requests are safe", async ({
  playwright,
}) => {
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await api.post("/api/auth/sign-in/email", {
      data: {
        email: process.env.DEMO_EMAIL,
        password: process.env.DEMO_PASSWORD,
      },
    });
    const client = await (
      await api.post("/api/hub", {
        data: { action: "client.create", name: `Reliability ${Date.now()}` },
      })
    ).json();
    const accounts = [];
    for (const platform of ["facebook", "linkedin"])
      accounts.push(
        await (
          await api.post("/api/hub", {
            data: {
              action: "account.connect",
              clientId: client.id,
              platform,
              name: `Reliability ${platform}`,
            },
          })
        ).json(),
      );
    const created = await api.post("/api/hub", {
      data: {
        action: "post.create",
        clientId: client.id,
        caption: "Mixed outcomes",
        targets: accounts.map((a, i) => ({
          accountId: a.id,
          caption: i ? "[mock:fail]" : "[mock:rate-limit]",
          mediaIds: [],
        })),
      },
    });
    expect(created.ok()).toBe(true);
    const post = await created.json();
    const approval = await (
      await api.post("/api/hub", {
        data: { action: "post.submit", clientId: client.id, id: post.id },
      })
    ).json();
    const token = approval.url.split("/").at(-1);
    expect(
      (
        await api.post(`/api/approval/${token}`, {
          data: { action: "approve" },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await api.post(`/api/approval/${token}`, {
          data: { action: "approve" },
        })
      ).status(),
    ).toBe(409);
    const payload = {
      action: "post.schedule",
      clientId: client.id,
      id: post.id,
      scheduledAt: new Date(Date.now() + 500).toISOString(),
    };
    expect((await api.post("/api/hub", { data: payload })).ok()).toBe(true);
    expect((await api.post("/api/hub", { data: payload })).status()).toBe(409);
    await expect
      .poll(
        async () =>
          (await db.query("SELECT status FROM posts WHERE id=$1", [post.id]))
            .rows[0].status,
        { timeout: 45000 },
      )
      .toBe("PARTIALLY_PUBLISHED");
    const jobs = (
      await db.query(
        "SELECT j.status,j.attempts,t.status AS target_status,j.idempotency_key FROM publish_jobs j JOIN post_targets t ON t.id=j.target_id WHERE t.post_id=$1",
        [post.id],
      )
    ).rows;
    expect(jobs.find((j) => j.target_status === "PUBLISHED")).toMatchObject({
      status: "DONE",
      attempts: 3,
    });
    expect(jobs.find((j) => j.target_status === "FAILED")).toMatchObject({
      status: "DEAD",
      attempts: 1,
    });
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM mock_receipts WHERE organization_id=$1 AND client_id=$2",
            [client.organization_id, client.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM publish_attempts WHERE client_id=$1",
            [client.id],
          )
        ).rows[0].count,
      ),
    ).toBe(4);
  } finally {
    await db.end();
    await api.dispose();
  }
});
