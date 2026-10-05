import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/db", () => ({ pool: { query: vi.fn() } }));

import {
  analyticsRange,
  summarizeAnalyticsRows,
} from "../packages/server/analytics";

describe("analytics periods", () => {
  it("builds an equally sized previous period", () => {
    const range = analyticsRange("2026-09-01", "2026-09-30");
    expect(range.days).toBe(30);
    expect(range.range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(range.previousRange).toEqual({
      from: "2026-08-02",
      to: "2026-08-31",
    });
  });

  it("rejects reversed and overlong date ranges", () => {
    expect(() => analyticsRange("2026-09-30", "2026-09-01")).toThrow(
      "valid analytics date range",
    );
    expect(() => analyticsRange("2025-01-01", "2026-09-01")).toThrow(
      "366 days or less",
    );
  });

  it("uses the latest follower snapshot and sums daily activity", () => {
    expect(
      summarizeAnalyticsRows([
        {
          day: "2026-09-01",
          platform: "facebook",
          provider: "mock:facebook",
          followers: 100,
          reach: 20,
          impressions: 30,
          engagement: 4,
        },
        {
          day: "2026-09-02",
          platform: "facebook",
          provider: "mock:facebook",
          followers: 110,
          reach: 25,
          impressions: 40,
          engagement: 6,
        },
        {
          day: "2026-09-02",
          platform: "linkedin",
          provider: "mock:linkedin",
          followers: 50,
          reach: 10,
          impressions: 15,
          engagement: 2,
        },
      ]),
    ).toEqual({
      followers: 160,
      reach: 55,
      impressions: 85,
      engagement: 12,
    });
  });
});
