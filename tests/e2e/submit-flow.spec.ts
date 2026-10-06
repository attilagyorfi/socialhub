import { test, expect } from "@playwright/test";
import { Pool } from "pg";

test("composer sends for approval in one step and unpublishable posts are refused at submit", async ({
  page,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  // A dedicated user keeps this test off the shared demo user's rate limit.
  const email = `submit-${crypto.randomUUID()}@example.test`;
  let organizationId = "";
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers: { origin: baseURL },
      data: { email, password: crypto.randomUUID(), name: "Submit flow" },
    });
    expect(signup.ok()).toBe(true);
    const send = (action: string, data: Record<string, unknown> = {}) =>
      page.request.post("/api/hub", {
        headers: { origin: baseURL },
        data: { action, ...data },
      });
    const client = await (
      await send("client.create", { name: `Submit ${Date.now()}` })
    ).json();
    organizationId = client.organization_id;
    const facebook = await (
      await send("account.connect", {
        clientId: client.id,
        platform: "facebook",
        name: "Submit Facebook",
      })
    ).json();
    const instagram = await (
      await send("account.connect", {
        clientId: client.id,
        platform: "instagram",
        name: "Submit Instagram",
      })
    ).json();

    // The server refuses to send an unpublishable post for review.
    const invalid = await (
      await send("post.create", {
        clientId: client.id,
        caption: "No image",
        targets: [
          { accountId: instagram.id, caption: "No image", mediaIds: [] },
        ],
      })
    ).json();
    const refused = await send("post.submit", {
      clientId: client.id,
      id: invalid.id,
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).code).toBe("VALIDATION");

    // One click in the composer saves and sends a valid post for review.
    await page.goto("/");
    await page.getByLabel("Active client").selectOption(client.id);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: /Submit Facebook/ }).click();
    await page
      .getByPlaceholder("What would you like to share?")
      .fill("Ready for the client");
    await page
      .getByRole("button", { name: "Send for approval", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("External approval link");
    await expect(dialog.getByLabel("Approval link")).toHaveValue(
      /\/approve\/[A-Za-z0-9_-]{43}$/,
    );

    // Errors from dialog actions are shown inside the dialog.
    await dialog.getByRole("button", { name: "Close post" }).click();
    await page.getByRole("button", { name: "Posts", exact: true }).click();
    await page.getByText("No image", { exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Send for approval", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Instagram requires an image or video.",
    );
    expect(facebook.id).toBeTruthy();
  } finally {
    if (organizationId)
      await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await db.query('DELETE FROM "user" WHERE email=$1', [email]);
    await db.end();
  }
});
