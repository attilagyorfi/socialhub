import { test, expect } from "@playwright/test";
import { Pool } from "pg";

// Mailpit (compose service "mail") captures the emails sent by the app.
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

async function resetLink(email: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
    ).then((response) => response.json());
    const id = search.messages?.[0]?.ID;
    if (id) {
      const message = await fetch(`${mailpit}/api/v1/message/${id}`).then(
        (response) => response.json(),
      );
      const link = String(message.Text).match(
        /https?:\/\/\S+\/api\/auth\/reset-password\/\S+/,
      )?.[0];
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Reset email did not arrive");
}

test("a forgotten password can be reset from the emailed link", async ({
  page,
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `reset-${crypto.randomUUID()}@example.test`;
  const oldPassword = crypto.randomUUID();
  const newPassword = `new-${crypto.randomUUID()}`;
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  try {
    const signup = await api.post("/api/auth/sign-up/email", {
      data: { email, password: oldPassword, name: "Reset test" },
    });
    expect(signup.ok()).toBe(true);

    await page.goto("/login");
    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByText("If an account exists for this address"),
    ).toBeVisible();

    const subject = (await resetLink(email)).replace(/^https?:\/\/[^/]+/, "");
    await page.goto(subject);
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Repeat the new password").fill(newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(
      page.getByText("Your password has been changed"),
    ).toBeVisible();

    const oldLogin = await api.post("/api/auth/sign-in/email", {
      data: { email, password: oldPassword },
    });
    expect(oldLogin.ok()).toBe(false);
    const newLogin = await api.post("/api/auth/sign-in/email", {
      data: { email, password: newPassword },
    });
    expect(newLogin.ok()).toBe(true);

    // The link works once.
    await page.goto(subject);
    await expect(
      page.getByText("expired or has already been used"),
    ).toBeVisible();
  } finally {
    await api.dispose();
    await db.query('DELETE FROM "user" WHERE email=$1', [email]);
    await db.end();
  }
});
