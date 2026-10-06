import { namespaces } from "./registry";

export type Locale = "hu" | "en";
export const LOCALES: Locale[] = ["hu", "en"];
export const DEFAULT_LOCALE: Locale = "hu";
export const LOCALE_COOKIE = "locale";

type Namespaces = typeof namespaces;
export type MessageKey = {
  [N in keyof Namespaces]: `${N & string}.${keyof Namespaces[N]["en"] & string}`;
}[keyof Namespaces];
export type Vars = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
  return value === "hu" || value === "en";
}

// Formatting helpers outside React (e.g. formatDate) read the active locale.
let activeLocale: Locale = DEFAULT_LOCALE;
export function currentLocale() {
  return activeLocale;
}
export function setActiveLocale(locale: Locale) {
  activeLocale = locale;
}
export function intlLocale(locale: Locale = activeLocale) {
  return locale === "hu" ? "hu-HU" : "en-GB";
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars) {
  const dot = key.indexOf(".");
  const namespace = namespaces[key.slice(0, dot) as keyof Namespaces];
  const name = key.slice(dot + 1);
  const table = namespace[locale] as Record<string, string>;
  const fallback = namespace.en as Record<string, string>;
  const template = table[name] ?? fallback[name] ?? key;
  return vars
    ? template.replace(/\{(\w+)\}/g, (match, variable: string) =>
        variable in vars ? String(vars[variable]) : match,
      )
    : template;
}

// Server error codes shown in the UI. English keeps the server message,
// which is often more specific; unknown codes keep it in every locale.
export function errorMessage(
  locale: Locale,
  code: string | undefined,
  fallback: string,
) {
  if (!code || locale === "en") return fallback;
  const key = `errors.${code}` as MessageKey;
  const translated = translate(locale, key);
  return translated === key ? fallback : translated;
}

// Message for a failed API response body ({ error, code }).
export function apiError(body: unknown, locale: Locale = activeLocale) {
  const { error, code } = (body ?? {}) as { error?: string; code?: string };
  return errorMessage(
    locale,
    code,
    error || translate(locale, "common.error.generic"),
  );
}
