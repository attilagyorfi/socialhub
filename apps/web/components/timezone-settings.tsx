"use client";
import { useEffect, useState } from "react";
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
          <h2>Date and time</h2>
          <span className="muted">
            Scheduled times are stored safely in UTC.
          </span>
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
          Display timezone
          <input
            aria-label="Display timezone"
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
          Save timezone
        </button>
        {detected && detected !== timeZone && (
          <button type="button" onClick={() => setTimeZone(detected)}>
            Use device timezone
          </button>
        )}
      </form>
      <p className="panel-note">
        Calendar dates, post schedules, approvals and activity timestamps use
        this personal setting. Use an IANA timezone such as Europe/Budapest.
      </p>
    </section>
  );
}
