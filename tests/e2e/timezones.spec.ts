import { expect, test } from "@playwright/test";
import { Pool } from "pg";

test("a member can save a personal display timezone", async ({
  page,
  playwright,
}) => {
  const email = `timezone-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const api = await playwright.request.newContext({
    baseURL: process.env.APP_URL,
    extraHTTPHeaders: { origin: process.env.APP_URL! },
  });
  let userId = "";
  try {
    const created = await api.post("/api/auth/sign-up/email", {
      data: { email, password, name: "Timezone test" },
    });
    expect(created.ok()).toBe(true);
    userId = (await created.json()).user.id;
    await db.query(
      `INSERT INTO organization_members(organization_id,user_id,role)
       SELECT m.organization_id,$1,'VIEWER'
       FROM organization_members m JOIN "user" u ON u.id=m.user_id
       WHERE u.email=$2 AND m.role='OWNER' LIMIT 1`,
      [userId, process.env.DEMO_EMAIL],
    );
    await db.query(
      `INSERT INTO client_members(organization_id,client_id,user_id,role)
       SELECT c.organization_id,c.id,$1,'VIEWER'
       FROM clients c JOIN organization_members m ON m.organization_id=c.organization_id
       WHERE m.user_id=$1 AND c.deleted_at IS NULL LIMIT 1`,
      [userId],
    );

    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Display timezone").fill("America/New_York");
    await page.getByRole("button", { name: "Save timezone" }).click();
    await expect(page.locator(".success-notice")).toContainText(
      "Changes saved.",
    );
    await expect(page.getByLabel("Display timezone")).toHaveValue(
      "America/New_York",
    );
    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(
      page.getByText("Times shown in America/New_York."),
    ).toBeVisible();

    const stored = (
      await db.query(`SELECT timezone FROM "user" WHERE id=$1`, [userId])
    ).rows[0];
    expect(stored.timezone).toBe("America/New_York");
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM audit_logs
             WHERE actor_id=$1 AND action='user.timezone.updated'`,
            [userId],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(0);

    const invalid = await page.request.post("/api/hub", {
      headers: { origin: process.env.APP_URL! },
      data: { action: "preferences.update", timezone: "Not/A_Timezone" },
    });
    expect(invalid.status()).toBe(422);
  } finally {
    if (userId) {
      await db.query(
        `DELETE FROM audit_logs
         WHERE actor_id=$1 AND action='user.timezone.updated'`,
        [userId],
      );
      await db.query(`DELETE FROM "user" WHERE id=$1 AND email=$2`, [
        userId,
        email,
      ]);
    }
    await db.end();
    await api.dispose();
  }
});
