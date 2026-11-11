import { expect, test } from "@playwright/test";
import { Pool } from "pg";

// Mock mode only: the account is a mock connection, nothing is published.
test("an editor previews a calendar file, fixes it and imports drafts", async ({
  page,
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const context = () =>
    playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL },
    });
  const owner = await context();
  const editor = await context();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const unique = Date.now();
  const editorEmail = `editor-${crypto.randomUUID()}@example.test`;
  const editorPassword = crypto.randomUUID();
  let clientId = "";
  try {
    expect(
      (
        await owner.post("/api/auth/sign-up/email", {
          data: {
            email: `owner-${crypto.randomUUID()}@example.test`,
            password: crypto.randomUUID(),
            name: "Import owner",
          },
        })
      ).ok(),
    ).toBe(true);
    const client = await (
      await owner.post("/api/hub", {
        data: { action: "client.create", name: `Import ${unique}` },
      })
    ).json();
    clientId = client.id;
    const send = (action: string, data: Record<string, unknown> = {}) =>
      owner.post("/api/hub", { data: { action, clientId, ...data } });
    const account = await (
      await send("account.connect", {
        platform: "facebook",
        name: `Import page ${unique}`,
      })
    ).json();
    // CONTENT_CREATOR is the "editor": it may create posts, not publish.
    const invitation = await (
      await send("team.invite", {
        email: editorEmail,
        role: "CONTENT_CREATOR",
        clientIds: [clientId],
      })
    ).json();
    expect(
      (
        await editor.post("/api/auth/sign-up/email", {
          data: {
            email: editorEmail,
            password: editorPassword,
            name: "Import editor",
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await editor.post(
          `/api/invitation/${invitation.url.split("/").at(-1)}`,
          { data: {} },
        )
      ).ok(),
    ).toBe(true);

    await page.goto("/login");
    await page.getByLabel("Email address").fill(editorEmail);
    await page.getByLabel("Password", { exact: true }).fill(editorPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Active client").selectOption(clientId);
    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Import calendar" }),
    ).toBeVisible();

    const header = "suggested_at;text;targets;media_urls;pillar";
    const good = `2026-12-01T09:00:00+01:00;"Első vázlat ${unique}, őszi akció";${account.id};;Akció`;
    const file = (name: string, rows: string[]) => ({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from(`﻿${[header, ...rows].join("\r\n")}`),
    });
    const input = page.getByLabel("File (.csv, .json)");
    const preview = page.getByRole("table", { name: "Import preview" });
    const importButton = page.getByRole("button", {
      name: "Import",
      exact: true,
    });

    await input.setInputFiles(
      file("hibas.csv", [
        good,
        `2026-12-02 10:00;Második ${unique};${account.id};;`,
      ]),
    );
    const badRow = preview.locator("tbody tr").nth(1);
    await expect(badRow.locator("td").first()).toHaveText("3");
    await expect(badRow).toContainText("Hibás dátum (suggested_at)");
    await expect(importButton).toBeDisabled();

    await input.setInputFiles(
      file("javitott.csv", [
        good,
        `2026-12-02T10:00:00+01:00;Második ${unique};${account.id};;`,
      ]),
    );
    await expect(
      preview.getByRole("cell", { name: "OK", exact: true }),
    ).toHaveCount(2);
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(page.getByText("2 drafts imported.")).toBeVisible();

    await page.getByRole("button", { name: "Posts", exact: true }).click();
    await expect(page.getByText(`Második ${unique}`)).toBeVisible();
    const rows = (
      await db.query(
        "SELECT status,source FROM posts WHERE client_id=$1 ORDER BY created_at",
        [clientId],
      )
    ).rows;
    expect(rows).toEqual([
      { status: "DRAFT", source: "import" },
      { status: "DRAFT", source: "import" },
    ]);
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
    await owner.dispose();
    await editor.dispose();
  }
});
