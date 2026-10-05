import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../packages/db", () => ({ pool: { query } }));

import { listPosts } from "../packages/server/post-list";

const context = {
  userId: crypto.randomUUID(),
  organizationId: crypto.randomUUID(),
  clientId: crypto.randomUUID(),
  role: "ADMIN" as const,
};

describe("post list cursors", () => {
  beforeEach(() => query.mockReset());

  it("rejects malformed opaque cursors before querying", async () => {
    await expect(
      listPosts(context, { cursor: "not-a-cursor", limit: 25 }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 422 });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a stable cursor from the last visible row", async () => {
    const rows = [0, 1, 2].map((index) => ({
      id: crypto.randomUUID(),
      created_at: new Date(Date.now() - index * 1000),
    }));
    query.mockReturnValueOnce({ rows }).mockReturnValueOnce({ rows: [] });

    const first = await listPosts(context, { limit: 2 });
    expect(first.posts).toEqual(rows.slice(0, 2));
    expect(first.nextCursor).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")),
    ).toEqual({
      id: rows[1].id,
      createdAt: rows[1].created_at.toISOString(),
    });
  });
});
