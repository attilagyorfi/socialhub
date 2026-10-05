import { test, expect } from "@playwright/test";

test("brand guardrails explain violations and block approval", async ({
  page,
}) => {
  const unique = Date.now();
  const clientName = `Guardrail Studio ${unique}`;
  await page.goto("/login");
  await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await page.getByLabel("Client name", { exact: true }).fill(clientName);
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await page.getByLabel("Active client").selectOption({ label: clientName });

  await page
    .getByRole("button", { name: "Connected accounts", exact: true })
    .click();
  await page
    .getByLabel("Account name", { exact: true })
    .fill(`${clientName} page`);
  await page
    .getByRole("button", { name: "Connect mock account", exact: true })
    .click();

  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await page
    .getByLabel("Required disclaimer", { exact: true })
    .fill("Terms apply");
  await page
    .getByLabel("Prohibited claims", { exact: true })
    .fill("guaranteed");
  await page
    .getByRole("button", { name: "Save brand profile", exact: true })
    .click();

  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(`${clientName} page`) })
    .click();
  await page
    .getByPlaceholder("What would you like to share?")
    .fill("A guaranteed result.");
  await page
    .getByRole("button", { name: "Check content", exact: true })
    .click();
  await expect(
    page.getByText("Changes required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Remove the prohibited claim/)).toBeVisible();
  await expect(page.getByText(/Add the required disclaimer/)).toBeVisible();

  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  await expect(
    page.getByText("Brand review blocked approval", { exact: false }),
  ).toBeVisible();
});
