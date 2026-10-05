import { test, expect } from "@playwright/test";
import { Pool } from "pg";
test("internal → client review, revision invalidation and cancellation", async ({
  playwright,
  page,
}) => {
  const baseURL = process.env.APP_URL!;
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let clientId = "";
  try {
    await api.post("/api/auth/sign-in/email", {
      data: {
        email: process.env.DEMO_EMAIL,
        password: process.env.DEMO_PASSWORD,
      },
    });
    const client = await (
      await api.post("/api/hub", {
        data: { action: "client.create", name: `Approval chain ${Date.now()}` },
      })
    ).json();
    clientId = client.id;
    const account = await (
      await api.post("/api/hub", {
        data: {
          action: "account.connect",
          clientId: client.id,
          platform: "facebook",
          name: "Approval test",
        },
      })
    ).json();
    const send = (action: string, data: Record<string, unknown> = {}) =>
      api.post("/api/hub", { data: { action, clientId: client.id, ...data } });
    expect(
      (await send("workflow.save", { steps: ["INTERNAL", "EXTERNAL"] })).ok(),
    ).toBe(true);
    const content = {
      caption: "Version one",
      targets: [
        { accountId: account.id, caption: "Version one", mediaIds: [] },
      ],
    };
    const post = await (await send("post.create", content)).json();
    const first = await (await send("post.submit", { id: post.id })).json();
    expect(first).toMatchObject({ kind: "INTERNAL", url: null });
    const owner = (
      await db.query('SELECT id FROM "user" WHERE email=$1', [
        process.env.DEMO_EMAIL,
      ])
    ).rows[0];
    const assigned = (
      await db.query(
        "SELECT assigned_to FROM approval_requests WHERE post_id=$1 ORDER BY created_at DESC LIMIT 1",
        [post.id],
      )
    ).rows[0];
    expect(assigned.assigned_to).toBe(owner.id);
    await page.goto("/login");
    await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
    await page
      .getByLabel("Password", { exact: true })
      .fill(process.env.DEMO_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Active client").selectOption(client.id);
    await page.getByRole("button", { name: "Approvals", exact: true }).click();
    await page
      .locator("table .table-caption")
      .filter({ hasText: "Version one" })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Internal review");
    await expect(page.getByLabel("Assigned reviewer")).toHaveValue(owner.id);
    const reminderResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/hub") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Send reminder", exact: true })
      .click();
    expect(await (await reminderResponse).json()).toMatchObject({
      reminderCount: 1,
      emailDelivered: true,
    });
    await expect(page.locator(".success-notice")).toContainText(
      "Changes saved.",
    );
    expect(
      (
        await db.query(
          "SELECT reminder_count FROM approval_requests WHERE post_id=$1 ORDER BY created_at DESC LIMIT 1",
          [post.id],
        )
      ).rows[0].reminder_count,
    ).toBe(1);
    expect((await send("post.review.remind", { id: post.id })).status()).toBe(
      409,
    );
    expect((await send("post.approval-link", { id: post.id })).status()).toBe(
      409,
    );
    expect(
      (
        await send("post.schedule", {
          id: post.id,
          scheduledAt: new Date(Date.now() + 10000).toISOString(),
        })
      ).status(),
    ).toBe(409);
    const reviewed = await (
      await send("post.review", {
        id: post.id,
        decision: "approve",
        comment: "Internal review complete",
      })
    ).json();
    expect(reviewed.status).toBe("PENDING_APPROVAL");
    expect(reviewed.url).toBeTruthy();
    const originalToken = reviewed.url.split("/").at(-1);
    const replaced = await (
      await send("post.approval-link", { id: post.id })
    ).json();
    const token = replaced.url.split("/").at(-1);
    expect((await api.get(`/api/approval/${originalToken}`)).status()).toBe(
      404,
    );
    expect(
      (
        await api.post(`/api/approval/${token}`, {
          data: { action: "changes", comment: "Please update the caption" },
        })
      ).ok(),
    ).toBe(true);
    const revised = await (
      await send("post.edit", {
        id: post.id,
        ...content,
        caption: "Version two",
        targets: [{ ...content.targets[0], caption: "Version two" }],
      })
    ).json();
    expect(revised.revision).toBe(2);
    expect((await api.get(`/api/approval/${token}`)).status()).toBe(404);
    await send("post.submit", { id: post.id });
    await db.query(
      "UPDATE approval_requests SET expires_at=now()-interval '1 minute' WHERE post_id=$1 AND status='PENDING'",
      [post.id],
    );
    const expiredHub = await (
      await api.get(`/api/hub?clientId=${client.id}`)
    ).json();
    expect(
      expiredHub.posts.find(
        (candidate: { id: string }) => candidate.id === post.id,
      ).approval_status,
    ).toBe("EXPIRED");
    expect(
      (
        await db.query(
          "SELECT status FROM approval_requests WHERE post_id=$1 ORDER BY created_at DESC LIMIT 1",
          [post.id],
        )
      ).rows[0].status,
    ).toBe("EXPIRED");
    expect(
      (
        await send("post.review.renew", {
          id: post.id,
          reviewerId: owner.id,
        })
      ).ok(),
    ).toBe(true);
    const again = await (
      await send("post.review", { id: post.id, decision: "approve" })
    ).json();
    expect(
      (
        await api.post(`/api/approval/${again.url.split("/").at(-1)}`, {
          data: { action: "approve" },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (await send("post.edit", { id: post.id, ...content })).status(),
    ).toBe(409);
    expect(
      (
        await send("post.schedule", {
          id: post.id,
          scheduledAt: new Date(Date.now() + 60000).toISOString(),
        })
      ).ok(),
    ).toBe(true);
    expect((await send("post.cancel", { id: post.id })).ok()).toBe(true);
    expect(
      (await db.query("SELECT status FROM posts WHERE id=$1", [post.id]))
        .rows[0].status,
    ).toBe("CANCELLED");
    expect(
      (
        await db.query("SELECT status FROM publish_jobs WHERE client_id=$1", [
          client.id,
        ])
      ).rows[0].status,
    ).toBe("CANCELLED");
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM post_versions WHERE post_id=$1",
            [post.id],
          )
        ).rows[0].count,
      ),
    ).toBe(2);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM audit_logs WHERE resource_id=$1 AND action IN ('approval.reminder_sent','approval.expired','approval.renewed')",
            [post.id],
          )
        ).rows[0].count,
      ),
    ).toBe(3);
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
    await api.dispose();
  }
});
