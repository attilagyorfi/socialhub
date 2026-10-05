import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { verifyPassword } from "better-auth/crypto";

test("settings changes password and rejects the old password", async ({
  page,
  playwright,
}) => {
  const email = `password-${crypto.randomUUID()}@example.test`;
  const initialPassword = crypto.randomUUID();
  const newPassword = crypto.randomUUID();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let userId: string | undefined;
  const api = await playwright.request.newContext({
    baseURL: process.env.APP_URL,
    extraHTTPHeaders: { origin: process.env.APP_URL! },
  });
  try {
    const created = await api.post("/api/auth/sign-up/email", {
      data: { email, password: initialPassword, name: "Password test" },
    });
    expect(created.ok()).toBe(true);
    userId = (await created.json()).user.id;
    await db.query(
      `INSERT INTO organization_members(organization_id,user_id,role)
      SELECT m.organization_id,$1,'VIEWER' FROM organization_members m JOIN "user" u ON u.id=m.user_id
      WHERE u.email=$2 AND m.role='OWNER' LIMIT 1`,
      [userId, process.env.DEMO_EMAIL],
    );
    await db.query(
      `INSERT INTO client_members(organization_id,client_id,user_id,role)
      SELECT c.organization_id,c.id,$1,'VIEWER' FROM clients c JOIN organization_members m ON m.organization_id=c.organization_id
      WHERE m.user_id=$1 AND c.deleted_at IS NULL LIMIT 1`,
      [userId],
    );
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(initialPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Current password", { exact: true })
      .fill("wrong-password");
    await page.getByLabel(/^New password/).fill(newPassword);
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill(newPassword);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Password change failed",
    );
    await page
      .getByLabel("Current password", { exact: true })
      .fill(initialPassword);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Password changed.");
    expect((await api.get("/api/auth/get-session")).ok()).toBe(true);
    expect(await (await api.get("/api/auth/get-session")).json()).toBeNull();
    const credential = await db.query(
      'SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
      [userId],
    );
    expect(
      await verifyPassword({
        hash: credential.rows[0].password,
        password: initialPassword,
      }),
    ).toBe(false);
    expect(
      await verifyPassword({
        hash: credential.rows[0].password,
        password: newPassword,
      }),
    ).toBe(true);
  } finally {
    if (userId)
      await db.query('DELETE FROM "user" WHERE id=$1 AND email=$2', [
        userId,
        email,
      ]);
    await db.end();
    await api.dispose();
  }
});
