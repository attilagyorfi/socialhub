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
    // Rows created within one millisecond differ only in microseconds.
    const rows = [900, 400, 100].map((micros) => ({
      id: crypto.randomUUID(),
      created_at: new Date("2026-10-05T09:37:54.123Z"),
      cursor_created_at: `2026-10-05T09:37:54.123${micros}Z`,
    }));
    query.mockReturnValueOnce({ rows }).mockReturnValueOnce({ rows: [] });

    const first = await listPosts(context, { limit: 2 });
    expect(first.posts).toEqual(rows.slice(0, 2));
    expect(first.nextCursor).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")),
    ).toEqual({
      id: rows[1].id,
      createdAt: "2026-10-05T09:37:54.123400Z",
    });
    query.mockReturnValueOnce({ rows: rows.slice(2) }).mockReturnValueOnce({
      rows: [],
    });
    await listPosts(context, { limit: 2, cursor: first.nextCursor! });
    expect(query.mock.calls[2][1]).toContain("2026-10-05T09:37:54.123400Z");
  });
});
