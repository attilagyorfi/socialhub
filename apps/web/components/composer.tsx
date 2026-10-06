"use client";
import { useCallback, useEffect, useState } from "react";
import { Sparkles, ImageIcon, Check, Send, ShieldCheck } from "lucide-react";
import { type HubData, type Mutate, type Post, Network, names } from "./types";
import { validatePost, type Platform } from "../../../packages/core/domain";
import {
  FramedImage,
  MediaPicker,
  instagramFrame,
  signedMedia,
  useMediaUpload,
} from "./media";

type GuardrailResult = {
  passed: boolean;
  score: number;
  issues: { code: string; severity: "BLOCK" | "WARNING"; message: string }[];
};
type Generation = {
  id: string;
  operation: string;
  provider: string;
  model: string;
  mode: string;
  status: string;
  output?: string;
  guardrail_result?: GuardrailResult;
  applied_at?: string;
  created_at: string;
};
export function Composer({
  data,
  mutate,
  busy,
  onCreated,
  editing,
  error,
  reload,
  onError,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  onCreated: (p: Post, reviewUrl?: string) => void;
  editing?: Post;
  error?: string;
}) {
  const [caption, setCaption] = useState(editing?.caption ?? "");
  const [link, setLink] = useState(editing?.link ?? "");
  const [ids, setIds] = useState<string[]>(
    editing?.targets.map((t) => t.accountId) ?? [],
  );
  const [mediaIds, setMediaIds] = useState<string[]>(
    editing?.targets[0]?.mediaIds ?? [],
  );
  const [overrides, setOverrides] = useState<Record<string, string>>(
    Object.fromEntries(
      editing?.targets
        .filter((t) => t.caption !== editing.caption)
        .map((t) => [t.accountId, t.caption]) ?? [],
    ),
  );
  const [networkMedia, setNetworkMedia] = useState<Record<string, string[]>>(
    Object.fromEntries(
      editing?.targets.map((t) => [t.accountId, t.mediaIds]) ?? [],
    ),
  );
  const [preview, setPreview] = useState("");
  const [suggestion, setSuggestion] = useState<{
    id: string;
    text: string;
    mode: string;
    provider: string;
    model: string;
    guardrails: GuardrailResult;
  }>();
  const [guardrails, setGuardrails] = useState<GuardrailResult>();
  const [history, setHistory] = useState<Generation[]>([]);
  const [operation, setOperation] = useState("generate");
  const { upload, uploading } = useMediaUpload({
    clientId: data.clientId!,
    mutate,
    reload,
    onError,
  });
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  const internalReview = data.workflow[0] === "INTERNAL";
  // Authors may review their own post only when nobody else can.
  const independentReviewers = data.reviewers.filter(
    (reviewer) => reviewer.id !== data.user.id,
  );
  const [reviewerId, setReviewerId] = useState(
    independentReviewers[0]?.id ?? data.reviewers[0]?.id ?? "",
  );
  const selected = data.accounts.filter((a) => ids.includes(a.id));
  const active = selected.find((a) => a.id === preview) ?? selected[0];
  const validation = selected.flatMap((a) =>
    validatePost(a.platform as Platform, {
      caption: overrides[a.id] ?? caption,
      link,
      media: data.media.filter((m) =>
        (networkMedia[a.id] ?? mediaIds).includes(m.id),
      ),
    }).map((message) => `${names[a.platform]}: ${message}`),
  );
  const loadHistory = useCallback(async () => {
    if (!data.clientId) return;
    const response = await fetch(
      `/api/ai-generations?${new URLSearchParams({ clientId: data.clientId, limit: "8" })}`,
    );
    if (!response.ok) return;
    setHistory((await response.json()).generations);
  }, [data.clientId]);
  useEffect(() => {
    loadHistory().catch(() => {});
  }, [loadHistory]);

  async function applySuggestion(item: { id: string; text: string }) {
    await mutate("ai.apply", { id: item.id });
    setCaption(item.text);
    setSuggestion(undefined);
    await loadHistory();
  }
  async function save(submit = false) {
    try {
      const p = await mutate(editing ? "post.edit" : "post.create", {
        id: editing?.id,
        caption,
        link,
        targets: selected.map((a) => ({
          accountId: a.id,
          caption: overrides[a.id] ?? caption,
          mediaIds: networkMedia[a.id] ?? mediaIds,
        })),
      });
      const draft = {
        ...p,
        targets: selected.map((a) => ({
          id: a.id,
          accountId: a.id,
          caption: overrides[a.id] ?? caption,
          platform: a.platform,
          mediaIds: networkMedia[a.id] ?? mediaIds,
          status: "DRAFT",
        })),
      };
      if (!submit) return onCreated(draft);
      try {
        const review = await mutate("post.submit", {
          id: p.id,
          ...(internalReview ? { reviewerId } : {}),
        });
        onCreated({ ...draft, status: "PENDING_APPROVAL" }, review.url);
      } catch {
        // The draft is saved; its details show why submission was refused.
        onCreated(draft);
      }
    } catch {}
  }
  return (
    <div className="composer-grid">
      <section className="panel composer-form">
        <div className="panel-title">
          <h2>Post composer</h2>
          <span className="muted">Draft</span>
        </div>
        <div className="form-section">
          <h3>1. Choose your accounts</h3>
          <div className="profile-picks">
            {data.accounts
              .filter((a) => a.status === "CONNECTED")
              .map((a) => (
                <button
                  key={a.id}
                  className={ids.includes(a.id) ? "selected" : ""}
                  onClick={() =>
                    setIds(
                      ids.includes(a.id)
                        ? ids.filter((id) => id !== a.id)
                        : [...ids, a.id],
                    )
                  }
                >
                  <Network platform={a.platform} />
                  <span>
                    {a.name}
                    <small>{names[a.platform]}</small>
                  </span>
                  {ids.includes(a.id) && <Check size={16} />}
                </button>
              ))}
          </div>
          {!data.accounts.length && (
            <p className="notice">
              Connect an account in Connected accounts first.
            </p>
          )}
        </div>
        <div className="form-section">
          <label>
            <h3>2. Write your content</h3>
            <textarea
              rows={7}
              placeholder="What would you like to share?"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
          <div className="caption-tools">
            <span>{caption.length} characters</span>
            <span>Base caption · all selected networks</span>
          </div>
          <div className="ai-tools">
            <Sparkles size={18} />
            <select
              aria-label="AI action"
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              {[
                "generate",
                "alternatives",
                "rewrite",
                "shorten",
                "expand",
                "professional",
                "casual",
                "facebook",
                "instagram",
                "linkedin",
                "tiktok",
                "hashtags",
                "cta",
                "translate",
                "ideas",
                "series",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button
              disabled={busy}
              onClick={() =>
                mutate("ai.generate", {
                  operation,
                  text: caption,
                  platforms: selected.map((account) => account.platform),
                  postId: editing?.id,
                })
                  .then((r) => {
                    setSuggestion(r);
                    setGuardrails(r.guardrails);
                    loadHistory().catch(() => {});
                  })
                  .catch(() => {})
              }
            >
              Suggest caption
            </button>
            <button
              disabled={busy}
              onClick={() =>
                mutate("ai.check", {
                  text: caption,
                  platforms: selected.map((account) => account.platform),
                })
                  .then(setGuardrails)
                  .catch(() => {})
              }
            >
              Check content
            </button>
          </div>
          {suggestion && (
            <div className="ai-suggestion" role="status">
              <div className="panel-title">
                <strong>AI suggestion</strong>
                <small>
                  {suggestion.provider} · {suggestion.model}
                </small>
              </div>
              <p>{suggestion.text}</p>
              <div className="inline">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => applySuggestion(suggestion).catch(() => {})}
                >
                  Apply suggestion
                </button>
                <button onClick={() => setSuggestion(undefined)}>
                  Discard
                </button>
              </div>
              {suggestion.mode === "mock" && (
                <small>
                  Mock writing suggestion — no AI service was called.
                </small>
              )}
            </div>
          )}
          {guardrails && (
            <div
              className={`guardrail-result ${guardrails.passed ? "passed" : "blocked"}`}
            >
              <div className="inline">
                <ShieldCheck size={17} />
                <strong>Brand score: {guardrails.score}/100</strong>
                <span>
                  {guardrails.passed ? "Ready for review" : "Changes required"}
                </span>
              </div>
              {guardrails.issues.map((issue, index) => (
                <p key={`${issue.code}-${index}`}>
                  <strong>
                    {issue.severity === "BLOCK" ? "Block" : "Tip"}:
                  </strong>{" "}
                  {issue.message}
                </p>
              ))}
              {!guardrails.issues.length && (
                <p>No brand rule conflicts found.</p>
              )}
            </div>
          )}
          {!!history.length && (
            <details className="ai-history">
              <summary>Recent AI generations ({history.length})</summary>
              {history.map((item) => (
                <div key={item.id} className="ai-history-item">
                  <div>
                    <strong>{item.operation}</strong>
                    <small>
                      {item.provider} · {item.model} ·{" "}
                      {item.status.toLowerCase()}
                    </small>
                  </div>
                  {item.output && <p>{item.output}</p>}
                  {item.output && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        applySuggestion({
                          id: item.id,
                          text: item.output!,
                        }).catch(() => {})
                      }
                    >
                      Use this version
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
          <label>
            Link URL
            <input
              type="url"
              placeholder="https://"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
        </div>
        <div className="form-section">
          <h3>
            <ImageIcon size={17} /> 3. Attach media
          </h3>
          <p className="muted">
            Upload a new file or pick one from the media library.
          </p>
          <MediaPicker
            clientId={data.clientId!}
            media={data.media}
            selected={mediaIds}
            label="Shared attachments"
            onToggle={(id) => setMediaIds((current) => toggle(current, id))}
            uploading={uploading}
            onUpload={(file) =>
              void upload(file).then((id) => {
                if (id) setMediaIds((current) => [...current, id]);
              })
            }
          />
        </div>
        {!!selected.length && (
          <div className="form-section">
            <h3>4. Customize each network</h3>
            {selected.map((a) => (
              <div key={a.id} className="network-override">
                <label>
                  <span className="inline">
                    <Network platform={a.platform} />
                    {names[a.platform]} · {a.name}
                  </span>
                  <textarea
                    aria-label={`${names[a.platform]} caption`}
                    rows={3}
                    value={overrides[a.id] ?? caption}
                    onChange={(e) =>
                      setOverrides({ ...overrides, [a.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() =>
                    setOverrides((current) => {
                      const next = { ...current };
                      delete next[a.id];
                      return next;
                    })
                  }
                >
                  Use base caption
                </button>
                <details>
                  <summary>Customize {names[a.platform]} attachments</summary>
                  <MediaPicker
                    clientId={data.clientId!}
                    media={data.media}
                    selected={networkMedia[a.id] ?? mediaIds}
                    label={`${names[a.platform]} attachments`}
                    onToggle={(id) =>
                      setNetworkMedia((current) => ({
                        ...current,
                        [a.id]: toggle(current[a.id] ?? mediaIds, id),
                      }))
                    }
                  />
                  <button
                    className="text-button"
                    onClick={() =>
                      setNetworkMedia((current) => {
                        const next = { ...current };
                        delete next[a.id];
                        return next;
                      })
                    }
                  >
                    Use shared attachments
                  </button>
                </details>
              </div>
            ))}
          </div>
        )}
        {!!validation.length && (
          <div className="notice warning" role="status">
            <strong>Fix before sending for approval</strong>
            {validation.map((v, i) => (
              <p key={i}>{v}</p>
            ))}
          </div>
        )}
        {internalReview && !!selected.length && (
          <label className="form-section">
            Internal reviewer
            <select
              aria-label="Internal reviewer"
              value={reviewerId}
              onChange={(event) => setReviewerId(event.target.value)}
            >
              <option value="">Choose a reviewer</option>
              {data.reviewers.map((reviewer) => (
                <option key={reviewer.id} value={reviewer.id}>
                  {reviewer.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        <div className="composer-footer">
          <small>
            {internalReview
              ? "The reviewer is notified when you send it."
              : "Sending creates a link for your client to approve."}
          </small>
          <div className="button-row">
            <button disabled={busy || !ids.length} onClick={() => save(false)}>
              Save draft
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !ids.length ||
                !!validation.length ||
                (internalReview && !reviewerId)
              }
              onClick={() => save(true)}
            >
              <Send size={16} />
              Send for approval
            </button>
          </div>
        </div>
      </section>
      <aside className="preview-column">
        <div className="preview-heading">
          <h3>Post preview</h3>
          <span className="muted">Content preview</span>
        </div>
        <div className="preview-tabs">
          {selected.map((a) => (
            <button
              key={a.id}
              className={active?.id === a.id ? "active" : ""}
              onClick={() => setPreview(a.id)}
            >
              <Network platform={a.platform} />
            </button>
          ))}
        </div>
        <div className="post-preview">
          <div className="preview-author">
            <span className="brand-avatar">
              {data.clients
                .find((c) => c.id === data.clientId)
                ?.name.slice(0, 2)
                .toUpperCase()}
            </span>
            <div>
              <strong>{active?.name ?? "Choose an account"}</strong>
              <small>
                {active ? names[active.platform] : "Post preview"} · Just now
              </small>
            </div>
          </div>
          <p>
            {active
              ? (overrides[active.id] ?? caption) ||
                "Your caption will appear here."
              : "Select a profile to preview your post."}
          </p>
          {(active ? (networkMedia[active.id] ?? mediaIds) : mediaIds).map(
            (id) => {
              const asset = data.media.find((m) => m.id === id);
              const frame =
                active?.platform === "instagram" &&
                asset?.mime_type.startsWith("image/")
                  ? instagramFrame(asset)
                  : undefined;
              return frame && asset ? (
                <div key={id}>
                  <FramedImage
                    clientId={data.clientId!}
                    asset={asset}
                    aspectRatio={frame}
                  />
                  <small className="preview-frame-note">
                    Instagram receives a {frame.replace(" / ", ":")} framed
                    version; nothing is cropped.
                  </small>
                </div>
              ) : (
                <MediaPreview
                  key={id}
                  clientId={data.clientId!}
                  id={id}
                  video={asset?.mime_type.startsWith("video/") ?? false}
                />
              );
            },
          )}
          {link && <div className="link-preview">{link}</div>}
          <div className="preview-reactions">
            Like <span>Comment</span> Share
          </div>
        </div>
        <p className="preview-note">
          A content preview, not an exact rendering of the social network. Final
          presentation may vary.
        </p>
      </aside>
    </div>
  );
}
export function MediaPreview({
  clientId,
  id,
  video = false,
}: {
  clientId: string;
  id: string;
  video?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [poster, setPoster] = useState("");
  useEffect(() => {
    let active = true;
    signedMedia(clientId, id)
      .then((r) => {
        if (active) {
          setUrl(r.url);
          setPoster(r.previewUrl);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clientId, id]);
  return url ? (
    video ? (
      <video
        src={url}
        poster={poster || undefined}
        controls
        preload="metadata"
      />
    ) : (
      <img src={url} alt="Attached media" />
    )
  ) : (
    <div className="media-placeholder">Media preview</div>
  );
}
