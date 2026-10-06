import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { readFileSync } from "node:fs";

test("login → client → mock accounts → media → AI → versions → approval → worker publish", async ({
  page,
  context,
}) => {
  const unique = Date.now();
  const clientName = `E2E Studio ${unique}`;
  await page.goto("/login");
  await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Let’s make good things happen/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await page.getByLabel("Client name", { exact: true }).fill(clientName);
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await expect(
    page.getByRole("option", { name: clientName, exact: true }),
  ).toBeAttached();
  await page.getByLabel("Active client").selectOption({ label: clientName });
  await page
    .getByRole("button", { name: "Connected accounts", exact: true })
    .click();
  for (const platform of ["facebook", "instagram", "linkedin"]) {
    await page
      .getByRole("combobox", { name: "Network", exact: true })
      .selectOption(platform);
    await page
      .getByLabel("Account name", { exact: true })
      .fill(`${clientName} ${platform}`);
    await page
      .getByRole("button", { name: "Connect mock account", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: `${clientName} ${platform}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await page
    .getByLabel("Brand name", { exact: true })
    .fill("E2E Creative Studio");
  await page
    .getByLabel("Preferred call to action", { exact: true })
    .fill("Discover our test collection");
  await page
    .getByRole("button", { name: "Save brand profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Media", exact: true }).click();
  const buffer = readFileSync("tests/fixtures/campaign.png");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "e2e-campaign.png", mimeType: "image/png", buffer });
  await expect(
    page.getByText("e2e-campaign.png", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  for (const platform of ["facebook", "instagram", "linkedin"])
    await page
      .getByRole("button", { name: new RegExp(`${clientName} ${platform}`) })
      .click();
  await page
    .getByPlaceholder("What would you like to share?")
    .fill(`Campaign ${unique}`);
  await page
    .getByRole("button", { name: "Suggest caption", exact: true })
    .click();
  await expect(page.getByText("AI suggestion", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Mock writing suggestion", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Apply suggestion", exact: true })
    .click();
  await expect(
    page.getByPlaceholder("What would you like to share?"),
  ).toHaveValue(/E2E Creative Studio/);
  const attachment = page
    .getByRole("group", { name: "Shared attachments" })
    .getByRole("button", { name: "e2e-campaign.png" });
  await attachment.click();
  await expect(attachment).toHaveAttribute("aria-pressed", "true");
  const version = page.locator(".form-section").filter({
    has: page.getByRole("heading", { name: "4. Customize each network" }),
  });
  await version
    .locator("textarea")
    .nth(2)
    .fill(`LinkedIn specific campaign ${unique}`);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  const approval = await page
    .getByRole("link", { name: "Open client review" })
    .getAttribute("href");
  expect(approval).toBeTruthy();
  const review = await context.newPage();
  await review.goto(approval!);
  await expect(
    review.getByText(`LinkedIn specific campaign ${unique}`, { exact: true }),
  ).toBeVisible();
  await review
    .getByRole("button", { name: "Approve post", exact: true })
    .click();
  await expect(review.getByRole("status")).toContainText("approved");
  await review.close();
  await page.getByRole("button", { name: "Close post" }).click();
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(
    page.locator("table").getByText("Approved", { exact: true }),
  ).toBeVisible();
  await page.locator("table .table-caption").first().click();
  await page.getByRole("button", { name: "Publish now", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Scheduled", { exact: true }).first(),
  ).toBeVisible();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = (
    await db.query("SELECT id FROM clients WHERE name=$1", [clientName])
  ).rows[0];
  await page.close();
  try {
    await expect
      .poll(
        async () => {
          const result = await db.query(
            "SELECT status FROM posts WHERE client_id=$1",
            [client.id],
          );
          return result.rows[0]?.status;
        },
        { timeout: 30000 },
      )
      .toBe("PUBLISHED");
    const targets = (
      await db.query("SELECT status FROM post_targets WHERE client_id=$1", [
        client.id,
      ])
    ).rows;
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.status === "PUBLISHED")).toBe(true);
    const generation = (
      await db.query(
        `SELECT status,mode,provider,total_tokens,applied_at,guardrail_result
         FROM ai_generations WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [client.id],
      )
    ).rows[0];
    expect(generation).toMatchObject({
      status: "COMPLETE",
      mode: "mock",
      provider: "mock",
    });
    expect(generation.total_tokens).toBeGreaterThan(0);
    expect(generation.applied_at).toBeTruthy();
    expect(generation.guardrail_result).toMatchObject({ passed: true });
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM audit_logs WHERE client_id=$1 AND action='post.published'",
            [client.id],
          )
        ).rows[0].count,
      ),
    ).toBe(3);
  } finally {
    await db.end();
  }
});
