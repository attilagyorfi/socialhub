import type { Platform } from "./domain";

export type GuardrailIssue = {
  code: string;
  severity: "BLOCK" | "WARNING";
  message: string;
  term?: string;
  platform?: Platform;
};

export type GuardrailResult = {
  passed: boolean;
  score: number;
  issues: GuardrailIssue[];
};

const platformLimits: Record<Platform, number> = {
  facebook: 63206,
  instagram: 2200,
  linkedin: 3000,
  tiktok: 2200,
  google: 1500,
};

function values(value: unknown) {
  const source = Array.isArray(value) ? value : [value];
  return source
    .flatMap((item) => String(item ?? "").split(/[\n,;]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function includes(text: string, term: string) {
  return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

export function checkBrandGuardrails(
  text: string,
  brand: Record<string, unknown>,
  platforms: Platform[] = [],
): GuardrailResult {
  const issues: GuardrailIssue[] = [];
  const addTerms = (
    key: string,
    code: string,
    message: (term: string) => string,
    shouldFlag: (term: string) => boolean,
  ) => {
    for (const term of values(brand[key])) {
      if (shouldFlag(term))
        issues.push({ code, severity: "BLOCK", message: message(term), term });
    }
  };

  addTerms(
    "forbiddenTerminology",
    "FORBIDDEN_TERM",
    (term) => `Remove forbidden terminology: “${term}”.`,
    (term) => includes(text, term),
  );
  addTerms(
    "forbiddenClaims",
    "FORBIDDEN_CLAIM",
    (term) => `Remove the prohibited claim: “${term}”.`,
    (term) => includes(text, term),
  );
  addTerms(
    "requiredTerminology",
    "REQUIRED_TERM_MISSING",
    (term) => `Add required terminology: “${term}”.`,
    (term) => !includes(text, term),
  );
  addTerms(
    "requiredDisclaimer",
    "DISCLAIMER_MISSING",
    (term) => `Add the required disclaimer: “${term}”.`,
    (term) => !includes(text, term),
  );

  for (const platform of [...new Set(platforms)]) {
    const limit = platformLimits[platform];
    if (text.length > limit)
      issues.push({
        code: "PLATFORM_LENGTH",
        severity: "BLOCK",
        platform,
        message: `${platform} captions may contain at most ${limit} characters.`,
      });
  }

  const preferred = values(brand.preferredTerminology);
  if (preferred.length && !preferred.some((term) => includes(text, term)))
    issues.push({
      code: "PREFERRED_TERM_MISSING",
      severity: "WARNING",
      message: `Consider using preferred terminology: ${preferred.join(", ")}.`,
    });

  const blocks = issues.filter((issue) => issue.severity === "BLOCK").length;
  const warnings = issues.length - blocks;
  return {
    passed: blocks === 0,
    score: Math.max(0, 100 - blocks * 30 - warnings * 10),
    issues,
  };
}
