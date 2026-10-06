"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  LOCALE_COOKIE,
  setActiveLocale,
  translate,
  type Locale,
  type MessageKey,
  type Vars,
} from "./core";

export * from "./core";

type Translator = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
};
const I18nContext = createContext<Translator | undefined>(undefined);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  setActiveLocale(locale);
  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    setLocaleState(next);
    // Lets the login page and the server-rendered <html lang> follow along.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
  }, []);
  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t: (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useT must be used inside I18nProvider");
  return context;
}
