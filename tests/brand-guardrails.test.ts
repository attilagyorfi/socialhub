import { describe, expect, it } from "vitest";
import { checkBrandGuardrails } from "../packages/core/brand-guardrails";

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
