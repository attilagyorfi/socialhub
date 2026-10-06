"use client";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Badge, formatDate, Network, type Post } from "./types";
import { ChevronRight, Search } from "lucide-react";
import { MediaThumb } from "./media";

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
        if (!response.ok)
          throw new Error(body.error ?? "Unable to load posts.");
        if (requestId === sequence.current) setResult(body);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (requestId === sequence.current)
          onError(
            error instanceof Error ? error.message : "Unable to load posts.",
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
        <h2>{view === "Approvals" ? "Review queue" : "All content"}</h2>
        <span className="muted">
          {loading ? "Loading…" : `${result.posts.length} on this page`}
        </span>
      </div>
      <div className="post-toolbar">
        <label className="post-search">
          <span className="sr-only">Search posts</span>
          <Search size={15} />
          <input
            aria-label="Search posts"
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPagination();
            }}
            placeholder="Search captions or links"
          />
        </label>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            resetPagination();
          }}
        >
          {statuses.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Filter posts by network"
          value={platform}
          onChange={(event) => {
            setPlatform(event.target.value);
            resetPagination();
          }}
        >
          <option value="all">All networks</option>
          {["facebook", "instagram", "linkedin", "tiktok", "google"].map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
        <select
          aria-label="Filter posts by author"
          value={authorId}
          onChange={(event) => {
            setAuthorId(event.target.value);
            resetPagination();
          }}
        >
          <option value="all">All authors</option>
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
              <th>Content</th>
              <th>Networks</th>
              <th>Status</th>
              <th>Scheduled for</th>
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
                    <span>{post.caption.slice(0, 100) || "Media post"}</span>
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
                    aria-label="Open post"
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
        <div className="empty compact">No posts match these filters.</div>
      )}
      <div className="pagination">
        <button
          disabled={!page || loading}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          Previous
        </button>
        <span>Page {page + 1}</span>
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
          Next
        </button>
      </div>
    </section>
  );
}
