"use client";
import { useState } from "react";
import { isLocale, LOCALES, useT, type Locale } from "../i18n";
import type { HubData, Mutate } from "./types";

export function LanguageSettings({
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const { t, locale: current, setLocale } = useT();
  const [locale, setLocaleChoice] = useState<Locale>(current);
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("settings.language.title")}</h2>
          <span className="muted">{t("settings.language.help")}</span>
        </div>
      </div>
      <form
        className="inline-form timezone-form"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await mutate("preferences.update", { locale });
            setLocale(locale);
          } catch {
            // mutate already reports the error.
          }
        }}
      >
        <label>
          {t("settings.language.label")}
          <select
            aria-label={t("settings.language.label")}
            value={locale}
            onChange={(event) => {
              if (isLocale(event.target.value))
                setLocaleChoice(event.target.value);
            }}
          >
            {LOCALES.map((option) => (
              <option value={option} key={option}>
                {t(`common.language.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || locale === current}>
          {t("common.action.save")}
        </button>
      </form>
    </section>
  );
}
