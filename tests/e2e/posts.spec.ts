import { expect, test } from "@playwright/test";
import { Pool } from "pg";

test("post library searches, filters and cursor-paginates on the server", async ({
  page,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const unique = Date.now();
  const needle = `Needle campaign ${unique}`;
  let clientId = "";

  try {
    const owner = (
      await db.query(
        `SELECT u.id,om.organization_id
         FROM "user" u JOIN organization_members om ON om.user_id=u.id
         WHERE u.email=$1 AND om.role='OWNER' LIMIT 1`,
        [process.env.DEMO_EMAIL],
      )
    ).rows[0];
    const client = (
      await db.query(
        "INSERT INTO clients(organization_id,name) VALUES($1,$2) RETURNING id",
        [owner.organization_id, `Post Library ${unique}`],
      )
    ).rows[0];
    clientId = client.id;
    const accounts = (
      await db.query(
        `INSERT INTO social_accounts(
           organization_id,client_id,platform,name,remote_id,mode
         ) VALUES
           ($1,$2,'facebook',$3,$4,'mock'),
           ($1,$2,'instagram',$5,$6,'mock')
         RETURNING id,platform`,
        [
          owner.organization_id,
          clientId,
          `Facebook ${unique}`,
          `facebook-${unique}`,
          `Instagram ${unique}`,
          `instagram-${unique}`,
        ],
      )
    ).rows;

    for (let index = 0; index < 28; index += 1) {
      const highlighted = index === 13;
      const caption = highlighted ? needle : `Library post ${index} ${unique}`;
      const status = highlighted ? "PUBLISHED" : "DRAFT";
      const platform = highlighted ? "instagram" : "facebook";
      const account = accounts.find(
        (candidate) => candidate.platform === platform,
      );
      const createdAt = new Date(Date.now() - index * 1000).toISOString();
      const post = (
        await db.query(
          `INSERT INTO posts(
             organization_id,client_id,author_id,caption,status,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
          [
            owner.organization_id,
            clientId,
            owner.id,
            caption,
            status,
            createdAt,
          ],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO post_targets(
           organization_id,client_id,post_id,social_account_id,caption,status,
           created_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          owner.organization_id,
          clientId,
          post.id,
          account.id,
          caption,
          status,
          createdAt,
        ],
      );
    }

    await page.goto("/login");
    await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
    await page
      .getByLabel("Password", { exact: true })
      .fill(process.env.DEMO_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Active client").selectOption(clientId);
    await page.getByRole("button", { name: "Posts", exact: true }).click();

    await expect(page.locator("tbody tr")).toHaveCount(25);
    const firstResponse = await page.request.get(
      `/api/posts?clientId=${clientId}&limit=10`,
    );
    expect(firstResponse.ok()).toBe(true);
    const firstPage = await firstResponse.json();
    expect(firstPage.posts).toHaveLength(10);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondResponse = await page.request.get(
      `/api/posts?clientId=${clientId}&limit=10&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    expect(secondResponse.ok()).toBe(true);
    const secondPage = await secondResponse.json();
    expect(secondPage.posts).toHaveLength(10);
    expect(
      new Set([
        ...firstPage.posts.map((post: { id: string }) => post.id),
        ...secondPage.posts.map((post: { id: string }) => post.id),
      ]).size,
    ).toBe(20);

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(3);

    await page.getByLabel("Search posts").fill(needle);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByText(needle, { exact: true })).toBeVisible();

    await page.getByLabel("Search posts").fill("");
    await page.getByLabel("Filter posts by network").selectOption("instagram");
    await page.getByLabel("Filter by status").selectOption("PUBLISHED");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByText(needle, { exact: true })).toBeVisible();
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
  }
});
