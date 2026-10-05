"use client";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Badge, type Post, Network } from "./types";

type CalendarMode = "Month" | "Week" | "List";
type CalendarResult = {
  posts: Post[];
  authors: { id: string; name: string }[];
  truncated: boolean;
};

function visibleRange(date: DateTime, mode: CalendarMode) {
  const start =
    mode === "Week"
      ? date.startOf("week")
      : date.startOf("month").startOf("week");
  const dayCount = mode === "Week" ? 7 : 42;
  return {
    start,
    end: start.plus({ days: dayCount }),
    days: Array.from({ length: dayCount }, (_, index) =>
      start.plus({ days: index }),
    ),
  };
}

export function Calendar({
  clientId,
  timeZone,
  busy,
  canReschedule,
  refreshKey,
  onOpen,
  onError,
  onReschedule,
}: {
  clientId: string;
  timeZone: string;
  busy: boolean;
  canReschedule: boolean;
  refreshKey: number;
  onOpen: (post: Post) => void;
  onError: (message: string) => void;
  onReschedule: (post: Post, scheduledAt: string) => Promise<boolean>;
}) {
  const [date, setDate] = useState(DateTime.now().setZone(timeZone));
  const [mode, setMode] = useState<CalendarMode>("Month");
  const [network, setNetwork] = useState("all");
  const [status, setStatus] = useState("all");
  const [author, setAuthor] = useState("all");
  const [result, setResult] = useState<CalendarResult>({
    posts: [],
    authors: [],
    truncated: false,
  });
  const [loading, setLoading] = useState(true);
  const [dragged, setDragged] = useState<Post>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [movingId, setMovingId] = useState<string>();
  const requestSequence = useRef(0);
  const draggedRef = useRef<Post | undefined>(undefined);
  const range = useMemo(() => visibleRange(date, mode), [date, mode]);
  const postsByDay = useMemo(() => {
    const grouped = new Map<string, Post[]>();
    for (const post of result.posts) {
      const day = DateTime.fromISO(post.scheduled_at!)
        .setZone(timeZone)
        .toISODate();
      if (!day) continue;
      const posts = grouped.get(day) ?? [];
      posts.push(post);
      grouped.set(day, posts);
    }
    return grouped;
  }, [result.posts, timeZone]);
  const from = range.start.toUTC().toISO()!;
  const to = range.end.toUTC().toISO()!;

  useEffect(() => {
    setAuthor("all");
  }, [clientId]);

  useEffect(() => {
    setDate((current) => current.setZone(timeZone));
  }, [timeZone]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const params = new URLSearchParams({ clientId, from, to });
    if (network !== "all") params.set("platform", network);
    if (status !== "all") params.set("status", status);
    if (author !== "all") params.set("authorId", author);
    setLoading(true);
    fetch(`/api/calendar?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error ?? "Unable to load calendar.");
        if (sequence === requestSequence.current) setResult(body);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (sequence === requestSequence.current)
          onError(
            error instanceof Error ? error.message : "Unable to load calendar.",
          );
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [author, clientId, from, network, onError, refreshKey, status, to]);

  const movePeriod = (direction: -1 | 1) => {
    setDate((current) =>
      current.plus(
        mode === "Week" ? { weeks: direction } : { months: direction },
      ),
    );
  };

  const startDragging = (event: DragEvent<HTMLButtonElement>, post: Post) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", post.id);
    draggedRef.current = post;
    setDragged(post);
  };

  const moveToDay = async (day: DateTime) => {
    const post = draggedRef.current;
    draggedRef.current = undefined;
    setDragged(undefined);
    setDropTarget(undefined);
    if (!post?.scheduled_at) return;
    const current = DateTime.fromISO(post.scheduled_at).setZone(timeZone);
    if (current.hasSame(day, "day")) return;
    const next = DateTime.fromObject(
      {
        year: day.year,
        month: day.month,
        day: day.day,
        hour: current.hour,
        minute: current.minute,
        second: current.second,
        millisecond: current.millisecond,
      },
      { zone: timeZone },
    );
    if (
      !next.isValid ||
      next.year !== day.year ||
      next.month !== day.month ||
      next.day !== day.day ||
      next.hour !== current.hour ||
      next.minute !== current.minute ||
      next.getPossibleOffsets().length > 1
    ) {
      onError(
        `That local time is unavailable or ambiguous in ${timeZone} during a daylight-saving change. Open the post and choose an exact time.`,
      );
      return;
    }
    setMovingId(post.id);
    try {
      await onReschedule(post, next.toUTC().toISO()!);
    } finally {
      setMovingId(undefined);
    }
  };

  return (
    <section className="panel" aria-busy={loading}>
      <div className="panel-title">
        <div className="inline">
          <button aria-label="Previous period" onClick={() => movePeriod(-1)}>
            ‹
          </button>
          <h2>{date.toFormat("MMMM yyyy")}</h2>
          <button aria-label="Next period" onClick={() => movePeriod(1)}>
            ›
          </button>
          <button onClick={() => setDate(DateTime.now().setZone(timeZone))}>
            Today
          </button>
        </div>
        <div className="segmented">
          {(["Month", "Week", "List"] as CalendarMode[]).map((value) => (
            <button
              key={value}
              className={mode === value ? "active" : ""}
              onClick={() => setMode(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-filters">
        <select
          aria-label="Filter network"
          value={network}
          onChange={(event) => setNetwork(event.target.value)}
        >
          {["all", "facebook", "instagram", "linkedin", "tiktok", "google"].map(
            (value) => (
              <option key={value} value={value}>
                {value === "all" ? "All networks" : value}
              </option>
            ),
          )}
        </select>
        <select
          aria-label="Calendar status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {[
            "all",
            "SCHEDULED",
            "PUBLISHED",
            "FAILED",
            "PARTIALLY_PUBLISHED",
          ].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter author"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
        >
          <option value="all">All authors</option>
          {result.authors.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <span className="calendar-count" role="status">
          {loading ? "Loading…" : `${result.posts.length} scheduled posts`}
        </span>
      </div>
      {mode === "List" ? (
        <div>
          {result.posts.map((post) => (
            <button
              className="upcoming-row"
              key={post.id}
              onClick={() => onOpen(post)}
            >
              <span>
                {DateTime.fromISO(post.scheduled_at!)
                  .setZone(timeZone)
                  .toFormat("dd MMM · HH:mm")}
              </span>
              <span className="row-body">{post.caption.slice(0, 90)}</span>
              <Badge status={post.status} />
            </button>
          ))}
          {!loading && !result.posts.length && (
            <div className="empty compact">
              No scheduled posts match these filters.
            </div>
          )}
        </div>
      ) : (
        <div className="calendar-scroll">
          <div className="calendar-grid">
            {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => (
              <div className="weekday" key={day}>
                {day}
              </div>
            ))}
            {range.days.map((day) => (
              <div
                key={day.toISO()}
                data-date={day.toISODate()}
                className={`calendar-day ${day.month !== date.month ? "outside" : ""} ${
                  dropTarget === day.toISODate() ? "drop-target" : ""
                }`}
                onDragEnter={(event) => {
                  if (!draggedRef.current) return;
                  event.preventDefault();
                  setDropTarget(day.toISODate()!);
                }}
                onDragOver={(event) => {
                  if (!draggedRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDragLeave={(event) => {
                  if (
                    !event.relatedTarget ||
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    setDropTarget(undefined);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void moveToDay(day);
                }}
              >
                <span
                  className={
                    day.hasSame(DateTime.now().setZone(timeZone), "day")
                      ? "today"
                      : ""
                  }
                >
                  {day.day}
                </span>
                {(postsByDay.get(day.toISODate()!) ?? []).map((post) => (
                  <button
                    className={`calendar-post ${post.status.toLowerCase()} ${
                      dragged?.id === post.id ? "dragging" : ""
                    } ${movingId === post.id ? "moving" : ""}`}
                    key={post.id}
                    draggable={
                      canReschedule && post.status === "SCHEDULED" && !busy
                    }
                    aria-describedby={
                      canReschedule && post.status === "SCHEDULED"
                        ? "calendar-drag-help"
                        : undefined
                    }
                    onDragStart={(event) => startDragging(event, post)}
                    onDragEnd={() => {
                      draggedRef.current = undefined;
                      setDragged(undefined);
                      setDropTarget(undefined);
                    }}
                    onClick={() => onOpen(post)}
                    title={
                      canReschedule && post.status === "SCHEDULED"
                        ? "Drag to another day, or open for an exact time"
                        : undefined
                    }
                  >
                    <small>
                      {DateTime.fromISO(post.scheduled_at!)
                        .setZone(timeZone)
                        .toFormat("HH:mm")}
                    </small>
                    <strong>{post.caption.slice(0, 48)}</strong>
                    <div>
                      {post.targets.map((target) => (
                        <Network platform={target.platform} key={target.id} />
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {result.truncated ? (
        <p className="panel-note">
          This range contains more than 1,000 posts. Narrow the dates or filters
          to see all results.
        </p>
      ) : (
        <p className="panel-note" id="calendar-drag-help">
          Calendar data is loaded independently for the visible date range. Open
          a scheduled post to choose an exact time
          {canReschedule
            ? ", or drag it to another day while keeping its current time"
            : ""}
          .
        </p>
      )}
    </section>
  );
}
