"use client";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { HubData, Mutate } from "./types";

const suggestedTimeZones = [
  "Europe/Budapest",
  "Europe/Vienna",
  "Europe/Prague",
  "Europe/Warsaw",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Bucharest",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function TimeZoneSettings({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const { t } = useT();
  const [timeZone, setTimeZone] = useState(data.user.timezone);
  const [detected, setDetected] = useState("");
  useEffect(() => {
    setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const options = Array.from(
    new Set([detected, data.user.timezone, ...suggestedTimeZones]),
  ).filter(Boolean);
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("settings.timezone.title")}</h2>
          <span className="muted">{t("settings.timezone.subtitle")}</span>
        </div>
      </div>
      <form
        className="inline-form timezone-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutate("preferences.update", { timezone: timeZone }).catch(() => {});
        }}
      >
        <label>
          {t("settings.timezone.label")}
          <input
            aria-label={t("settings.timezone.label")}
            list="time-zone-options"
            required
            maxLength={100}
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            placeholder="Europe/Budapest"
          />
          <datalist id="time-zone-options">
            {options.map((option) => (
              <option value={option} key={option} />
            ))}
          </datalist>
        </label>
        <button disabled={busy || timeZone === data.user.timezone}>
          {t("settings.timezone.save")}
        </button>
        {detected && detected !== timeZone && (
          <button type="button" onClick={() => setTimeZone(detected)}>
            {t("settings.timezone.useDevice")}
          </button>
        )}
      </form>
      <p className="panel-note">{t("settings.timezone.note")}</p>
    </section>
  );
}
