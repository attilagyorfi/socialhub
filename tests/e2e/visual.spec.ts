import { test, expect } from "@playwright/test";
test("desktop and mobile workspace views render without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: process.env.APP_URL! },
    data: {
      email: process.env.DEMO_EMAIL,
      password: process.env.DEMO_PASSWORD,
    },
  });
  expect(login.ok()).toBe(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Let’s make good things happen/ }),
  ).toBeVisible();
  await page
    .getByLabel("Active client")
    .selectOption({ label: "Terra Studio" });
  await expect(
    page.getByRole("heading", { name: "Your connected accounts" }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/desktop-home.png", fullPage: true });
  for (const name of [
    "Calendar",
    "Create",
    "Media",
    "Analytics",
    "Approvals",
    "Clients",
    "Connected accounts",
    "Settings",
  ]) {
    await page
      .getByRole("navigation")
      .getByRole("button", {
        name: new RegExp(`^${name}(?: \\d+)?$`),
      })
      .click();
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
    if (name === "Settings") {
      await expect(
        page.getByRole("heading", { name: "Operations", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: ".local/desktop-settings.png",
        fullPage: true,
      });
    }
  }
  await page.getByRole("button", { name: "Posts", exact: true }).click();
  await page.locator(".table-caption").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.screenshot({ path: ".local/mobile-home.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
