"use client";
import { useState } from "react";
import { useT } from "../i18n";

export function PasswordSettings() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{t("settings.password.title")}</h2>
      </div>
      <form
        className="settings-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          setMessage("");
          if (values.get("newPassword") !== values.get("confirmPassword")) {
            setMessage(t("settings.password.mismatch"));
            return;
          }
          setBusy(true);
          try {
            const response = await fetch("/api/auth/change-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                currentPassword: values.get("currentPassword"),
                newPassword: values.get("newPassword"),
                revokeOtherSessions: true,
              }),
            });
            if (!response.ok) {
              setMessage(t("settings.password.failed"));
              return;
            }
            form.reset();
            setMessage(t("settings.password.changed"));
          } catch {
            setMessage(t("settings.password.offline"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t("settings.password.current")}
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>
        <label>
          {t("settings.password.new")}
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={busy}
          />
          <small>{t("settings.password.minLength")}</small>
        </label>
        <label>
          {t("settings.password.confirm")}
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={busy}
          />
        </label>
        <div>
          <button className="primary" disabled={busy}>
            {busy
              ? t("settings.password.saving")
              : t("settings.password.title")}
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
