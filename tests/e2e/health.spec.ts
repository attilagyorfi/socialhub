import { expect, test } from "@playwright/test";

test("liveness and readiness expose safe dependency status", async ({
  request,
}) => {
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  await expect(live.json()).resolves.toMatchObject({ status: "ok" });

  const ready = await request.get("/api/health/ready");
  expect(ready.status()).toBe(200);
  const payload = await ready.json();
  expect(payload).toMatchObject({
    status: "ok",
    checks: {
      database: { ok: true, required: true },
      redis: { ok: true, required: true },
      storage: { ok: true, required: true },
      worker: { ok: true },
    },
  });
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain("DATABASE_URL");
  expect(serialized).not.toContain("postgresql://");
  expect(serialized).not.toContain("redis://");
  expect(serialized).not.toContain("accessKeyId");
});
