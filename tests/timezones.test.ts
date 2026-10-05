import { describe, expect, it } from "vitest";
import { canonicalTimeZone, validTimeZone } from "../packages/core/timezones";
import {
  localDateTimeToUtc,
  localInputValue,
} from "../apps/web/components/time";

describe("timezone validation", () => {
  it("canonicalizes supported IANA zones and rejects unsafe values", () => {
    expect(canonicalTimeZone(" Europe/Budapest ")).toBe("Europe/Budapest");
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(validTimeZone("Not/A_Timezone")).toBe(false);
    expect(validTimeZone("x".repeat(101))).toBe(false);
  });
});

describe("local scheduling", () => {
  it("converts an unambiguous local time to UTC and back", () => {
    const result = localDateTimeToUtc("2026-01-15T09:30", "Europe/Budapest");
    expect(result).toEqual({ iso: "2026-01-15T08:30:00.000Z" });
    expect(localInputValue(result.iso!, "America/New_York")).toBe(
      "2026-01-15T03:30",
    );
  });

  it("rejects missing and duplicated daylight-saving times", () => {
    expect(
      localDateTimeToUtc("2026-03-29T02:30", "Europe/Budapest").error,
    ).toContain("does not exist");
    expect(
      localDateTimeToUtc("2026-10-25T02:30", "Europe/Budapest").error,
    ).toContain("occurs twice");
  });
});
