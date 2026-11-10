import { describe, expect, it } from "vitest";
import {
  checkBrandGuardrails,
  effectiveBrandRules,
  type SyncedBrandProfile,
} from "../packages/core/brand-guardrails";

const synced = (
  overrides: Partial<SyncedBrandProfile> = {},
): SyncedBrandProfile => ({
  voice: null,
  required_phrases: [],
  forbidden_phrases: [],
  required_disclaimer: null,
  pillars: [],
  ...overrides,
});

describe("effective brand rules", () => {
  it("applies synced forbidden phrases and disclaimer the local profile lacks", () => {
    const brand = effectiveBrandRules(
      { forbiddenTerminology: "cheap" },
      synced({
        forbidden_phrases: ["miracle"],
        required_disclaimer: "Ad",
      }),
    );
    const codes = checkBrandGuardrails("A miracle offer.", brand).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(["FORBIDDEN_TERM", "DISCLAIMER_MISSING"]);
    expect(
      checkBrandGuardrails("Too cheap. Ad", brand).issues.map((i) => i.code),
    ).toEqual(["FORBIDDEN_TERM"]);
  });

  it("checks a synced disclaimer or phrase with a comma as one text", () => {
    const brand = effectiveBrandRules(
      {},
      synced({
        required_disclaimer: "Terms, conditions apply",
        forbidden_phrases: ["free, forever"],
      }),
    );
    // Both halves present separately would pass if the text were split.
    const split = checkBrandGuardrails("conditions apply. Terms. free", brand);
    expect(split.issues).toEqual([
      expect.objectContaining({
        code: "DISCLAIMER_MISSING",
        term: "Terms, conditions apply",
      }),
    ]);
    const whole = checkBrandGuardrails(
      "Free, forever! Terms, conditions apply",
      brand,
    );
    expect(whole.issues).toEqual([
      expect.objectContaining({
        code: "FORBIDDEN_TERM",
        term: "free, forever",
      }),
    ]);
  });

  it("unions phrase lists, prefers synced voice and disclaimer, adds pillars", () => {
    const brand = effectiveBrandRules(
      {
        forbiddenTerminology: "cheap, Miracle",
        requiredTerminology: "G2A",
        requiredDisclaimer: "Local disclaimer",
        toneOfVoice: "Local tone",
        brandName: "Acme",
      },
      synced({
        voice: "Warm and direct",
        forbidden_phrases: ["miracle", "best ever"],
        required_phrases: ["#acme"],
        required_disclaimer: "Synced disclaimer",
        pillars: [{ name: "Education", description: null }],
      }),
    );
    expect(brand).toEqual({
      brandName: "Acme",
      forbiddenTerminology: ["cheap", "Miracle", "best ever"],
      requiredTerminology: ["G2A", "#acme"],
      requiredDisclaimer: ["Synced disclaimer"],
      toneOfVoice: "Warm and direct",
      contentPillars: [{ name: "Education", description: null }],
    });
  });

  it("still splits local array items at separators, with or without a sync", () => {
    const local = { forbiddenTerminology: ["cheap, best"] };
    for (const brand of [
      effectiveBrandRules(local, null),
      effectiveBrandRules(local, synced({ forbidden_phrases: ["a, b"] })),
    ])
      expect(
        checkBrandGuardrails("Best price", brand).issues.map((i) => i.term),
      ).toEqual(["best"]);
  });

  it("keeps the local disclaimer when the synced one is null", () => {
    expect(
      effectiveBrandRules({ requiredDisclaimer: "Local" }, synced())
        .requiredDisclaimer,
    ).toBe("Local");
    expect(effectiveBrandRules({ a: "b" }, null)).toEqual({ a: "b" });
  });
});

describe("brand guardrails", () => {
  it("blocks forbidden terminology and prohibited claims", () => {
    const result = checkBrandGuardrails(
      "Our guaranteed miracle product is here.",
      { forbiddenTerminology: "miracle", forbiddenClaims: "guaranteed" },
      ["facebook"],
    );
    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "FORBIDDEN_TERM",
      "FORBIDDEN_CLAIM",
    ]);
  });

  it("requires configured terminology and disclaimers", () => {
    const result = checkBrandGuardrails("A simple product update.", {
      requiredTerminology: "G2A verified",
      requiredDisclaimer: "Terms apply",
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(40);
  });

  it("still splits a locally stored string at commas, semicolons and new lines", () => {
    const result = checkBrandGuardrails("Cheap and best", {
      forbiddenTerminology: "cheap, miracle;best\nfree",
      requiredDisclaimer: "Ad, Sponsored",
    });
    expect(result.issues.map((issue) => [issue.code, issue.term])).toEqual([
      ["FORBIDDEN_TERM", "cheap"],
      ["FORBIDDEN_TERM", "best"],
      ["DISCLAIMER_MISSING", "Ad"],
      ["DISCLAIMER_MISSING", "Sponsored"],
    ]);
  });

  it("returns warnings without blocking approval", () => {
    const result = checkBrandGuardrails("A compliant caption.", {
      preferredTerminology: "community first",
    });
    expect(result.passed).toBe(true);
    expect(result.issues[0]?.severity).toBe("WARNING");
  });

  it("checks each selected platform limit", () => {
    const result = checkBrandGuardrails("x".repeat(1501), {}, [
      "google",
      "facebook",
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "PLATFORM_LENGTH", platform: "google" }),
    ]);
  });
});
