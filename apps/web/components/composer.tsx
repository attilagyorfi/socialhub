"use client";
import { useCallback, useEffect, useState } from "react";
import { Sparkles, ImageIcon, Check, Send, ShieldCheck } from "lucide-react";
import { type HubData, type Mutate, type Post, Network } from "./types";
import {
  capabilities,
  validatePost,
  type Platform,
} from "../../../packages/core/domain";
import { useT, type MessageKey, type Vars } from "../i18n";
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
const OPERATIONS = [
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
];
// validatePost (packages/core) returns English messages; map the known ones.
const VALIDATION: Record<string, MessageKey> = {
  "Add a caption or media.": "composer.validation.empty",
  "Instagram requires an image or video.": "composer.validation.instagramMedia",
  "TikTok requires one video.": "composer.validation.tiktokVideo",
  "This network does not support a link post. Remove the link or deselect this account.":
    "composer.validation.link",
  "Media is not ready.": "composer.validation.mediaNotReady",
  "Media exceeds the MVP 100 MB upload limit.":
    "composer.validation.mediaTooLarge",
  "Video is not supported on this network.": "composer.validation.video",
  "Multiple media attachments are not supported.":
    "composer.validation.multiMedia",
};
function localizeValidation(
  t: (key: MessageKey, vars?: Vars) => string,
  message: string,
) {
  if (VALIDATION[message]) return t(VALIDATION[message]);
  const tooLong = /^Caption exceeds (\d+) characters\.$/.exec(message);
  return tooLong
    ? t("composer.validation.tooLong", { limit: tooLong[1] })
    : message;
}
const supportsLinks = (platform: string) =>
  capabilities[platform as Platform]?.includes("LINK_POST") ?? false;

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
  const { t } = useT();
  const networkName = (platform: string) =>
    t(`common.network.${platform}` as MessageKey);
  const operationLabel = (operation: string) =>
    OPERATIONS.includes(operation)
      ? t(`composer.ai.op.${operation}` as MessageKey)
      : operation;
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
    }).map(
      (message) =>
        `${networkName(a.platform)}: ${localizeValidation(t, message)}`,
    ),
  );
  // Instagram and TikTok captions cannot carry a link. Keep the field visible
  // while it still holds a value so the user can remove it.
  const showLink =
    !selected.length ||
    selected.some((a) => supportsLinks(a.platform)) ||
    !!link;
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
          <h2>{t("composer.title")}</h2>
          <span className="muted">{t("composer.draft")}</span>
        </div>
        <div className="form-section">
          <h3>{t("composer.step.accounts")}</h3>
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
                    <small>{networkName(a.platform)}</small>
                  </span>
                  {ids.includes(a.id) && <Check size={16} />}
                </button>
              ))}
          </div>
          {!data.accounts.length && (
            <p className="notice">{t("composer.noAccounts")}</p>
          )}
        </div>
        <div className="form-section">
          <label>
            <h3>{t("composer.step.content")}</h3>
            <textarea
              rows={7}
              placeholder={t("composer.caption.placeholder")}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
          <div className="caption-tools">
            <span>
              {t("composer.caption.characters", { count: caption.length })}
            </span>
            <span>{t("composer.caption.base")}</span>
          </div>
          <div className="ai-tools">
            <Sparkles size={18} />
            <select
              aria-label={t("composer.ai.action")}
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              {OPERATIONS.map((s) => (
                <option key={s} value={s}>
                  {operationLabel(s)}
                </option>
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
              {t("composer.ai.suggest")}
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
              {t("composer.ai.check")}
            </button>
          </div>
          {suggestion && (
            <div className="ai-suggestion" role="status">
              <div className="panel-title">
                <strong>{t("composer.ai.suggestion")}</strong>
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
                  {t("composer.ai.apply")}
                </button>
                <button onClick={() => setSuggestion(undefined)}>
                  {t("composer.ai.discard")}
                </button>
              </div>
              {suggestion.mode === "mock" && (
                <small>{t("composer.ai.mock")}</small>
              )}
            </div>
          )}
          {guardrails && (
            <div
              className={`guardrail-result ${guardrails.passed ? "passed" : "blocked"}`}
            >
              <div className="inline">
                <ShieldCheck size={17} />
                <strong>
                  {t("composer.guardrail.score", { score: guardrails.score })}
                </strong>
                <span>
                  {guardrails.passed
                    ? t("composer.guardrail.passed")
                    : t("composer.guardrail.failed")}
                </span>
              </div>
              {guardrails.issues.map((issue, index) => (
                <p key={`${issue.code}-${index}`}>
                  <strong>
                    {issue.severity === "BLOCK"
                      ? t("composer.guardrail.block")
                      : t("composer.guardrail.tip")}
                    :
                  </strong>{" "}
                  {issue.message}
                </p>
              ))}
              {!guardrails.issues.length && (
                <p>{t("composer.guardrail.none")}</p>
              )}
            </div>
          )}
          {!!history.length && (
            <details className="ai-history">
              <summary>
                {t("composer.history.title", { count: history.length })}
              </summary>
              {history.map((item) => (
                <div key={item.id} className="ai-history-item">
                  <div>
                    <strong>{operationLabel(item.operation)}</strong>
                    <small>
                      {item.provider} · {item.model} ·{" "}
                      {["PENDING", "COMPLETE", "FAILED"].includes(item.status)
                        ? t(
                            `composer.history.status.${item.status}` as MessageKey,
                          )
                        : item.status.toLowerCase()}
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
                      {t("composer.history.use")}
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
          {showLink && (
            <label>
              {t("composer.link")}
              <input
                type="url"
                placeholder="https://"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="form-section">
          <h3>
            <ImageIcon size={17} /> {t("composer.step.media")}
          </h3>
          <p className="muted">{t("composer.media.hint")}</p>
          <MediaPicker
            clientId={data.clientId!}
            media={data.media}
            selected={mediaIds}
            label={t("composer.media.shared")}
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
            <h3>{t("composer.step.customize")}</h3>
            {selected.map((a) => (
              <div key={a.id} className="network-override">
                <label>
                  <span className="inline">
                    <Network platform={a.platform} />
                    {networkName(a.platform)} · {a.name}
                  </span>
                  <textarea
                    aria-label={t("composer.network.caption", {
                      network: networkName(a.platform),
                    })}
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
                  {t("composer.network.useBase")}
                </button>
                <details>
                  <summary>
                    {t("composer.media.customize", {
                      network: networkName(a.platform),
                    })}
                  </summary>
                  <MediaPicker
                    clientId={data.clientId!}
                    media={data.media}
                    selected={networkMedia[a.id] ?? mediaIds}
                    label={t("composer.media.network", {
                      network: networkName(a.platform),
                    })}
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
                    {t("composer.media.useShared")}
                  </button>
                </details>
              </div>
            ))}
          </div>
        )}
        {!!validation.length && (
          <div className="notice warning" role="status">
            <strong>{t("composer.validation.title")}</strong>
            {validation.map((v, i) => (
              <p key={i}>{v}</p>
            ))}
          </div>
        )}
        {internalReview && !!selected.length && (
          <label className="form-section">
            {t("composer.reviewer.label")}
            <select
              aria-label={t("composer.reviewer.label")}
              value={reviewerId}
              onChange={(event) => setReviewerId(event.target.value)}
            >
              <option value="">{t("composer.reviewer.choose")}</option>
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
              ? t("composer.footer.internal")
              : t("composer.footer.client")}
          </small>
          <div className="button-row">
            <button disabled={busy || !ids.length} onClick={() => save(false)}>
              {t("composer.saveDraft")}
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
              {t("composer.submit")}
            </button>
          </div>
        </div>
      </section>
      <aside className="preview-column">
        <div className="preview-heading">
          <h3>{t("composer.preview.title")}</h3>
          <span className="muted">{t("composer.preview.subtitle")}</span>
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
              <strong>
                {active?.name ?? t("composer.preview.chooseAccount")}
              </strong>
              <small>
                {active
                  ? networkName(active.platform)
                  : t("composer.preview.title")}{" "}
                · {t("composer.preview.justNow")}
              </small>
            </div>
          </div>
          <p>
            {active
              ? (overrides[active.id] ?? caption) ||
                t("composer.preview.captionPlaceholder")
              : t("composer.preview.selectProfile")}
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
                    {t("composer.preview.instagramFrame", {
                      ratio: frame.replace(" / ", ":"),
                    })}
                  </small>
                </div>
              ) : (
                <MediaPreview
                  key={id}
                  clientId={data.clientId!}
                  id={id}
                  name={asset?.name}
                  video={asset?.mime_type.startsWith("video/") ?? false}
                />
              );
            },
          )}
          {link && <div className="link-preview">{link}</div>}
          <div className="preview-reactions">
            {t("composer.preview.like")}{" "}
            <span>{t("composer.preview.comment")}</span>{" "}
            {t("composer.preview.share")}
          </div>
        </div>
        <p className="preview-note">{t("composer.preview.note")}</p>
      </aside>
    </div>
  );
}
export function MediaPreview({
  clientId,
  id,
  name,
  video = false,
}: {
  clientId: string;
  id: string;
  name?: string;
  video?: boolean;
}) {
  const { t } = useT();
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
      <img src={url} alt={name || t("media.preview")} />
    )
  ) : (
    <div className="media-placeholder">{t("media.preview")}</div>
  );
}
