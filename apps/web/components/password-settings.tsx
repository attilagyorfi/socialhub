"use client";
import { useState } from "react";

export function PasswordSettings() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Change password</h2>
      </div>
      <form
        className="settings-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          setMessage("");
          if (values.get("newPassword") !== values.get("confirmPassword")) {
            setMessage("The new passwords do not match.");
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
              setMessage(
                "Password change failed. Check your current password and try again.",
              );
              return;
            }
            form.reset();
            setMessage(
              "Password changed. Other sessions have been signed out.",
            );
          } catch {
            setMessage("Unable to connect. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={busy}
          />
          <small>At least 12 characters.</small>
        </label>
        <label>
          Confirm new password
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
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
