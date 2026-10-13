import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});

const meta = vi.hoisted(() => ({
  replyMetaComment: vi.fn(),
  hideMetaComment: vi.fn(),
  fetchMetaComments: vi.fn(),
  subscribeMetaWebhooks: vi.fn(),
}));
vi.mock("../packages/server/meta", () => ({
  ...meta,
  metaIntegrationStatus: () => ({ enabled: true }),
}));

const {
  listComments,
  openCommentCount,
  processCommentWebhooks,
  replyToComment,
  setCommentStatus,
  syncAccountComments,
} = await import("../packages/server/comments");

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function workspace(platform: "facebook" | "instagram" = "facebook") {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    user = crypto.randomUUID(),
    account = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
    [client, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Manager',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status)
     VALUES($1,$2,$3,$4,'Page','page-1','direct','CONNECTED')`,
    [account, org, client, platform],
  );
  return {
    account,
    c: {
      organizationId: org,
      clientId: client,
      userId: user,
      role: "SOCIAL_MANAGER" as const,
    },
  };
}

async function webhook(
  w: Awaited<ReturnType<typeof workspace>>,
  value: Record<string, unknown>,
  field = "feed",
) {
  await db.query(
    `INSERT INTO webhook_events(organization_id,client_id,social_account_id,provider,external_id,event_type,payload,status)
     VALUES($1,$2,$3,'meta',$4,$5,$6,'PENDING')`,
    [
      w.c.organizationId,
      w.c.clientId,
      w.account,
      crypto.randomUUID(),
      field,
      JSON.stringify({
        object: "page",
        entryId: "page-1",
        change: { field, value },
      }),
    ],
  );
}

describe("comment inbox", () => {
  it("files Facebook webhook comments as threads and reopens answered ones", async () => {
    const w = await workspace();
    await webhook(w, {
      item: "comment",
      verb: "add",
      comment_id: "post-1_c1",
      post_id: "page-1_post-1",
      parent_id: "page-1_post-1",
      message: "Mikor nyit a bolt?",
      from: { id: "fan-1", name: "Anna" },
      created_time: 1_790_000_000,
    });
    await webhook(w, { item: "status", verb: "add" });
    expect(await processCommentWebhooks()).toMatchObject({ applied: 1 });
    const statuses = (
      await db.query<{ status: string }>(
        "SELECT status FROM webhook_events WHERE social_account_id=$1 ORDER BY status",
        [w.account],
      )
    ).rows.map((row) => row.status);
    expect(statuses).toEqual(["IGNORED", "PROCESSED"]);

    const first = await listComments(w.c, { status: "OPEN" });
    expect(first.threads).toHaveLength(1);
    expect(first.threads[0]).toMatchObject({
      authorName: "Anna",
      message: "Mikor nyit a bolt?",
      status: "OPEN",
      replies: [],
    });
    expect(first.canReply).toBe(true);

    meta.replyMetaComment.mockResolvedValueOnce({
      remoteId: "post-1_r1",
      authorRemoteId: "page-1",
    });
    const { reply } = await replyToComment(
      w.c,
      first.threads[0].id,
      "Holnap 9-kor!",
    );
    expect(reply).toMatchObject({ fromPage: true, message: "Holnap 9-kor!" });
    expect(meta.replyMetaComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "post-1_c1" }),
    );
    expect(await openCommentCount(w.c)).toBe(0);
    const done = await listComments(w.c, { status: "DONE" });
    expect(done.threads[0].replies).toHaveLength(1);

    // The fan answers again: the thread needs attention.
    await webhook(w, {
      item: "comment",
      verb: "add",
      comment_id: "post-1_c2",
      post_id: "page-1_post-1",
      parent_id: "post-1_c1",
      message: "Köszi!",
      from: { id: "fan-1", name: "Anna" },
      created_time: 1_790_000_100,
    });
    await processCommentWebhooks();
    expect(await openCommentCount(w.c)).toBe(1);

    await webhook(w, {
      item: "comment",
      verb: "remove",
      comment_id: "post-1_c1",
      post_id: "page-1_post-1",
    });
    await processCommentWebhooks();
    expect((await listComments(w.c, { status: "ALL" })).threads).toEqual([]);
  });

  it("stores Instagram webhook comments and lets a thread be closed", async () => {
    const w = await workspace("instagram");
    await webhook(
      w,
      {
        id: "ig-c1",
        text: "Szuper!",
        from: { id: "ig-fan", username: "fan.account" },
        media: { id: "media-1" },
      },
      "comments",
    );
    await processCommentWebhooks();
    const { threads } = await listComments(w.c, { status: "OPEN" });
    expect(threads[0]).toMatchObject({
      platform: "instagram",
      authorName: "fan.account",
    });
    await setCommentStatus(w.c, threads[0].id, "DONE");
    expect(await openCommentCount(w.c)).toBe(0);
  });

  it("polls comments on published posts and skips Facebook video ids", async () => {
    const w = await workspace();
    const post = crypto.randomUUID();
    await db.query(
      `INSERT INTO posts(id,organization_id,client_id,caption,status) VALUES($1,$2,$3,'Nyitás','PUBLISHED')`,
      [post, w.c.organizationId, w.c.clientId],
    );
    const target = crypto.randomUUID();
    await db.query(
      `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption,status,remote_id,published_at)
       VALUES($1,$2,$3,$4,$5,'Nyitás','PUBLISHED','page-1_post-9',now())`,
      [target, w.c.organizationId, w.c.clientId, post, w.account],
    );
    meta.fetchMetaComments.mockResolvedValueOnce([
      {
        remoteId: "c-9",
        parentRemoteId: null,
        objectRemoteId: "page-1_post-9",
        authorName: "Béla",
        authorRemoteId: "fan-2",
        message: "Ott leszek",
        createdAt: new Date().toISOString(),
        hidden: false,
        likeCount: 2,
        fromPage: false,
      },
    ]);
    meta.subscribeMetaWebhooks.mockResolvedValueOnce(true);
    await expect(
      syncAccountComments({
        id: w.account,
        organization_id: w.c.organizationId,
        client_id: w.c.clientId,
        platform: "facebook",
        remote_id: "page-1",
      }),
    ).resolves.toBe(1);
    const { threads, lastSyncedAt } = await listComments(w.c, {
      status: "OPEN",
    });
    expect(threads[0].post).toEqual({ id: post, caption: "Nyitás" });
    expect(lastSyncedAt).not.toBeNull();
    const subscribed = (
      await db.query<{ webhooks_subscribed_at: Date | null }>(
        "SELECT webhooks_subscribed_at FROM social_accounts WHERE id=$1",
        [w.account],
      )
    ).rows[0];
    expect(subscribed.webhooks_subscribed_at).not.toBeNull();
  });
});
