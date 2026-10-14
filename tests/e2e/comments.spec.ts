import { test, expect } from "@playwright/test";
import { Pool } from "pg";

test("comment inbox lists threads, shows page replies and tracks handled comments", async ({
  page,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  // A dedicated user keeps this test off the shared demo user's rate limit.
  const email = `comments-${crypto.randomUUID()}@example.test`;
  let organizationId = "";
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers: { origin: baseURL },
      data: { email, password: crypto.randomUUID(), name: "Comment manager" },
    });
    expect(signup.ok()).toBe(true);
    const send = (action: string, data: Record<string, unknown> = {}) =>
      page.request.post("/api/hub", {
        headers: { origin: baseURL },
        data: { action, ...data },
      });
    const client = await (
      await send("client.create", { name: `Comments ${Date.now()}` })
    ).json();
    organizationId = client.organization_id;
    const account = await (
      await send("account.connect", {
        clientId: client.id,
        platform: "facebook",
        name: "Comments Page",
      })
    ).json();

    // Comments arrive from Meta in production; here they are stored directly.
    const minute = 60_000;
    const insert = (
      remoteId: string,
      parent: string | null,
      message: string,
      author: string | null,
      fromPage: boolean,
      ageMinutes: number,
    ) =>
      db.query(
        `INSERT INTO social_comments(organization_id,client_id,social_account_id,platform,remote_id,parent_remote_id,object_remote_id,author_name,message,from_page,status,remote_created_at)
         VALUES($1,$2,$3,'facebook',$4,$5,'page_post',$6,$7,$8,$9,$10)`,
        [
          organizationId,
          client.id,
          account.id,
          remoteId,
          parent,
          author,
          message,
          fromPage,
          fromPage ? "DONE" : "OPEN",
          new Date(Date.now() - ageMinutes * minute),
        ],
      );
    await insert("c1", null, "When is the next event?", "Anna Fan", false, 30);
    await insert("r1", "c1", "Friday at 9!", null, true, 20);
    await insert("c2", null, "Love this track", "Béla Fan", false, 10);

    await page.goto("/");
    await page.getByLabel("Active client").selectOption(client.id);
    const nav = page.getByRole("button", { name: /^Comments/ });
    await expect(nav.locator(".nav-count")).toHaveText("2");
    await nav.click();

    await expect(page.getByText("When is the next event?")).toBeVisible();
    await expect(page.getByText("Love this track")).toBeVisible();
    await expect(page.getByText("Friday at 9!")).toBeVisible();
    await expect(page.getByText("Your page")).toBeVisible();

    // Handling a thread moves it out of the open list and updates the badge.
    const thread = page
      .locator(".comment-list > li")
      .filter({ hasText: "Love this track" });
    await thread.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByText("Marked as done.")).toBeVisible();
    await expect(page.getByText("Love this track")).toBeHidden();
    await expect(nav.locator(".nav-count")).toHaveText("1");

    await page
      .getByLabel("Filter comments by status")
      .selectOption({ label: "Done" });
    await expect(page.getByText("Love this track")).toBeVisible();
    await page.getByRole("button", { name: "Reopen" }).first().click();
    await expect(page.getByText("Comment reopened.")).toBeVisible();
    await expect(nav.locator(".nav-count")).toHaveText("2");

    // Cross-site requests are refused before any work is done.
    const forbidden = await page.request.post("/api/comments", {
      headers: { origin: "https://attacker.example" },
      data: { clientId: client.id, action: "sync" },
    });
    expect(forbidden.status()).toBe(403);
  } finally {
    if (organizationId)
      await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await db.query('DELETE FROM "user" WHERE email=$1', [email]);
    await db.end();
  }
});
