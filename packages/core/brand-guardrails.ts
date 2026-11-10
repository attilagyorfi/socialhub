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

// A string (as the brand form stores it) is a list separated by commas,
// semicolons or new lines. Array items are already separate terms and are kept
// whole, so a synced phrase or disclaimer containing a comma is not split.
function values(value: unknown) {
  const source = Array.isArray(value)
    ? value.map((item) => String(item ?? ""))
    : String(value ?? "").split(/[\n,;]+/);
  return source.map((item) => item.trim()).filter(Boolean);
}

// The local profile's list fields, split the way they always were: a string
// and each item of an array at commas, semicolons and new lines.
const localListKeys = [
  "forbiddenTerminology",
  "forbiddenClaims",
  "requiredTerminology",
  "requiredDisclaimer",
  "preferredTerminology",
] as const;
const localTerms = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).flatMap(values);

export type BrandPillar = { name: string; description: string | null };

// Brand profile the Growth Engine owns, as stored in brand_profiles.synced_profile.
export type SyncedBrandProfile = {
  voice: string | null;
  required_phrases: string[];
  forbidden_phrases: string[];
  required_disclaimer: string | null;
  pillars: BrandPillar[];
};

function union(local: unknown, synced: string[]) {
  const seen = new Set<string>();
  return [...localTerms(local), ...synced].filter((term) => {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The brand rules in force for a client: the local profile edited in Social
// Hub combined with the profile synced from the Growth Engine (the owner).
// Phrase lists are unions; a synced voice or disclaimer replaces the local one.
// Guardrail checks, AI prompts and AI brand snapshots all use this result.
export function effectiveBrandRules(
  local: Record<string, unknown> | null | undefined,
  synced: SyncedBrandProfile | null | undefined,
): Record<string, unknown> {
  const brand = { ...(local ?? {}) };
  // Local arrays are pre-split so the guardrails keep treating them as before.
  for (const key of localListKeys)
    if (Array.isArray(brand[key])) brand[key] = localTerms(brand[key]);
  if (!synced) return brand;
  brand.forbiddenTerminology = union(
    brand.forbiddenTerminology,
    synced.forbidden_phrases,
  );
  brand.requiredTerminology = union(
    brand.requiredTerminology,
    synced.required_phrases,
  );
  // An array keeps a disclaimer with commas in it as one required text.
  if (synced.required_disclaimer)
    brand.requiredDisclaimer = [synced.required_disclaimer];
  if (synced.voice) brand.toneOfVoice = synced.voice;
  if (synced.pillars.length) brand.contentPillars = synced.pillars;
  return brand;
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
