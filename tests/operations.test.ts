import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  type HealthCheck,
} from "../packages/server/operations";

const ok = (required = true): HealthCheck => ({ ok: true, required });
const failed = (required = true): HealthCheck => ({ ok: false, required });

describe("service readiness", () => {
  it("requires every critical dependency", () => {
    expect(
      evaluateReadiness({
        database: ok(),
        redis: ok(),
        storage: failed(),
        worker: ok(),
      }),
    ).toBe("degraded");
  });

  it("reports optional dependency failures without failing readiness", () => {
    expect(
      evaluateReadiness({
        database: ok(),
        redis: ok(),
        storage: ok(),
        worker: failed(false),
      }),
    ).toBe("ok");
  });

  it("never treats database or Redis failure as ready", () => {
    for (const dependency of ["database", "redis"] as const) {
      const checks = {
        database: ok(),
        redis: ok(),
        storage: ok(),
        worker: ok(false),
      };
      checks[dependency] = failed();
      expect(evaluateReadiness(checks)).toBe("degraded");
    }
  });
});
