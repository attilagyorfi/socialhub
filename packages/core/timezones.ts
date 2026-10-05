export const DEFAULT_TIME_ZONE = "Europe/Budapest";

export function canonicalTimeZone(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate.length > 100) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function validTimeZone(value: string) {
  return canonicalTimeZone(value) !== null;
}
