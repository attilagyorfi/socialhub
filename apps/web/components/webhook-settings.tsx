"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Webhook } from "lucide-react";
import { useT, type MessageKey } from "../i18n";
import { formatDate } from "./types";

const events = [
  "post.approved",
  "post.changes_requested",
  "post.published",
  "post.failed",
] as const;

type Endpoint = {
  id: string;
  url: string;
  events: string[];
  secret_prefix: string;
  created_at: string;
  secret_rotated_at: string | null;
  revoked_at: string | null;
};

// Organization webhook endpoints for the /api/v1 integration contract. Only
// owners and administrators can manage them; the signing secret is shown once
// after creation or rotation.
export function WebhookSettings({
  clientId,
  canManage,
  timeZone,
}: {
  clientId: string;
  canManage: boolean;
  timeZone: string;
}) {
  const { t } = useT();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([...events]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/webhooks?clientId=${encodeURIComponent(clientId)}`,
    );
    if (!response.ok) throw new Error("load failed");
    setEndpoints((await response.json()).endpoints);
  }, [clientId]);

  useEffect(() => {
    if (canManage) load().catch(() => setError("settings.webhooks.failed"));
  }, [canManage, load]);

  async function send(fields: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...fields }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          ["WEBHOOK_URL_BLOCKED", "WEBHOOK_URL_UNRESOLVABLE"].includes(
            result.code,
          )
            ? "settings.webhooks.invalidUrl"
            : result.code === "WEBHOOK_LIMIT"
              ? "settings.webhooks.limit"
              : "settings.webhooks.failed",
        );
        return;
      }
      await load();
      return result;
    } catch {
      setError("settings.webhooks.failed");
    } finally {
      setBusy(false);
    }
  }

  function showSecret(result: { secret?: string } | undefined) {
    if (result?.secret) {
      setSecret(result.secret);
      setCopied(false);
    }
  }

  const eventLabel = (event: string) =>
    t(`settings.webhooks.event.${event}` as MessageKey);

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("settings.webhooks.title")}</h2>
          <span className="muted">{t("settings.webhooks.subtitle")}</span>
        </div>
        <Webhook size={20} />
      </div>
      {!canManage ? (
        <div className="empty compact">{t("settings.webhooks.adminOnly")}</div>
      ) : (
        <>
          <form
            className="inline-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await send({
                action: "create",
                url,
                events: selected,
              });
              if (result?.secret) {
                showSecret(result);
                setUrl("");
              }
            }}
          >
            <label>
              {t("settings.webhooks.url")}
              <input
                type="url"
                aria-label={t("settings.webhooks.url")}
                placeholder={t("settings.webhooks.urlPlaceholder")}
                maxLength={2048}
                pattern="https://.*"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <fieldset className="client-choices">
              <legend>{t("settings.webhooks.events")}</legend>
              {events.map((event) => (
                <label key={event}>
                  <input
                    type="checkbox"
                    checked={selected.includes(event)}
                    onChange={(change) =>
                      setSelected(
                        change.target.checked
                          ? [...selected, event]
                          : selected.filter((item) => item !== event),
                      )
                    }
                  />
                  {eventLabel(event)}
                </label>
              ))}
            </fieldset>
            <button
              className="primary"
              disabled={busy || !url.trim() || !selected.length}
            >
              {t("settings.webhooks.create")}
            </button>
          </form>
          {secret && (
            <div className="notice invitation-link" role="status">
              <span>
                <strong>{t("settings.webhooks.secretWarning")}</strong>{" "}
                <code>{secret}</code>
              </span>
              <button
                type="button"
                aria-label={t("settings.webhooks.copyLabel")}
                onClick={() =>
                  navigator.clipboard
                    .writeText(secret)
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
              >
                <Copy size={15} />{" "}
                {t(
                  copied
                    ? "settings.webhooks.copied"
                    : "settings.webhooks.copy",
                )}
              </button>
              <button type="button" onClick={() => setSecret(null)}>
                {t("common.action.close")}
              </button>
            </div>
          )}
          {error && (
            <div className="notice invitation-link" role="alert">
              {t(error)}
            </div>
          )}
          {endpoints.map((endpoint) => (
            <div className="pending-invite" key={endpoint.id}>
              <Webhook size={18} />
              <span>
                <strong>{endpoint.url}</strong>
                <small>
                  {endpoint.events.map(eventLabel).join(", ")} ·{" "}
                  <code>{endpoint.secret_prefix}…</code> ·{" "}
                  {endpoint.secret_rotated_at
                    ? t("settings.webhooks.rotatedAt", {
                        date: formatDate(endpoint.secret_rotated_at, timeZone),
                      })
                    : t("settings.webhooks.createdAt", {
                        date: formatDate(endpoint.created_at, timeZone),
                      })}
                </small>
              </span>
              {endpoint.revoked_at ? (
                <span className="muted">
                  {t("settings.webhooks.revokedAt", {
                    date: formatDate(endpoint.revoked_at, timeZone),
                  })}
                </span>
              ) : (
                <>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("settings.webhooks.rotateConfirm", {
                            url: endpoint.url,
                          }),
                        )
                      )
                        send({ action: "rotate", id: endpoint.id })
                          .then(showSecret)
                          .catch(() => {});
                    }}
                  >
                    {t("settings.webhooks.rotate")}
                  </button>
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("settings.webhooks.revokeConfirm", {
                            url: endpoint.url,
                          }),
                        )
                      )
                        send({ action: "revoke", id: endpoint.id }).catch(
                          () => {},
                        );
                    }}
                  >
                    {t("settings.webhooks.revoke")}
                  </button>
                </>
              )}
            </div>
          ))}
          {!endpoints.length && (
            <div className="empty compact">{t("settings.webhooks.empty")}</div>
          )}
        </>
      )}
    </section>
  );
}
