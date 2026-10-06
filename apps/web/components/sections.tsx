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
import { MediaPreview } from "./composer";
import { useMediaUpload } from "./media";
export function Accounts({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h2>Connect an account</h2>
          <span className="badge scheduled">{data.mode} mode</span>
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
            Network
            <select name="platform" aria-label="Network">
              {Object.entries(names).map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Account name
            <input name="name" required placeholder="e.g. Terra Studio" />
          </label>
          <button className="primary" disabled={busy || data.mode !== "mock"}>
            <Plus size={16} />
            Connect mock account
          </button>
        </form>
        {data.mode !== "mock" && !data.meta.enabled && (
          <p className="notice">
            Live OAuth connections are not enabled in this build.
          </p>
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
            Connect Facebook &amp; Instagram
          </button>
        </div>
        {!data.meta.enabled && (
          <p className="panel-note">
            Meta OAuth becomes available after the Meta app credentials and API
            version are configured.
          </p>
        )}
      </section>
      <div className="accounts-grid">
        {data.accounts.map((a) => (
          <section className="panel account-card" key={a.id}>
            <Network platform={a.platform} />
            <h2>{a.name}</h2>
            <p className="muted">{names[a.platform]}</p>
            <Badge status={a.status} />
            <dl>
              <dt>Token health</dt>
              <dd>{a.token_health}</dd>
              <dt>Last sync</dt>
              <dd>{formatDate(a.last_sync_at, data.user.timezone)}</dd>
            </dl>
            <div className="capabilities">
              {a.capabilities.map((c) => (
                <span key={c}>{c.toLowerCase().replaceAll("_", " ")}</span>
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
                ? "Disconnect Meta grant"
                : "Disconnect"}
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
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h2>Client workspaces</h2>
          <span className="muted">Separate content. Shared clarity.</span>
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
            Client name
            <input
              name="name"
              required
              maxLength={120}
              placeholder="Your client’s brand"
            />
          </label>
          <button disabled={busy} className="primary">
            <Plus size={16} />
            Add client
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
                <small>{c.role.toLowerCase().replaceAll("_", " ")}</small>
              </span>
            </div>
          ))}
        </div>
      </section>
      {data.clientId && (
        <section className="panel">
          <div className="panel-title">
            <h2>Approval workflow</h2>
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
              Review sequence
              <select
                aria-label="Review sequence"
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
              >
                <option value="EXTERNAL">Client approval</option>
                <option value="INTERNAL">Internal approval</option>
                <option value="INTERNAL,EXTERNAL">
                  Internal, then client approval
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
              Send automatic reminders and escalation emails
            </label>
            <div className="automation-grid">
              {[
                ["firstReminderHours", "First reminder after (hours)"],
                ["repeatReminderHours", "Repeat every (hours)"],
                ["maxAutomaticReminders", "Maximum reminders"],
                ["escalateAfterHours", "Escalate after (hours)"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={label}
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
            <button disabled={busy}>Save workflow</button>
          </form>
          <p className="panel-note">
            Sequence and automation changes apply to new approval requests.
            Internal reviewers receive reminders; overdue internal or client
            reviews are escalated to organization administrators.
          </p>
        </section>
      )}
      {data.clientId && (
        <section className="panel">
          <div className="panel-title">
            <h2>
              Brand knowledge ·{" "}
              {data.clients.find((c) => c.id === data.clientId)?.name}
            </h2>
          </div>
          <form
            className="brand-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutate("brand.save", { brand }).catch(() => {});
            }}
          >
            {[
              ["brandName", "Brand name"],
              ["description", "Company description"],
              ["website", "Website"],
              ["products", "Products and services"],
              ["targetAudience", "Target audience"],
              ["toneOfVoice", "Tone of voice"],
              ["preferredTerminology", "Preferred terminology"],
              ["forbiddenTerminology", "Forbidden terminology"],
              ["requiredTerminology", "Required terminology"],
              ["forbiddenClaims", "Prohibited claims"],
              ["requiredDisclaimer", "Required disclaimer"],
              ["preferredCTA", "Preferred call to action"],
              ["languages", "Languages"],
              ["hashtags", "Hashtags"],
              ["competitors", "Competitors"],
              ["instructions", "Additional instructions"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  aria-label={label}
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
                Save brand profile
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
          {uploading ? "Uploading…" : "Drop a file into your media library"}
        </h3>
        <p>PNG, JPEG, WebP or MP4 · up to 20 MB per file</p>
        <label className="upload-button">
          Choose file
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4"
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
          aria-label="Search media"
          placeholder="Search your media…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Media type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">All media</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <span className="muted">Latest 50 files</span>
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
                    video={m.mime_type.startsWith("video/")}
                  />
                ) : (
                  <div className="media-placeholder">
                    {m.status === "FAILED"
                      ? "Processing failed"
                      : "Processing media…"}
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
                  Delete file
                </button>
              </div>
            </section>
          ))}
      </div>
    </>
  );
}
