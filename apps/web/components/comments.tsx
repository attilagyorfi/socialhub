"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EyeOff, Heart, RefreshCw, UserRound } from "lucide-react";
import { formatDate, Network, type ReplyTemplate } from "./types";
import { ReplyTemplatePicker } from "./reply-template-picker";
import { apiError, useT, type MessageKey } from "../i18n";
import {
  insertIntoDraft,
  renderReplyTemplate,
  REPLY_MAX_LENGTH,
} from "../../../packages/core/reply-templates";

type CommentStatus = "OPEN" | "DONE";
type Reply = {
  id: string;
  authorName: string | null;
  message: string;
  createdAt: string;
  fromPage: boolean;
  hidden: boolean;
};
type Member = { id: string; name: string };
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
  // Only for roles that may assign comments, like assignableMembers.
  assignee?: Member | null;
};
type CommentsResult = {
  threads: Thread[];
  nextBefore: string | null;
  openCount: number;
  filteredOpenCount: number;
  assignableMembers?: Member[];
  canReply: boolean;
  lastSyncedAt: string | null;
};

const statusFilters = ["OPEN", "DONE", "ALL"] as const;
const assigneeFilters = ["all", "me", "none"] as const;
const platforms = ["facebook", "instagram"] as const;
const emptyResult: CommentsResult = {
  threads: [],
  nextBefore: null,
  openCount: 0,
  filteredOpenCount: 0,
  canReply: false,
  lastSyncedAt: null,
};

function truncate(value: string, length = 60) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function Comments({
  clientId,
  timeZone,
  refreshKey,
  templates,
  onOpenPost,
  onCountChange,
}: {
  clientId: string;
  timeZone: string;
  refreshKey: number;
  templates: ReplyTemplate[];
  onOpenPost: (postId: string) => void;
  onCountChange?: (open: number) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<(typeof statusFilters)[number]>("OPEN");
  const [platform, setPlatform] = useState("all");
  const [assignee, setAssignee] =
    useState<(typeof assigneeFilters)[number]>("all");
  const [result, setResult] = useState<CommentsResult>(emptyResult);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [templateChoice, setTemplateChoice] = useState<Record<string, string>>(
    {},
  );
  const [memberChoice, setMemberChoice] = useState<Record<string, string>>({});
  const [insertError, setInsertError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const fields = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Last caret per reply field; missing until the field was used.
  const carets = useRef<Record<string, number>>({});
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
        ...(assignee !== "all" ? { assignee } : {}),
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
    [assignee, clientId, platform, status],
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
    if (!response.ok) throw new RequestError(apiError(body), body?.code);
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
      if (fields.action === "reply") {
        setDrafts((current) => ({ ...current, [id]: "" }));
        delete carets.current[id];
      }
      setNotice(t(success));
      reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("comments.error.action"),
      );
      // Someone else was faster: show the assignment as it is now.
      if (
        error instanceof RequestError &&
        error.code === "COMMENT_ASSIGNMENT_CONFLICT"
      )
        reload();
    } finally {
      setBusyId("");
    }
  }

  async function assign(thread: Thread, assigneeId: string | null) {
    await act(
      thread.id,
      {
        action: "assign",
        assigneeId,
        expectedAssigneeId: thread.assignee?.id ?? null,
      },
      assigneeId ? "comments.notice.assigned" : "comments.notice.unassigned",
    );
    setMemberChoice((current) => {
      const next = { ...current };
      delete next[thread.id];
      return next;
    });
  }

  // Changes the local draft only; sending stays with the reply button.
  function insertTemplate(thread: Thread, template: ReplyTemplate) {
    const inserted = insertIntoDraft(
      drafts[thread.id] ?? "",
      renderReplyTemplate(template.body, thread.authorName),
      carets.current[thread.id] ?? null,
    );
    setInsertError(inserted ? "" : thread.id);
    if (!inserted) return;
    flushSync(() =>
      setDrafts((current) => ({ ...current, [thread.id]: inserted.value })),
    );
    const field = fields.current[thread.id];
    field?.focus();
    field?.setSelectionRange(inserted.caret, inserted.caret);
    carets.current[thread.id] = inserted.caret;
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

  const filtered = platform !== "all" || assignee !== "all";

  return (
    <section className="panel" aria-busy={loading}>
      <div className="panel-title">
        <h2>{t("comments.title")}</h2>
        <span className="muted">
          {loading
            ? t("comments.loading")
            : filtered
              ? t("comments.filteredOpenCount", {
                  count: result.filteredOpenCount,
                })
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
        {result.assignableMembers && (
          <select
            aria-label={t("comments.filter.assignee")}
            value={assignee}
            onChange={(event) =>
              setAssignee(
                event.target.value as (typeof assigneeFilters)[number],
              )
            }
          >
            {assigneeFilters.map((value) => (
              <option key={value} value={value}>
                {t(`comments.assignee.${value}`)}
              </option>
            ))}
          </select>
        )}
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
          {filtered
            ? t("comments.empty.filtered")
            : status === "OPEN"
              ? t("comments.empty.open")
              : t("comments.empty")}
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
            const members = result.assignableMembers ?? [];
            const assigned = thread.assignee?.id ?? "";
            const member = memberChoice[thread.id] ?? assigned;
            const rememberCaret = (
              event: React.SyntheticEvent<HTMLTextAreaElement>,
            ) => {
              // The end of a selection, so inserting never replaces it.
              carets.current[thread.id] = event.currentTarget.selectionEnd;
            };
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
                    {thread.assignee && (
                      <span className="badge">
                        <UserRound size={11} aria-hidden="true" />
                        {t("comments.assign.current", {
                          name: thread.assignee.name,
                        })}
                      </span>
                    )}
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
                {thread.assignee !== undefined && (
                  <div className="comment-tool">
                    <select
                      aria-label={t("comments.assign.label", { author })}
                      value={member}
                      disabled={busy}
                      onChange={(event) =>
                        setMemberChoice((current) => ({
                          ...current,
                          [thread.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">{t("comments.assignee.none")}</option>
                      {thread.assignee &&
                        !members.some((item) => item.id === assigned) && (
                          <option value={assigned}>
                            {thread.assignee.name}
                          </option>
                        )}
                      {members.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || member === assigned}
                      aria-label={t("comments.assign.save.label", { author })}
                      onClick={() => void assign(thread, member || null)}
                    >
                      {t("comments.assign.save")}
                    </button>
                  </div>
                )}
                {result.canReply && (
                  <div className="comment-actions">
                    {!!templates.length && (
                      <ReplyTemplatePicker
                        t={t}
                        templates={templates}
                        author={author}
                        value={templateChoice[thread.id] ?? ""}
                        disabled={busy}
                        error={
                          insertError === thread.id
                            ? t("comments.template.tooLong", {
                                max: REPLY_MAX_LENGTH,
                              })
                            : ""
                        }
                        onChoose={(id) =>
                          setTemplateChoice((current) => ({
                            ...current,
                            [thread.id]: id,
                          }))
                        }
                        onInsert={(template) =>
                          insertTemplate(thread, template)
                        }
                      />
                    )}
                    <form
                      className="comment-reply-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitReply();
                      }}
                    >
                      <textarea
                        ref={(field) => {
                          fields.current[thread.id] = field;
                        }}
                        aria-label={t("comments.reply.label", { author })}
                        placeholder={t("comments.reply.placeholder")}
                        value={draft}
                        maxLength={REPLY_MAX_LENGTH}
                        rows={2}
                        disabled={busy}
                        onChange={(event) => {
                          const { value } = event.target;
                          setDrafts((current) => ({
                            ...current,
                            [thread.id]: value,
                          }));
                          rememberCaret(event);
                          setInsertError("");
                        }}
                        onSelect={rememberCaret}
                        onBlur={rememberCaret}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            (event.ctrlKey || event.metaKey)
                          ) {
                            event.preventDefault();
                            // A key still held down after inserting a
                            // template must not send the reply.
                            if (!event.repeat) submitReply();
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
