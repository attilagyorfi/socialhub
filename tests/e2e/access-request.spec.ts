import { test, expect } from "@playwright/test";

// Mailpit (compose service "mail") captures the emails sent by the app.
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

async function notification(to: string, email: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    ).then((response) => response.json());
    for (const { ID } of search.messages ?? []) {
      const message = await fetch(`${mailpit}/api/v1/message/${ID}`).then(
        (response) => response.json(),
      );
      if (String(message.Text).includes(email)) return String(message.Text);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Access request notification did not arrive");
}

test("a visitor requests access and the operator is notified", async ({
  page,
}) => {
  const operator = process.env.ACCESS_REQUEST_EMAIL!;
  expect(operator).toBeTruthy();
  const email = `request-${crypto.randomUUID()}@example.test`;

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(
    page.getByRole("heading", { name: "Request access" }),
  ).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await page.getByLabel("Your name").fill("Access Visitor");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Company (optional)").fill("Visitor Ltd");
  await page.getByLabel("Message (optional)").fill("We would like a demo.");
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByRole("status")).toContainText(
    "We have received your request",
  );
  for (const label of ["Your name", "Email address", "Company (optional)"])
    await expect(page.getByLabel(label)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send request" })).toHaveCount(
    0,
  );

  const text = await notification(operator, email);
  expect(text).toContain("Access Visitor");
  expect(text).toContain("Visitor Ltd");

  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
});
