import { test, expect, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";

test("reviewer choice is restricted and authors cannot review their own posts", async ({
  playwright,
}) => {
  const baseURL = process.env.APP_URL!;
  const context = () =>
    playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL },
    });
  const owner = await context();
  const creator = await context();
  const manager = await context();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  // A dedicated owner keeps this test off the shared demo user's rate limit.
  const emails = [
    `owner-${crypto.randomUUID()}@example.test`,
    `creator-${crypto.randomUUID()}@example.test`,
    `manager-${crypto.randomUUID()}@example.test`,
  ];
  let clientId = "";
  let organizationId = "";
  try {
    expect(
      (
        await owner.post("/api/auth/sign-up/email", {
          data: {
            email: emails[0],
            password: crypto.randomUUID(),
            name: "Review owner",
          },
        })
      ).ok(),
    ).toBe(true);
    const client = await (
      await owner.post("/api/hub", {
        data: { action: "client.create", name: `Review rules ${Date.now()}` },
      })
    ).json();
    clientId = client.id;
    organizationId = client.organization_id;
    const send = (
      api: APIRequestContext,
      action: string,
      data: Record<string, unknown> = {},
    ) => api.post("/api/hub", { data: { action, clientId, ...data } });
    const account = await (
      await send(owner, "account.connect", {
        platform: "facebook",
        name: "Review rules",
      })
    ).json();
    expect(
      (await send(owner, "workflow.save", { steps: ["INTERNAL"] })).ok(),
    ).toBe(true);
    const join = async (
      api: APIRequestContext,
      email: string,
      role: string,
      name: string,
    ) => {
      const invitation = await (
        await send(owner, "team.invite", { email, role, clientIds: [clientId] })
      ).json();
      const signup = await api.post("/api/auth/sign-up/email", {
        data: { email, password: crypto.randomUUID(), name },
      });
      expect(signup.ok()).toBe(true);
      const token = invitation.url.split("/").at(-1);
      expect(
        (await api.post(`/api/invitation/${token}`, { data: {} })).ok(),
      ).toBe(true);
      return (await signup.json()).user.id as string;
    };
    await join(creator, emails[1], "CONTENT_CREATOR", "Review creator");
    const managerId = await join(
      manager,
      emails[2],
      "SOCIAL_MANAGER",
      "Review manager",
    );
    const ownerId = (await (await owner.get("/api/hub")).json()).user.id;
    const draft = async (api: APIRequestContext, caption: string) =>
      (
        await send(api, "post.create", {
          caption,
          targets: [{ accountId: account.id, caption, mediaIds: [] }],
        })
      ).json();

    // A content creator may renew with the same reviewer but not pick another
    // one, and cannot send manual reminders.
    const creatorPost = await draft(creator, "Creator draft");
    expect(
      (
        await send(creator, "post.submit", {
          id: creatorPost.id,
          reviewerId: managerId,
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await send(creator, "post.review.remind", { id: creatorPost.id })
      ).status(),
    ).toBe(403);
    await db.query(
      "UPDATE approval_requests SET expires_at=now()-interval '1 minute' WHERE post_id=$1 AND status='PENDING'",
      [creatorPost.id],
    );
    expect(
      (
        await send(creator, "post.review.renew", {
          id: creatorPost.id,
          reviewerId: ownerId,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await send(creator, "post.review.renew", {
          id: creatorPost.id,
          reviewerId: managerId,
        })
      ).ok(),
    ).toBe(true);

    // Authors cannot review their own post while another reviewer exists.
    const managerPost = await draft(manager, "Manager draft");
    const selfSubmit = await send(manager, "post.submit", {
      id: managerPost.id,
    });
    expect(selfSubmit.status()).toBe(422);
    expect((await selfSubmit.json()).code).toBe("SELF_REVIEW");
    expect(
      (
        await send(manager, "post.submit", {
          id: managerPost.id,
          reviewerId: ownerId,
        })
      ).ok(),
    ).toBe(true);
    const selfAssign = await send(manager, "post.review.assign", {
      id: managerPost.id,
      reviewerId: managerId,
    });
    expect(selfAssign.status()).toBe(422);
    expect((await selfAssign.json()).code).toBe("SELF_REVIEW");
    expect(
      (
        await send(owner, "post.review", {
          id: managerPost.id,
          decision: "approve",
        })
      ).ok(),
    ).toBe(true);
  } finally {
    if (clientId) {
      await db.query("DELETE FROM posts WHERE client_id=$1", [clientId]);
      await db.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }
    if (organizationId)
      await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await db.query("DELETE FROM member_invitations WHERE email=ANY($1)", [
      emails,
    ]);
    await db.query('DELETE FROM "user" WHERE email=ANY($1)', [emails]);
    await db.end();
    await Promise.all([owner.dispose(), creator.dispose(), manager.dispose()]);
  }
});
