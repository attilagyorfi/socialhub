import { test, expect } from "@playwright/test";
import { Pool } from "pg";

test("an invitation for an existing account asks to sign in, then joins", async ({
  page,
  browser,
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const ownerEmail = `invite-owner-${crypto.randomUUID()}@example.test`;
  const memberEmail = `invite-member-${crypto.randomUUID()}@example.test`;
  const memberPassword = crypto.randomUUID();
  let organizationId = "";
  try {
    // The invited person already has an account (for example in another agency).
    const existing = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL },
    });
    const signup = await existing.post("/api/auth/sign-up/email", {
      data: {
        email: memberEmail,
        password: memberPassword,
        name: "Existing member",
      },
    });
    expect(signup.ok()).toBe(true);
    await existing.dispose();

    const owner = await page.request.post("/api/auth/sign-up/email", {
      headers: { origin: baseURL },
      data: {
        email: ownerEmail,
        password: crypto.randomUUID(),
        name: "Inviting owner",
      },
    });
    expect(owner.ok()).toBe(true);
    const send = (action: string, data: Record<string, unknown> = {}) =>
      page.request.post("/api/hub", {
        headers: { origin: baseURL },
        data: { action, ...data },
      });
    const client = await (
      await send("client.create", { name: `Invite ${Date.now()}` })
    ).json();
    organizationId = client.organization_id;
    const invitation = await send("team.invite", {
      clientId: client.id,
      email: memberEmail,
      role: "SOCIAL_MANAGER",
      clientIds: [client.id],
    });
    expect(invitation.ok()).toBe(true);
    const { url } = await invitation.json();
    expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    // A fresh browser, as when the person opens the email link.
    const visitor = await browser.newContext();
    const invite = await visitor.newPage();
    await invite.goto(url);
    await expect(
      invite.getByRole("button", { name: "Sign in and join" }),
    ).toBeVisible();
    await expect(invite.getByLabel("Your name")).toHaveCount(0);
    await invite.getByLabel("Password").fill(memberPassword);
    await invite.getByRole("button", { name: "Sign in and join" }).click();
    await invite.waitForURL(`${baseURL}/`);
    await visitor.close();

    const membership = (
      await db.query(
        `SELECT om.role,
           (SELECT array_agg(cm.client_id::text) FROM client_members cm
            WHERE cm.user_id=u.id AND cm.organization_id=om.organization_id) AS clients
         FROM "user" u
         JOIN organization_members om ON om.user_id=u.id AND om.organization_id=$2
         WHERE u.email=$1`,
        [memberEmail, organizationId],
      )
    ).rows[0];
    expect(membership).toEqual({
      role: "SOCIAL_MANAGER",
      clients: [client.id],
    });
  } finally {
    if (organizationId)
      await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await db.query('DELETE FROM "user" WHERE email=ANY($1)', [
      [ownerEmail, memberEmail],
    ]);
    await db.end();
  }
});
