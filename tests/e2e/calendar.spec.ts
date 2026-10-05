import { test, expect } from "@playwright/test";
import { DateTime } from "luxon";
import { Pool } from "pg";

test("calendar loads its date range and safely reschedules an existing job", async ({
  page,
}) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const unique = Date.now();
  const clientName = `Calendar Studio ${unique}`;
  const caption = `Calendar campaign ${unique}`;
  const initialTime = DateTime.now()
    .setZone("Europe/Budapest")
    .plus({ days: 1 })
    .startOf("hour");
  const droppedTime = initialTime.plus({ days: 2 });
  const movedTime = droppedTime.plus({ hours: 2 });
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
        [owner.organization_id, clientName],
      )
    ).rows[0];
    clientId = client.id;
    const account = (
      await db.query(
        `INSERT INTO social_accounts(
           organization_id,client_id,platform,name,remote_id,mode
         ) VALUES($1,$2,'facebook',$3,$4,'mock') RETURNING id`,
        [owner.organization_id, clientId, clientName, `calendar-${unique}`],
      )
    ).rows[0];
    const post = (
      await db.query(
        `INSERT INTO posts(
           organization_id,client_id,author_id,caption,status,scheduled_at
         ) VALUES($1,$2,$3,$4,'SCHEDULED',$5) RETURNING id`,
        [
          owner.organization_id,
          clientId,
          owner.id,
          caption,
          initialTime.toUTC().toISO(),
        ],
      )
    ).rows[0];
    const target = (
      await db.query(
        `INSERT INTO post_targets(
           organization_id,client_id,post_id,social_account_id,caption,status
         ) VALUES($1,$2,$3,$4,$5,'SCHEDULED') RETURNING id`,
        [owner.organization_id, clientId, post.id, account.id, caption],
      )
    ).rows[0];
    const job = (
      await db.query(
        `INSERT INTO publish_jobs(
           organization_id,client_id,target_id,run_at
         ) VALUES($1,$2,$3,$4) RETURNING id,idempotency_key`,
        [
          owner.organization_id,
          clientId,
          target.id,
          initialTime.toUTC().toISO(),
        ],
      )
    ).rows[0];

    await page.goto("/login");
    await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
    await page
      .getByLabel("Password", { exact: true })
      .fill(process.env.DEMO_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Active client").selectOption(clientId);
    await page.getByRole("button", { name: "Calendar", exact: true }).click();

    const calendarPost = page.locator(".calendar-post").filter({
      hasText: caption,
    });
    await expect(calendarPost).toBeVisible();
    const destination = page.locator(
      `.calendar-day[data-date="${droppedTime.toISODate()}"]`,
    );
    await calendarPost.dragTo(destination, {
      targetPosition: { x: 24, y: 24 },
    });
    await expect(page.locator(".success-notice")).toContainText(
      "Post rescheduled.",
    );
    const movedCalendarPost = destination.locator(".calendar-post").filter({
      hasText: caption,
    });
    await expect(movedCalendarPost).toBeVisible();
    await movedCalendarPost.click();
    await expect(page.getByRole("dialog")).toContainText(caption);
    await page
      .getByLabel("Move to · Europe/Budapest")
      .fill(movedTime.toFormat("yyyy-LL-dd'T'HH:mm"));
    await page
      .getByRole("button", { name: "Reschedule post", exact: true })
      .click();
    await expect(page.locator(".success-notice")).toContainText(
      "Post rescheduled.",
    );

    await expect
      .poll(async () => {
        const state = (
          await db.query(
            `SELECT p.revision,j.id,j.idempotency_key,j.run_at,j.status
             FROM posts p JOIN post_targets t ON t.post_id=p.id
             JOIN publish_jobs j ON j.target_id=t.id WHERE p.id=$1`,
            [post.id],
          )
        ).rows[0];
        return {
          revision: state.revision,
          jobId: state.id,
          idempotencyKey: state.idempotency_key,
          runAt: new Date(state.run_at).toISOString(),
          status: state.status,
        };
      })
      .toEqual({
        revision: 3,
        jobId: job.id,
        idempotencyKey: job.idempotency_key,
        runAt: movedTime.toUTC().toISO(),
        status: "PENDING",
      });
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM audit_logs WHERE resource_id=$1 AND action='post.rescheduled'",
            [post.id],
          )
        ).rows[0].count,
      ),
    ).toBe(2);
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
  }
});
