"use client";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Badge, formatDate, Network, type Post } from "./types";
import { ChevronRight, Search } from "lucide-react";
import { MediaThumb } from "./media";
import { apiError, useT, type MessageKey } from "../i18n";

type PostListResult = {
  posts: Post[];
  authors: { id: string; name: string }[];
  nextCursor: string | null;
};

export function PostList({
  clientId,
  timeZone,
  view,
  initialStatus,
  refreshKey,
  onOpen,
  onError,
}: {
  clientId: string;
  timeZone: string;
  view: "Posts" | "Approvals";
  initialStatus: string;
  refreshKey: number;
  onOpen: (post: Post) => void;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [status, setStatus] = useState(initialStatus);
  const [platform, setPlatform] = useState("all");
  const [authorId, setAuthorId] = useState("all");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<PostListResult>({
    posts: [],
    authors: [],
    nextCursor: null,
  });
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const cursor = cursors[page];
  const resetPagination = () => {
    setCursors([undefined]);
    setPage(0);
  };

  useEffect(() => {
    const requestId = ++sequence.current;
    const controller = new AbortController();
    const params = new URLSearchParams({
      clientId,
      limit: "25",
      ...(view === "Approvals" ? { approvalOnly: "true" } : {}),
      ...(deferredQuery ? { query: deferredQuery } : {}),
      ...(status !== "ALL" ? { status } : {}),
      ...(platform !== "all" ? { platform } : {}),
      ...(authorId !== "all" ? { authorId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    setLoading(true);
    fetch(`/api/posts?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(apiError(body));
        if (requestId === sequence.current) setResult(body);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (requestId === sequence.current)
          onError(
            error instanceof Error ? error.message : t("posts.error.load"),
          );
      })
      .finally(() => {
        if (requestId === sequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [
    authorId,
    clientId,
    cursor,
    deferredQuery,
    onError,
    platform,
    refreshKey,
    status,
    t,
    view,
  ]);

  const statuses =
    view === "Approvals"
      ? ["ALL", "PENDING_APPROVAL", "APPROVED"]
      : [
          "ALL",
          "DRAFT",
          "PENDING_APPROVAL",
          "APPROVED",
          "SCHEDULED",
          "PUBLISHED",
          "PARTIALLY_PUBLISHED",
          "FAILED",
          "CANCELLED",
        ];

  return (
    <section className="panel" aria-busy={loading}>
      <div className="panel-title">
        <h2>
          {view === "Approvals"
            ? t("posts.title.approvals")
            : t("posts.title.all")}
        </h2>
        <span className="muted">
          {loading
            ? t("posts.loading")
            : t("posts.pageCount", { count: result.posts.length })}
        </span>
      </div>
      <div className="post-toolbar">
        <label className="post-search">
          <span className="sr-only">{t("posts.search.label")}</span>
          <Search size={15} />
          <input
            aria-label={t("posts.search.label")}
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPagination();
            }}
            placeholder={t("posts.search.placeholder")}
          />
        </label>
        <select
          aria-label={t("posts.filter.status")}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            resetPagination();
          }}
        >
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value === "ALL"
                ? t("posts.filter.allStatuses")
                : t(`common.status.${value}` as MessageKey)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("posts.filter.network")}
          value={platform}
          onChange={(event) => {
            setPlatform(event.target.value);
            resetPagination();
          }}
        >
          <option value="all">{t("posts.filter.allNetworks")}</option>
          {["facebook", "instagram", "linkedin", "tiktok", "google"].map(
            (value) => (
              <option key={value} value={value}>
                {t(`common.network.${value}` as MessageKey)}
              </option>
            ),
          )}
        </select>
        <select
          aria-label={t("posts.filter.author")}
          value={authorId}
          onChange={(event) => {
            setAuthorId(event.target.value);
            resetPagination();
          }}
        >
          <option value="all">{t("posts.filter.allAuthors")}</option>
          {result.authors.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name}
            </option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("posts.column.content")}</th>
              <th>{t("posts.column.networks")}</th>
              <th>{t("posts.column.status")}</th>
              <th>{t("posts.column.scheduledFor")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {result.posts.map((post) => (
              <tr key={post.id}>
                <td>
                  <button
                    className="table-caption"
                    onClick={() => onOpen(post)}
                  >
                    {post.targets[0]?.mediaIds[0] && (
                      <MediaThumb
                        clientId={clientId}
                        asset={{
                          id: post.targets[0].mediaIds[0],
                          name: "",
                          mime_type: "image/",
                        }}
                      />
                    )}
                    <span>
                      {post.caption.slice(0, 100) || t("posts.mediaPost")}
                    </span>
                  </button>
                </td>
                <td>
                  <div className="network-stack">
                    {post.targets.map((target) => (
                      <Network platform={target.platform} key={target.id} />
                    ))}
                  </div>
                </td>
                <td>
                  <Badge status={post.status} />
                </td>
                <td>{formatDate(post.scheduled_at, timeZone)}</td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={t("posts.open")}
                    onClick={() => onOpen(post)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !result.posts.length && (
        <div className="empty compact">{t("posts.empty")}</div>
      )}
      <div className="pagination">
        <button
          disabled={!page || loading}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          {t("posts.pagination.previous")}
        </button>
        <span>{t("posts.pagination.page", { page: page + 1 })}</span>
        <button
          disabled={!result.nextCursor || loading}
          onClick={() => {
            if (!result.nextCursor) return;
            setCursors((current) => [
              ...current.slice(0, page + 1),
              result.nextCursor!,
            ]);
            setPage((current) => current + 1);
          }}
        >
          {t("posts.pagination.next")}
        </button>
      </div>
    </section>
  );
}
