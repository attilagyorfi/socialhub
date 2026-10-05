import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../packages/db", () => ({
  pool: { query: vi.fn() },
}));

vi.mock("../packages/server/transaction", () => ({
  transaction: async <T>(
    fn: (tx: { query: typeof mocks.query }) => Promise<T>,
  ) => fn({ query: mocks.query }),
  audit: mocks.audit,
}));

import { reschedulePost } from "../packages/server/calendar";

const context = {
  userId: crypto.randomUUID(),
  organizationId: crypto.randomUUID(),
  clientId: crypto.randomUUID(),
  role: "ADMIN" as const,
};

function scheduledRows(revision = 3) {
  const jobId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  return {
    jobId,
    targetId,
    idempotencyKey,
    implementation(sql: string) {
      if (sql.includes("SELECT j.*,t.status AS target_status"))
        return {
          rows: [
            {
              id: jobId,
              target_id: targetId,
              status: "PENDING",
              attempts: 0,
              idempotency_key: idempotencyKey,
            },
          ],
        };
      if (sql.includes("SELECT id,status FROM post_targets"))
        return { rows: [{ id: targetId, status: "SCHEDULED" }] };
      if (sql.includes("SELECT * FROM posts"))
        return {
          rows: [
            {
              id: "post",
              status: "SCHEDULED",
              revision,
              scheduled_at: new Date(Date.now() + 60_000),
            },
          ],
        };
      if (sql.includes("SELECT 1 FROM publish_jobs"))
        return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE publish_jobs")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE posts"))
        return {
          rows: [
            {
              id: "post",
              status: "SCHEDULED",
              scheduled_at: new Date(Date.now() + 3_600_000),
              revision: revision + 1,
            },
          ],
        };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe("safe calendar rescheduling", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.audit.mockReset();
  });

  it("moves the existing job and keeps its idempotency identity", async () => {
    const rows = scheduledRows();
    mocks.query.mockImplementation(rows.implementation);

    const result = await reschedulePost(
      context,
      crypto.randomUUID(),
      new Date(Date.now() + 3_600_000).toISOString(),
      3,
    );

    const jobUpdate = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE publish_jobs"),
    );
    expect(jobUpdate?.[1]?.[1]).toEqual([rows.jobId]);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO publish_jobs"),
      ),
    ).toBe(false);
    expect(result.revision).toBe(4);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      context,
      "post.rescheduled",
      expect.any(String),
      expect.objectContaining({ revision: 4 }),
    );
  });

  it("rejects a stale calendar revision before changing the job", async () => {
    const rows = scheduledRows(5);
    mocks.query.mockImplementation(rows.implementation);

    await expect(
      reschedulePost(
        context,
        crypto.randomUUID(),
        new Date(Date.now() + 3_600_000).toISOString(),
        4,
      ),
    ).rejects.toMatchObject({ code: "STALE_POST", status: 409 });
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE publish_jobs"),
      ),
    ).toBe(false);
  });

  it("rejects a job after its first publishing attempt", async () => {
    const rows = scheduledRows();
    mocks.query.mockImplementation((sql: string) => {
      const result = rows.implementation(sql);
      if (sql.includes("SELECT j.*,t.status AS target_status"))
        return {
          rows: result.rows.map((row: Record<string, unknown>) => ({
            ...row,
            attempts: 1,
          })),
        };
      return result;
    });

    await expect(
      reschedulePost(
        context,
        crypto.randomUUID(),
        new Date(Date.now() + 3_600_000).toISOString(),
        3,
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_STARTED", status: 409 });
  });
});
