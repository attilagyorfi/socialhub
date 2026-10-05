import { describe, it, expect } from "vitest";
import {
  analyticsQueryInput,
  calendarQueryInput,
  postInput,
  postListQueryInput,
  timeZoneInput,
} from "../packages/server/validation";
const input = {
  clientId: crypto.randomUUID(),
  caption: "Caption",
  targets: [
    { accountId: crypto.randomUUID(), caption: "Caption", mediaIds: [] },
  ],
};
describe("optional composer links", () => {
  it("accepts an empty link without throwing from URL parsing", () => {
    expect(postInput.safeParse({ ...input, link: "" }).success).toBe(true);
  });
  it("reports malformed and unsafe links as validation errors", () => {
    for (const link of [
      "not a url",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ])
      expect(postInput.safeParse({ ...input, link }).success).toBe(false);
  });
  it("accepts HTTPS links", () => {
    expect(
      postInput.safeParse({ ...input, link: "https://example.com" }).success,
    ).toBe(true);
  });
});

describe("personal timezone input", () => {
  it("canonicalizes IANA zones and rejects unknown zones", () => {
    expect(timeZoneInput.parse(" Europe/Budapest ")).toBe("Europe/Budapest");
    expect(timeZoneInput.safeParse("Not/A_Timezone").success).toBe(false);
  });
});

describe("calendar query filters", () => {
  it("accepts a fully filtered ISO date range", () => {
    expect(
      calendarQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
        platform: "instagram",
        status: "SCHEDULED",
        authorId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });

  it("rejects unknown platforms and statuses", () => {
    expect(
      calendarQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
        platform: "myspace",
        status: "READY",
      }).success,
    ).toBe(false);
  });
});

describe("post list query filters", () => {
  it("accepts bounded search, filter and page options", () => {
    expect(
      postListQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        query: "campaign",
        status: "PUBLISHED",
        platform: "facebook",
        authorId: crypto.randomUUID(),
        approvalOnly: false,
        limit: 25,
      }).success,
    ).toBe(true);
  });

  it("rejects oversized pages and search input", () => {
    expect(
      postListQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        query: "x".repeat(201),
        limit: 101,
      }).success,
    ).toBe(false);
  });
});

describe("analytics query filters", () => {
  it("accepts an ISO date range and supported platform", () => {
    expect(
      analyticsQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        from: "2026-09-01",
        to: "2026-09-30",
        platform: "linkedin",
      }).success,
    ).toBe(true);
  });

  it("rejects timestamps and unsupported platforms", () => {
    expect(
      analyticsQueryInput.safeParse({
        clientId: crypto.randomUUID(),
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-30",
        platform: "myspace",
      }).success,
    ).toBe(false);
  });
});
