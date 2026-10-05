import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { processApprovalAutomations } from "../../packages/server/approvals";

test("automatic approval reminders and escalation use the durable outbox", async ({
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let clientId = "";
  try {
    await api.post("/api/auth/sign-in/email", {
      data: {
        email: process.env.DEMO_EMAIL,
        password: process.env.DEMO_PASSWORD,
      },
    });
    const client = await (
      await api.post("/api/hub", {
        data: {
          action: "client.create",
          name: `Automated review ${Date.now()}`,
        },
      })
    ).json();
    clientId = client.id;
    const account = await (
      await api.post("/api/hub", {
        data: {
          action: "account.connect",
          clientId,
          platform: "facebook",
          name: "Automation page",
        },
      })
    ).json();
    const owner = (
      await db.query('SELECT id,email FROM "user" WHERE email=$1', [
        process.env.DEMO_EMAIL,
      ])
    ).rows[0];
    const send = (action: string, data: Record<string, unknown> = {}) =>
      api.post("/api/hub", { data: { action, clientId, ...data } });
    expect(
      (
        await send("workflow.save", {
          steps: ["INTERNAL"],
          automation: {
            automaticReminders: true,
            firstReminderHours: 1,
            repeatReminderHours: 2,
            escalateAfterHours: 3,
            maxAutomaticReminders: 2,
          },
        })
      ).ok(),
    ).toBe(true);
    expect((await send("workflow.save", { steps: ["INTERNAL"] })).ok()).toBe(
      true,
    );
    const hub = await (await api.get(`/api/hub?clientId=${clientId}`)).json();
    expect(hub.approvalAutomation).toEqual({
      automaticReminders: true,
      firstReminderHours: 1,
      repeatReminderHours: 2,
      escalateAfterHours: 3,
      maxAutomaticReminders: 2,
    });
    const post = await (
      await send("post.create", {
        caption: "Automation review caption",
        targets: [
          {
            accountId: account.id,
            caption: "Automation review caption",
            mediaIds: [],
          },
        ],
      })
    ).json();
    expect(
      (await send("post.submit", { id: post.id, reviewerId: owner.id })).ok(),
    ).toBe(true);
    const request = (
      await db.query(
        `SELECT id,next_reminder_at,escalation_at
         FROM approval_requests WHERE post_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [post.id],
      )
    ).rows[0];
    expect(request.next_reminder_at).toBeTruthy();
    expect(request.escalation_at).toBeTruthy();

    await db.query(
      `UPDATE approval_requests SET next_reminder_at=now()-interval '1 minute',
         escalation_at=now()+interval '1 hour' WHERE id=$1`,
      [request.id],
    );
    await processApprovalAutomations();
    const reminder = (
      await db.query(
        `SELECT status,attempts FROM approval_automation_deliveries
         WHERE approval_request_id=$1 AND kind='REMINDER'`,
        [request.id],
      )
    ).rows[0];
    expect(reminder).toMatchObject({ status: "SENT", attempts: 1 });
    const afterReminder = (
      await db.query(
        `SELECT reminder_count,automatic_reminder_count,next_reminder_at
         FROM approval_requests WHERE id=$1`,
        [request.id],
      )
    ).rows[0];
    expect(afterReminder.reminder_count).toBe(1);
    expect(afterReminder.automatic_reminder_count).toBe(1);
    expect(afterReminder.next_reminder_at).toBeTruthy();

    const staleDelivery = (
      await db.query(
        `INSERT INTO approval_automation_deliveries(
           organization_id,client_id,approval_request_id,kind,sequence,
           recipient_user_id,recipient_email
         ) SELECT organization_id,client_id,id,'REMINDER',99,$2,$3
           FROM approval_requests WHERE id=$1 RETURNING id`,
        [request.id, owner.id, owner.email],
      )
    ).rows[0];
    expect(
      (
        await send("post.review.assign", { id: post.id, reviewerId: owner.id })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await db.query(
          "SELECT status FROM approval_automation_deliveries WHERE id=$1",
          [staleDelivery.id],
        )
      ).rows[0].status,
    ).toBe("CANCELLED");

    await db.query(
      "UPDATE approval_requests SET escalation_at=now()-interval '1 minute' WHERE id=$1",
      [request.id],
    );
    await processApprovalAutomations();
    const escalations = (
      await db.query(
        `SELECT status FROM approval_automation_deliveries
         WHERE approval_request_id=$1 AND kind='ESCALATION'`,
        [request.id],
      )
    ).rows;
    expect(escalations.length).toBeGreaterThan(0);
    expect(escalations.every((delivery) => delivery.status === "SENT")).toBe(
      true,
    );
    expect(
      (
        await db.query(
          "SELECT escalated_at FROM approval_requests WHERE id=$1",
          [request.id],
        )
      ).rows[0].escalated_at,
    ).toBeTruthy();
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM audit_logs
             WHERE resource_id=$1 AND action IN (
               'approval.automatic_reminder_queued','approval.automatic_reminder_sent',
               'approval.escalation_queued','approval.escalation_sent'
             )`,
            [post.id],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThanOrEqual(4);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM notifications WHERE resource_id=$1 AND message LIKE '%escalated%'",
            [post.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);

    await processApprovalAutomations();
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM approval_automation_deliveries WHERE approval_request_id=$1",
            [request.id],
          )
        ).rows[0].count,
      ),
    ).toBe(2 + escalations.length);

    const retryDelivery = (
      await db.query(
        `INSERT INTO approval_automation_deliveries(
           organization_id,client_id,approval_request_id,kind,sequence,
           recipient_user_id,recipient_email
         ) SELECT organization_id,client_id,id,'REMINDER',100,$2,$3
           FROM approval_requests WHERE id=$1 RETURNING id`,
        [request.id, owner.id, owner.email],
      )
    ).rows[0];
    const smtpUrl = process.env.SMTP_URL;
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    try {
      await processApprovalAutomations();
    } finally {
      process.env.SMTP_URL = smtpUrl;
    }
    expect(
      (
        await db.query(
          `SELECT status,attempts,error_code,run_at>now() AS retry_scheduled
           FROM approval_automation_deliveries WHERE id=$1`,
          [retryDelivery.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: "FAILED",
      attempts: 1,
      error_code: "EMAIL_DELIVERY_FAILED",
      retry_scheduled: true,
    });
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    await db.end();
    await api.dispose();
  }
});
