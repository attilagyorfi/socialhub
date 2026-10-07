"use client";
import { useEffect, useState } from "react";
import { Plus, Upload, ImageIcon, Video, Link2 } from "lucide-react";
import {
  Badge,
  formatDate,
  type HubData,
  type Mutate,
  Network,
  names,
} from "./types";
import { useT, type MessageKey } from "../i18n";
import { MediaPreview } from "./composer";
import { useMediaUpload } from "./media";

const workflowFields = [
  ["firstReminderHours", "sections.workflow.firstReminderHours"],
  ["repeatReminderHours", "sections.workflow.repeatReminderHours"],
  ["maxAutomaticReminders", "sections.workflow.maxAutomaticReminders"],
  ["escalateAfterHours", "sections.workflow.escalateAfterHours"],
] as const satisfies readonly (readonly [string, MessageKey])[];
const brandFields = [
  "brandName",
  "description",
  "website",
  "products",
  "targetAudience",
  "toneOfVoice",
  "preferredTerminology",
  "forbiddenTerminology",
  "requiredTerminology",
  "forbiddenClaims",
  "requiredDisclaimer",
  "preferredCTA",
  "languages",
  "hashtags",
  "competitors",
  "instructions",
] as const;

export function Accounts({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const { t } = useT();
  // Token health reuses the shared status labels where one exists.
  const healthLabel = (health: string) => {
    for (const key of [
      `common.status.${health}`,
      `sections.tokenHealth.${health}`,
    ] as MessageKey[]) {
      const label = t(key);
      if (label !== key) return label;
    }
    return health.toLowerCase().replaceAll("_", " ");
  };
  const capabilityLabel = (capability: string) => {
    const key = `sections.capability.${capability}` as MessageKey;
    const label = t(key);
    return label === key
      ? capability.toLowerCase().replaceAll("_", " ")
      : label;
  };
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h2>{t("sections.accounts.connectTitle")}</h2>
          <span className="badge scheduled">
            {t("sections.accounts.mode", { mode: data.mode })}
          </span>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            mutate("account.connect", {
              platform: f.get("platform"),
              name: f.get("name"),
            }).catch(() => {});
          }}
        >
          <label>
            {t("sections.accounts.network")}
            <select name="platform" aria-label={t("sections.accounts.network")}>
              {Object.keys(names).map((id) => (
                <option value={id} key={id}>
                  {t(`common.network.${id}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("sections.accounts.accountName")}
            <input
              name="name"
              required
              placeholder={t("sections.accounts.accountNamePlaceholder")}
            />
          </label>
          <button className="primary" disabled={busy || data.mode !== "mock"}>
            <Plus size={16} />
            {t("sections.accounts.connectMock")}
          </button>
        </form>
        {data.mode !== "mock" && !data.meta.enabled && (
          <p className="notice">{t("sections.accounts.oauthDisabled")}</p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy || !data.meta.enabled}
            onClick={() =>
              mutate("account.oauth.start")
                .then((result) => window.location.assign(result.url))
                .catch(() => {})
            }
          >
            <Link2 size={16} />
            {t("sections.accounts.connectMeta")}
          </button>
        </div>
        {!data.meta.enabled && (
          <p className="panel-note">{t("sections.accounts.metaNote")}</p>
        )}
      </section>
      <div className="accounts-grid">
        {data.accounts.map((a) => (
          <section className="panel account-card" key={a.id}>
            <Network platform={a.platform} />
            <h2>{a.name}</h2>
            <p className="muted">
              {t(`common.network.${a.platform}` as MessageKey)}
            </p>
            <Badge status={a.status} />
            <dl>
              <dt>{t("sections.accounts.tokenHealth")}</dt>
              <dd>{healthLabel(a.token_health)}</dd>
              <dt>{t("sections.accounts.lastSync")}</dt>
              <dd>{formatDate(a.last_sync_at, data.user.timezone)}</dd>
            </dl>
            <div className="capabilities">
              {a.capabilities.map((c) => (
                <span key={c}>{capabilityLabel(c)}</span>
              ))}
            </div>
            <button
              disabled={busy || a.status === "DISCONNECTED"}
              onClick={() =>
                mutate("account.disconnect", { id: a.id }).catch(() => {})
              }
            >
              <Link2 size={15} />
              {a.mode === "direct" &&
              ["facebook", "instagram"].includes(a.platform)
                ? t("sections.accounts.disconnectMeta")
                : t("sections.accounts.disconnect")}
            </button>
          </section>
        ))}
      </div>
    </>
  );
}
export function Clients({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const [brand, setBrand] = useState(data.brand);
  const [policy, setPolicy] = useState(
    (data.workflow ?? ["EXTERNAL"]).join(","),
  );
  const [automation, setAutomation] = useState(data.approvalAutomation);
  const { t } = useT();
  const activeClient = data.clients.find((c) => c.id === data.clientId);
  const canManage = ["OWNER", "ADMIN"].includes(data.role);
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h2>{t("sections.clients.title")}</h2>
          <span className="muted">{t("sections.clients.tagline")}</span>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            mutate("client.create", {
              name: new FormData(form).get("name"),
              organizationId: data.clients[0]?.organization_id,
            })
              .then(() => form.reset())
              .catch(() => {});
          }}
        >
          <label>
            {t("sections.clients.name")}
            <input
              name="name"
              required
              maxLength={120}
              placeholder={t("sections.clients.namePlaceholder")}
            />
          </label>
          <button disabled={busy} className="primary">
            <Plus size={16} />
            {t("sections.clients.add")}
          </button>
        </form>
        <div className="account-strip">
          {data.clients.map((c) => (
            <div key={c.id}>
              <span className="brand-avatar">
                {c.name.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>{c.name}</strong>
                <small>{t(`common.role.${c.role}` as MessageKey)}</small>
              </span>
            </div>
          ))}
        </div>
        {activeClient && canManage && (
          <div className="client-locale">
            <label>
              {t("sections.clients.language")}
              <select
                value={activeClient.locale}
                disabled={busy}
                onChange={(e) =>
                  mutate("client.locale.update", {
                    locale: e.target.value,
                  }).catch(() => {})
                }
              >
                <option value="hu">{t("common.language.hu")}</option>
                <option value="en">{t("common.language.en")}</option>
              </select>
            </label>
            <p className="panel-note">{t("sections.clients.languageHelp")}</p>
          </div>
        )}
      </section>
      {data.clientId && (
        <section className="panel">
          <div className="panel-title">
            <h2>{t("sections.workflow.title")}</h2>
          </div>
          <form
            className="workflow-settings"
            onSubmit={(e) => {
              e.preventDefault();
              mutate("workflow.save", {
                steps: policy.split(","),
                automation,
              }).catch(() => {});
            }}
          >
            <label>
              {t("sections.workflow.sequence")}
              <select
                aria-label={t("sections.workflow.sequence")}
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
              >
                <option value="EXTERNAL">
                  {t("sections.workflow.external")}
                </option>
                <option value="INTERNAL">
                  {t("sections.workflow.internal")}
                </option>
                <option value="INTERNAL,EXTERNAL">
                  {t("sections.workflow.internalExternal")}
                </option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={automation.automaticReminders}
                onChange={(event) =>
                  setAutomation({
                    ...automation,
                    automaticReminders: event.target.checked,
                  })
                }
              />
              {t("sections.workflow.reminders")}
            </label>
            <div className="automation-grid">
              {workflowFields.map(([key, labelKey]) => (
                <label key={key}>
                  {t(labelKey)}
                  <input
                    aria-label={t(labelKey)}
                    type="number"
                    min={key === "maxAutomaticReminders" ? 0 : 1}
                    max={key === "maxAutomaticReminders" ? 10 : 168}
                    disabled={!automation.automaticReminders}
                    value={automation[key as keyof typeof automation] as number}
                    onChange={(event) =>
                      setAutomation({
                        ...automation,
                        [key]: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <button disabled={busy}>{t("sections.workflow.save")}</button>
          </form>
          <p className="panel-note">{t("sections.workflow.note")}</p>
        </section>
      )}
      {data.clientId && (
        <section className="panel">
          <div className="panel-title">
            <h2>
              {t("sections.brand.title", { name: activeClient?.name ?? "" })}
            </h2>
          </div>
          <form
            className="brand-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutate("brand.save", { brand }).catch(() => {});
            }}
          >
            {brandFields.map((key) => (
              <label key={key}>
                {t(`sections.brand.${key}`)}
                <textarea
                  aria-label={t(`sections.brand.${key}`)}
                  rows={key === "description" || key === "instructions" ? 3 : 2}
                  value={brand[key] ?? ""}
                  onChange={(e) =>
                    setBrand({ ...brand, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <div>
              <button className="primary" disabled={busy}>
                {t("sections.brand.save")}
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
export function Library({
  data,
  mutate,
  reload,
  onError,
}: {
  data: HubData;
  mutate: Mutate;
  reload: () => Promise<void>;
  onError: (s: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const { t } = useT();
  const { upload, uploading } = useMediaUpload({
    clientId: data.clientId!,
    mutate,
    reload,
    onError,
  });
  useEffect(() => {
    if (!data.media.some((asset) => asset.status === "PROCESSING")) return;
    const timer = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(timer);
  }, [data.media, reload]);
  return (
    <>
      <div
        className="upload-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files[0]) void upload(e.dataTransfer.files[0]);
        }}
      >
        <Upload size={25} />
        <h3>
          {uploading
            ? t("sections.library.uploading")
            : t("sections.library.drop")}
        </h3>
        <p>{t("sections.library.formats")}</p>
        <label className="upload-button">
          {t("sections.library.choose")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="media-toolbar">
        <input
          aria-label={t("sections.library.search")}
          placeholder={t("sections.library.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={t("sections.library.type")}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">{t("sections.library.all")}</option>
          <option value="image">{t("sections.library.images")}</option>
          <option value="video">{t("sections.library.videos")}</option>
        </select>
        <span className="muted">{t("sections.library.latest")}</span>
      </div>
      <div className="media-grid">
        {data.media
          .filter(
            (m) =>
              m.name.toLowerCase().includes(query.toLowerCase()) &&
              (type === "all" || m.mime_type.startsWith(type)),
          )
          .map((m) => (
            <section className="panel media-card" key={m.id}>
              <div className="media-image">
                {m.status === "READY" ? (
                  <MediaPreview
                    clientId={data.clientId!}
                    id={m.id}
                    name={m.name}
                    video={m.mime_type.startsWith("video/")}
                  />
                ) : (
                  <div className="media-placeholder">
                    {m.status === "FAILED"
                      ? t("sections.library.failed")
                      : t("sections.library.processing")}
                  </div>
                )}
              </div>
              <div>
                <strong>
                  {m.mime_type.startsWith("image/") ? (
                    <ImageIcon size={15} />
                  ) : (
                    <Video size={15} />
                  )}{" "}
                  {m.name}
                </strong>
                <small>
                  {(Number(m.size_bytes) / 1024).toFixed(0)} KB{" "}
                  {m.width ? `· ${m.width} × ${m.height}` : ""}
                </small>
                <Badge status={m.status} />
                <button
                  onClick={() =>
                    mutate("media.delete", { id: m.id }).catch(() => {})
                  }
                >
                  {t("sections.library.delete")}
                </button>
              </div>
            </section>
          ))}
      </div>
    </>
  );
}
