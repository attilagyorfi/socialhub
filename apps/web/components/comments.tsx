"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { EyeOff, Heart, RefreshCw } from "lucide-react";
import { formatDate, Network } from "./types";
import { apiError, useT, type MessageKey } from "../i18n";

type CommentStatus = "OPEN" | "DONE";
type Reply = {
  id: string;
  authorName: string | null;
  message: string;
  createdAt: string;
  fromPage: boolean;
  hidden: boolean;
};
type Thread = {
  id: string;
  platform: "facebook" | "instagram";
  accountName: string;
  authorName: string | null;
  message: string;
  createdAt: string;
  likeCount: number;
  hidden: boolean;
  status: CommentStatus;
  post: { id: string; caption: string } | null;
  replies: Reply[];
};
type CommentsResult = {
  threads: Thread[];
  nextBefore: string | null;
  openCount: number;
  canReply: boolean;
  lastSyncedAt: string | null;
};

const statusFilters = ["OPEN", "DONE", "ALL"] as const;
const platforms = ["facebook", "instagram"] as const;
const emptyResult: CommentsResult = {
  threads: [],
  nextBefore: null,
  openCount: 0,
  canReply: false,
  lastSyncedAt: null,
};

function truncate(value: string, length = 60) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

export function Comments({
  clientId,
  timeZone,
  refreshKey,
  onOpenPost,
  onCountChange,
}: {
  clientId: string;
  timeZone: string;
  refreshKey: number;
  onOpenPost: (postId: string) => void;
  onCountChange?: (open: number) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<(typeof statusFilters)[number]>("OPEN");
  const [platform, setPlatform] = useState("all");
  const [result, setResult] = useState<CommentsResult>(emptyResult);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const sequence = useRef(0);
  const countChange = useRef(onCountChange);
  useEffect(() => {
    countChange.current = onCountChange;
  }, [onCountChange]);

  const request = useCallback(
    async (before: string | undefined, signal?: AbortSignal) => {
      const params = new URLSearchParams({
        clientId,
        status,
        ...(platform !== "all" ? { platform } : {}),
        ...(before ? { before } : {}),
      });
      const response = await fetch(`/api/comments?${params}`, {
        signal,
        headers: { Accept: "application/json" },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiError(body));
      return body as CommentsResult;
    },
    [clientId, platform, status],
  );

  useEffect(() => {
    const requestId = ++sequence.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    request(undefined, controller.signal)
      .then((body) => {
        if (requestId !== sequence.current) return;
        setResult(body);
        countChange.current?.(body.openCount);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (requestId === sequence.current)
          setLoadError(
            error instanceof Error ? error.message : t("comments.error.load"),
          );
      })
      .finally(() => {
        if (requestId === sequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, reloadKey, request, t]);

  const reload = () => setReloadKey((current) => current + 1);

  async function loadOlder() {
    if (!result.nextBefore) return;
    const requestId = sequence.current;
    setLoadingOlder(true);
    setLoadError("");
    try {
      const body = await request(result.nextBefore);
      if (requestId !== sequence.current) return;
      setResult((current) => ({
        ...body,
        threads: [
          ...current.threads,
          ...body.threads.filter(
            (thread) => !current.threads.some((item) => item.id === thread.id),
          ),
        ],
      }));
      countChange.current?.(body.openCount);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : t("comments.error.load"),
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  async function post(fields: Record<string, unknown>) {
    const response = await fetch("/api/comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ clientId, ...fields }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(apiError(body));
    return body;
  }

  async function act(
    id: string,
    fields: Record<string, unknown>,
    success: MessageKey,
  ) {
    setBusyId(id);
    setActionError("");
    setNotice("");
    try {
      await post({ id, ...fields });
      if (fields.action === "reply")
        setDrafts((current) => ({ ...current, [id]: "" }));
      setNotice(t(success));
      reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("comments.error.action"),
      );
    } finally {
      setBusyId("");
    }
  }

  async function sync() {
    setSyncing(true);
    setActionError("");
    setNotice("");
    try {
      const body = (await post({ action: "sync" })) as { synced?: number };
      const count = body.synced ?? 0;
      setNotice(
        t(count === 1 ? "comments.synced.one" : "comments.synced.other", {
          count,
        }),
      );
      reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("comments.error.sync"),
      );
    } finally {
      setSyncing(false);
    }
  }

  const authorLabel = (name: string | null, network: string) =>
    name ||
    (network === "facebook" || network === "instagram"
      ? t(`comments.author.${network}`)
      : t("comments.author.fallback"));

  return (
    <section className="panel" aria-busy={loading}>
      <div className="panel-title">
        <h2>{t("comments.title")}</h2>
        <span className="muted">
          {loading
            ? t("comments.loading")
            : t("comments.openCount", { count: result.openCount })}
        </span>
      </div>
      <div className="post-toolbar comment-toolbar">
        <select
          aria-label={t("comments.filter.status")}
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as (typeof statusFilters)[number])
          }
        >
          {statusFilters.map((value) => (
            <option key={value} value={value}>
              {t(`comments.status.${value}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("comments.filter.network")}
          value={platform}
          onChange={(event) => setPlatform(event.target.value)}
        >
          <option value="all">{t("comments.filter.allNetworks")}</option>
          {platforms.map((value) => (
            <option key={value} value={value}>
              {t(`common.network.${value}`)}
            </option>
          ))}
        </select>
        <button
          onClick={() => void sync()}
          disabled={syncing}
          aria-label={t("comments.refresh.label")}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {syncing ? t("comments.refreshing") : t("comments.refresh")}
        </button>
        <span className="muted comment-synced">
          {result.lastSyncedAt
            ? t("comments.lastSynced", {
                time: formatDate(result.lastSyncedAt, timeZone),
              })
            : t("comments.neverSynced")}
        </span>
      </div>
      <div className="comment-messages">
        <div role="status" className="sr-only">
          {loading ? t("comments.loading") : ""}
        </div>
        {notice && (
          <div role="status" className="success-notice">
            {notice}
            <button className="text-button" onClick={() => setNotice("")}>
              {t("common.action.dismiss")}
            </button>
          </div>
        )}
        {actionError && (
          <div role="alert" className="alert">
            {actionError}
            <button className="text-button" onClick={() => setActionError("")}>
              {t("common.action.dismiss")}
            </button>
          </div>
        )}
        {loadError && (
          <div role="alert" className="alert">
            {loadError}
            <button className="text-button" onClick={reload}>
              {t("common.action.tryAgain")}
            </button>
          </div>
        )}
      </div>
      {!loading && !loadError && !result.threads.length && (
        <div className="empty compact">
          {status === "OPEN" ? t("comments.empty.open") : t("comments.empty")}
        </div>
      )}
      {loading && !result.threads.length && !loadError && (
        <div className="empty compact">{t("comments.loading")}</div>
      )}
      {!!result.threads.length && (
        <ul className="comment-list">
          {result.threads.map((thread) => {
            const author = authorLabel(thread.authorName, thread.platform);
            const draft = drafts[thread.id] ?? "";
            const busy = busyId === thread.id;
            const caption = thread.post
              ? truncate(thread.post.caption) || t("comments.post.media")
              : "";
            const submitReply = () => {
              const message = draft.trim();
              if (!message || busy) return;
              void act(
                thread.id,
                { action: "reply", message },
                "comments.notice.replied",
              );
            };
            return (
              <li
                key={thread.id}
                className={`comment-card${thread.status === "DONE" ? " done" : ""}`}
              >
                <div className="comment-head">
                  <Network platform={thread.platform} />
                  <div className="comment-meta">
                    <strong>{author}</strong>
                    <span className="muted">
                      {thread.accountName} ·{" "}
                      <time dateTime={thread.createdAt}>
                        {formatDate(thread.createdAt, timeZone)}
                      </time>
                    </span>
                  </div>
                  <div className="comment-badges">
                    {thread.hidden && (
                      <span className="badge comment-hidden">
                        <EyeOff size={11} aria-hidden="true" />
                        {t("comments.hidden")}
                      </span>
                    )}
                    {thread.status === "DONE" && (
                      <span className="badge published">
                        {t("comments.status.DONE")}
                      </span>
                    )}
                  </div>
                </div>
                <p className="comment-message">{thread.message}</p>
                <div className="comment-foot">
                  <span className="muted comment-likes">
                    <Heart size={13} aria-hidden="true" />
                    {t(
                      thread.likeCount === 1
                        ? "comments.likes.one"
                        : "comments.likes.other",
                      { count: thread.likeCount },
                    )}
                  </span>
                  {thread.post && (
                    <button
                      className="text-button comment-post-link"
                      aria-label={t("comments.openPost.label", { caption })}
                      onClick={() => onOpenPost(thread.post!.id)}
                    >
                      {t("comments.openPost")}
                      <span className="comment-post-caption">“{caption}”</span>
                    </button>
                  )}
                </div>
                {!!thread.replies.length && (
                  <ul className="comment-replies">
                    {thread.replies.map((reply) => {
                      const replyAuthor = reply.fromPage
                        ? reply.authorName || thread.accountName
                        : authorLabel(reply.authorName, thread.platform);
                      return (
                        <li
                          key={reply.id}
                          className={`comment-reply${reply.fromPage ? " from-page" : ""}`}
                        >
                          <div className="comment-reply-head">
                            <strong>{replyAuthor}</strong>
                            {reply.fromPage && (
                              <span className="badge comment-page-label">
                                {t("comments.yourPage")}
                              </span>
                            )}
                            {reply.hidden && (
                              <span className="badge comment-hidden">
                                <EyeOff size={11} aria-hidden="true" />
                                {t("comments.hidden")}
                              </span>
                            )}
                            <time className="muted" dateTime={reply.createdAt}>
                              {formatDate(reply.createdAt, timeZone)}
                            </time>
                          </div>
                          <p className="comment-message">{reply.message}</p>
                          {result.canReply && !reply.fromPage && (
                            <button
                              className="text-button"
                              disabled={busyId === reply.id}
                              aria-label={t(
                                reply.hidden
                                  ? "comments.unhide.label"
                                  : "comments.hide.label",
                                { author: replyAuthor },
                              )}
                              onClick={() =>
                                void act(
                                  reply.id,
                                  { action: "hide", hidden: !reply.hidden },
                                  reply.hidden
                                    ? "comments.notice.unhidden"
                                    : "comments.notice.hidden",
                                )
                              }
                            >
                              {reply.hidden
                                ? t("comments.unhide")
                                : t("comments.hide")}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {result.canReply && (
                  <div className="comment-actions">
                    <form
                      className="comment-reply-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitReply();
                      }}
                    >
                      <textarea
                        aria-label={t("comments.reply.label", { author })}
                        placeholder={t("comments.reply.placeholder")}
                        value={draft}
                        maxLength={2000}
                        rows={2}
                        disabled={busy}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [thread.id]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            (event.ctrlKey || event.metaKey)
                          ) {
                            event.preventDefault();
                            submitReply();
                          }
                        }}
                      />
                      <div className="comment-reply-row">
                        <span className="muted comment-hint">
                          {t("comments.reply.hint")}
                        </span>
                        <button
                          type="submit"
                          className="primary"
                          disabled={busy || !draft.trim()}
                        >
                          {busy ? t("comments.sending") : t("comments.reply")}
                        </button>
                      </div>
                    </form>
                    <div className="comment-thread-buttons">
                      <button
                        className="text-button"
                        disabled={busy}
                        aria-label={t(
                          thread.hidden
                            ? "comments.unhide.label"
                            : "comments.hide.label",
                          { author },
                        )}
                        onClick={() =>
                          void act(
                            thread.id,
                            { action: "hide", hidden: !thread.hidden },
                            thread.hidden
                              ? "comments.notice.unhidden"
                              : "comments.notice.hidden",
                          )
                        }
                      >
                        {thread.hidden
                          ? t("comments.unhide")
                          : t("comments.hide")}
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            thread.id,
                            {
                              action: "status",
                              status:
                                thread.status === "OPEN" ? "DONE" : "OPEN",
                            },
                            thread.status === "OPEN"
                              ? "comments.notice.done"
                              : "comments.notice.reopened",
                          )
                        }
                      >
                        {thread.status === "OPEN"
                          ? t("comments.markDone")
                          : t("comments.reopen")}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result.nextBefore && (
        <div className="pagination">
          <button
            disabled={loadingOlder || loading}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? t("comments.loading") : t("comments.loadOlder")}
          </button>
        </div>
      )}
    </section>
  );
}
