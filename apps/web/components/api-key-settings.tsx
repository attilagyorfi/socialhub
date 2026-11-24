"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { useT } from "../i18n";
import { formatDate } from "./types";

type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

// Organization API keys for the /api/v1 integration API. Only owners and
// administrators can manage them; the raw key is shown once after creation.
export function ApiKeySettings({
  clientId,
  canManage,
  timeZone,
}: {
  clientId: string;
  canManage: boolean;
  timeZone: string;
}) {
  const { t } = useT();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/api-keys?clientId=${encodeURIComponent(clientId)}`,
    );
    if (!response.ok) throw new Error("load failed");
    setKeys((await response.json()).keys);
  }, [clientId]);

  useEffect(() => {
    if (canManage) load().catch(() => setError(true));
  }, [canManage, load]);

  async function send(fields: Record<string, unknown>) {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...fields }),
      });
      if (!response.ok) throw new Error("request failed");
      const result = await response.json();
      await load();
      return result;
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("settings.apiKeys.title")}</h2>
          <span className="muted">{t("settings.apiKeys.subtitle")}</span>
        </div>
        <KeyRound size={20} />
      </div>
      {!canManage ? (
        <div className="empty compact">{t("settings.apiKeys.adminOnly")}</div>
      ) : (
        <>
          <form
            className="inline-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await send({ action: "create", name });
              if (result?.key) {
                setCreated(result.key);
                setCopied(false);
                setName("");
              }
            }}
          >
            <label>
              {t("settings.apiKeys.name")}
              <input
                aria-label={t("settings.apiKeys.name")}
                placeholder={t("settings.apiKeys.namePlaceholder")}
                maxLength={80}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button className="primary" disabled={busy || !name.trim()}>
              {t("settings.apiKeys.create")}
            </button>
          </form>
          {created && (
            <div className="notice invitation-link" role="status">
              <span>
                <strong>{t("settings.apiKeys.copyWarning")}</strong>{" "}
                <code>{created}</code>
              </span>
              <button
                type="button"
                aria-label={t("settings.apiKeys.copyLabel")}
                onClick={() =>
                  navigator.clipboard
                    .writeText(created)
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
              >
                <Copy size={15} />{" "}
                {t(
                  copied ? "settings.apiKeys.copied" : "settings.apiKeys.copy",
                )}
              </button>
              <button type="button" onClick={() => setCreated(null)}>
                {t("common.action.close")}
              </button>
            </div>
          )}
          {error && (
            <div className="notice invitation-link" role="alert">
              {t("settings.apiKeys.failed")}
            </div>
          )}
          {keys.map((key) => (
            <div className="pending-invite" key={key.id}>
              <KeyRound size={18} />
              <span>
                <strong>{key.name}</strong>
                <small>
                  <code>{key.key_prefix}…</code> ·{" "}
                  {t("settings.apiKeys.createdAt", {
                    date: formatDate(key.created_at, timeZone),
                  })}{" "}
                  ·{" "}
                  {key.last_used_at
                    ? t("settings.apiKeys.lastUsed", {
                        date: formatDate(key.last_used_at, timeZone),
                      })
                    : t("settings.apiKeys.neverUsed")}
                </small>
              </span>
              {key.revoked_at ? (
                <span className="muted">
                  {t("settings.apiKeys.revokedAt", {
                    date: formatDate(key.revoked_at, timeZone),
                  })}
                </span>
              ) : (
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        t("settings.apiKeys.revokeConfirm", { name: key.name }),
                      )
                    )
                      send({ action: "revoke", id: key.id }).catch(() => {});
                  }}
                >
                  {t("settings.apiKeys.revoke")}
                </button>
              )}
            </div>
          ))}
          {!keys.length && (
            <div className="empty compact">{t("settings.apiKeys.empty")}</div>
          )}
        </>
      )}
    </section>
  );
}
