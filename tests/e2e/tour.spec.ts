import { test, expect } from "@playwright/test";

test("product tour walks through the hub and closes with Escape", async ({
  page,
}) => {
  const baseURL = process.env.APP_URL!;
  // A dedicated user keeps this test off the shared demo user's rate limit.
  const email = `tour-${crypto.randomUUID()}@example.test`;
  const signup = await page.request.post("/api/auth/sign-up/email", {
    headers: { origin: baseURL },
    data: { email, password: crypto.randomUUID(), name: "Tour guest" },
  });
  expect(signup.ok()).toBe(true);
  const client = await page.request.post("/api/hub", {
    headers: { origin: baseURL },
    data: { action: "client.create", name: `Tour ${Date.now()}` },
  });
  expect(client.ok()).toBe(true);

  await page.goto("/");
  await expect(page.getByLabel("Active client")).toBeVisible();
  // Auto-start is disabled for automated browsers, so nothing blocks the hub.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const tourButton = page.getByRole("button", { name: "Product tour" });
  await tourButton.click();
  const dialog = page.getByRole("dialog", {
    name: "Welcome to G2A Social Hub!",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 / 7");
  await expect(dialog.getByRole("button", { name: "Next" })).toBeFocused();

  await dialog.getByRole("button", { name: "Next" }).click();
  const second = page.getByRole("dialog", { name: "Switch between clients" });
  await expect(second).toContainText("2 / 7");
  const switcher = page.locator('[data-tour="client-switcher"]');
  await expect(switcher).toHaveAttribute("data-tour-active", "");
  // The cutout surrounds the client switcher.
  const spotlight = page.locator(".tour-spotlight");
  await expect(async () => {
    const target = (await switcher.boundingBox())!;
    const cutout = (await spotlight.boundingBox())!;
    expect(cutout.x).toBeLessThanOrEqual(target.x);
    expect(cutout.y).toBeLessThanOrEqual(target.y);
    expect(cutout.x + cutout.width).toBeGreaterThanOrEqual(
      target.x + target.width,
    );
    expect(cutout.y + cutout.height).toBeGreaterThanOrEqual(
      target.y + target.height,
    );
  }).toPass();

  // Arrow keys navigate between steps as well.
  await page.keyboard.press("ArrowLeft");
  await expect(dialog).toContainText("1 / 7");
  await page.keyboard.press("ArrowRight");
  await expect(second).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(switcher).not.toHaveAttribute("data-tour-active", "");
  await expect(tourButton).toBeFocused();
});
