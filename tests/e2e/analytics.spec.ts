import { expect, test } from "@playwright/test";
import { Pool } from "pg";

test("analytics compares periods, filters networks and ranks content", async ({
  page,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const unique = Date.now();
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
    clientId = (
      await db.query(
        "INSERT INTO clients(organization_id,name) VALUES($1,$2) RETURNING id",
        [owner.organization_id, `Analytics Studio ${unique}`],
      )
    ).rows[0].id;
    const accounts = (
      await db.query(
        `INSERT INTO social_accounts(
           organization_id,client_id,platform,name,remote_id,mode,status
         ) VALUES
           ($1,$2,'facebook',$3,$4,'mock','DISCONNECTED'),
           ($1,$2,'linkedin',$5,$6,'mock','DISCONNECTED')
         RETURNING id,platform`,
        [
          owner.organization_id,
          clientId,
          `Facebook ${unique}`,
          `analytics-facebook-${unique}`,
          `LinkedIn ${unique}`,
          `analytics-linkedin-${unique}`,
        ],
      )
    ).rows;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const account of accounts) {
      const multiplier = account.platform === "facebook" ? 1 : 2;
      for (let offset = -13; offset <= 0; offset += 1) {
        const date = new Date(today);
        date.setUTCDate(date.getUTCDate() + offset);
        const current = offset >= -6;
        const metrics = {
          followers: (current ? 1000 : 900) * multiplier,
          reach: (current ? 100 : 50) * multiplier,
          impressions: (current ? 150 : 75) * multiplier,
          engagement: (current ? 10 : 5) * multiplier,
        };
        await db.query(
          `INSERT INTO analytics_daily(
             organization_id,client_id,social_account_id,day,provider,raw,normalized
           ) VALUES($1,$2,$3,$4,$5,$6,$6)`,
          [
            owner.organization_id,
            clientId,
            account.id,
            date.toISOString().slice(0, 10),
            `mock:${account.platform}`,
            JSON.stringify(metrics),
          ],
        );
      }
    }

    for (const [index, account] of accounts.entries()) {
      const caption = index
        ? `Analytics winner ${unique}`
        : `Runner up ${unique}`;
      const post = (
        await db.query(
          `INSERT INTO posts(
             organization_id,client_id,author_id,caption,status
           ) VALUES($1,$2,$3,$4,'PUBLISHED') RETURNING id`,
          [owner.organization_id, clientId, owner.id, caption],
        )
      ).rows[0];
      const target = (
        await db.query(
          `INSERT INTO post_targets(
             organization_id,client_id,post_id,social_account_id,caption,status,
             remote_id,published_at
           ) VALUES($1,$2,$3,$4,$5,'PUBLISHED',$6,$7) RETURNING id`,
          [
            owner.organization_id,
            clientId,
            post.id,
            account.id,
            caption,
            `analytics-post-${unique}-${index}`,
            today.toISOString(),
          ],
        )
      ).rows[0];
      const interactions = index ? 50 : 10;
      const metrics = {
        likes: interactions,
        comments: index ? 5 : 2,
        shares: index ? 5 : 1,
        views: index ? 1000 : 300,
        reach: index ? 800 : 200,
        impressions: index ? 1200 : 400,
      };
      await db.query(
        `INSERT INTO post_metrics(
           organization_id,client_id,target_id,provider,raw,normalized
         ) VALUES($1,$2,$3,$4,$5,$5)`,
        [
          owner.organization_id,
          clientId,
          target.id,
          `mock:${account.platform}`,
          JSON.stringify(metrics),
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
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await page.getByRole("button", { name: "7 days", exact: true }).click();

    const reachCard = page
      .locator(".analytics-kpi")
      .filter({ hasText: "reach" });
    await expect(reachCard).toContainText("2.1K");
    await expect(reachCard).toContainText("+100%");
    await expect(
      page.locator(".top-content-list > button").first(),
    ).toContainText(`Analytics winner ${unique}`);

    await page.getByLabel("Analytics network").selectOption("facebook");
    await expect(reachCard).toContainText("700");
    await expect(
      page.getByText(`Runner up ${unique}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Analytics winner ${unique}`, { exact: true }),
    ).toHaveCount(0);
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
  }
});
