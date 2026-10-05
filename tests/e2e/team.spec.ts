import { test, expect } from "@playwright/test";
import { Pool } from "pg";

test("owner invites a scoped teammate and can revoke their access", async ({
  page,
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const email = `team-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const database = new Pool({ connectionString: process.env.DATABASE_URL });
  let userId: string | undefined;
  const memberApi = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  try {
    const login = await page.request.post("/api/auth/sign-in/email", {
      headers: { origin: baseURL },
      data: {
        email: process.env.DEMO_EMAIL,
        password: process.env.DEMO_PASSWORD,
      },
    });
    expect(login.ok()).toBe(true);
    await page.goto("/");
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Invite a team member" }),
    ).toBeVisible();
    const selectedClient = await page.getByLabel("Active client").inputValue();
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    const invitationUrl = await page
      .locator(".invitation-link a")
      .getAttribute("href");
    expect(invitationUrl).toBeTruthy();
    const token = invitationUrl!.split("/").at(-1)!;

    const publicView = await memberApi.get(`/api/invitation/${token}`);
    expect(publicView.ok()).toBe(true);
    expect((await publicView.json()).email).toBe(email);

    const signup = await memberApi.post("/api/auth/sign-up/email", {
      data: { email, password, name: "Invited teammate" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    const accepted = await memberApi.post(`/api/invitation/${token}`, {
      data: {},
    });
    expect(accepted.ok()).toBe(true);

    const memberHub = await memberApi.get("/api/hub");
    expect(memberHub.ok()).toBe(true);
    const memberData = await memberHub.json();
    expect(memberData.role).toBe("CONTENT_CREATOR");
    expect(
      memberData.clients.map((client: { id: string }) => client.id),
    ).toEqual([selectedClient]);
    expect(memberData.canManageTeam).toBe(false);

    const forbidden = await memberApi.post("/api/hub", {
      data: {
        action: "team.invite",
        clientId: selectedClient,
        email: `nested-${email}`,
        role: "VIEWER",
        clientIds: [selectedClient],
      },
    });
    expect(forbidden.status()).toBe(403);

    await page.getByTitle("Refresh workspace").click();
    await expect(
      page.getByText("Invited teammate", { exact: true }),
    ).toBeVisible();
    const ownerData = await (await page.request.get("/api/hub")).json();
    const selfRemove = await page.request.post("/api/hub", {
      headers: { origin: baseURL },
      data: {
        action: "team.member.remove",
        clientId: selectedClient,
        userId: ownerData.user.id,
      },
    });
    expect(selfRemove.status()).toBe(409);

    const removed = await page.request.post("/api/hub", {
      headers: { origin: baseURL },
      data: {
        action: "team.member.remove",
        clientId: selectedClient,
        userId,
      },
    });
    expect(removed.ok()).toBe(true);
    expect((await (await memberApi.get("/api/hub")).json()).clients).toEqual(
      [],
    );
    expect(
      (await memberApi.post(`/api/invitation/${token}`, { data: {} })).status(),
    ).toBe(404);
  } finally {
    await database.query("DELETE FROM member_invitations WHERE email=$1", [
      email,
    ]);
    await database.query('DELETE FROM "user" WHERE email=$1', [email]);
    await database.end();
    await memberApi.dispose();
  }
});
