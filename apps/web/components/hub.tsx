"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Home,
  CalendarDays,
  PenSquare,
  Files,
  ImageIcon,
  ChartNoAxesCombined,
  CheckCheck,
  Users,
  Link2,
  Settings,
  Bell,
  Plus,
  ArrowUpRight,
  ChevronRight,
  RefreshCw,
  LogOut,
  UserRoundCog,
} from "lucide-react";
import { Composer } from "./composer";
import { PasswordSettings } from "./password-settings";
import { Calendar } from "./calendar";
import { Library, Accounts, Clients } from "./sections";
import { Analytics } from "./analytics";
import { Team } from "./team";
import { PostList } from "./post-list";
import { TimeZoneSettings } from "./timezone-settings";
import { PrivacySettings } from "./privacy-settings";
import { localDateTimeToUtc, localInputValue } from "./time";
import {
  type HubData,
  type Post,
  Badge,
  formatDate,
  Network,
  names,
} from "./types";
const navigation = [
  ["Home", Home],
  ["Calendar", CalendarDays],
  ["Create", PenSquare],
  ["Posts", Files],
  ["Media", ImageIcon],
  ["Analytics", ChartNoAxesCombined],
  ["Approvals", CheckCheck],
  ["Clients", Users],
  ["Team", UserRoundCog],
  ["Connected accounts", Link2],
  ["Settings", Settings],
] as const;
export function Hub() {
  const [data, setData] = useState<HubData>();
  const [clientId, setClientId] = useState("");
  const [view, setView] = useState("Home");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Post>();
  const [editing, setEditing] = useState<Post>();
  const [approvalUrl, setApprovalUrl] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [calendarRefresh, setCalendarRefresh] = useState(0);
  const loadSequence = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("meta");
    if (!result) return;
    setView("Connected accounts");
    if (result === "connected") setNotice("Meta accounts connected.");
    else
      setError(
        `Meta connection failed (${params.get("code") ?? "OAUTH_FAILED"}).`,
      );
    window.history.replaceState({}, "", window.location.pathname);
  }, []);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const elements = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]",
        ) ?? [],
      ).filter((el) => el.getClientRects().length);
    elements()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelected(undefined);
      }
      if (event.key === "Tab") {
        const items = elements();
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    dialog?.addEventListener("keydown", trap);
    return () => {
      dialog?.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [selected?.id]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const res = await fetch(
      `/api/hub?${new URLSearchParams(clientId ? { clientId } : {})}`,
    );
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const result = await res.json();
    if (sequence !== loadSequence.current) return;
    if (!res.ok) throw new Error(result.error);
    setData(result);
  }, [clientId]);
  useEffect(() => {
    let active = true;
    load().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [load]);
  async function mutate(action: string, fields: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/hub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, clientId: data?.clientId, ...fields }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      await load();
      if (selected?.id && data?.clientId) {
        const detailResponse = await fetch(
          `/api/posts?${new URLSearchParams({
            clientId: data.clientId,
            id: selected.id,
          })}`,
        );
        if (detailResponse.ok) setSelected((await detailResponse.json()).post);
      }
      setCalendarRefresh((value) => value + 1);
      setNotice("Changes saved.");
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save changes.");
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function reschedule(
    post: Post,
    scheduledAt: string,
    updateDialog = true,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: data?.clientId,
          id: post.id,
          scheduledAt,
          expectedRevision: post.revision,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (updateDialog)
        setSelected({
          ...post,
          scheduled_at: result.scheduledAt,
          revision: result.revision,
        });
      setCalendarRefresh((value) => value + 1);
      await load();
      setNotice("Post rescheduled.");
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to reschedule post.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  function openPost(p: Post) {
    setSelected(p);
    setApprovalUrl("");
    setReviewerId(
      p.approval_assigned_to ??
        data?.reviewers.find((reviewer) => reviewer.id === data.user.id)?.id ??
        data?.reviewers[0]?.id ??
        "",
    );
  }
  async function openPostById(id: string) {
    if (!data?.clientId) return;
    try {
      const response = await fetch(
        `/api/posts?${new URLSearchParams({ clientId: data.clientId, id })}`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load post.");
      openPost(body.post);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load post.",
      );
    }
  }
  const currentPost =
    data?.posts.find((p) => p.id === selected?.id) ?? selected;
  const timeZone = data?.user.timezone ?? "Europe/Budapest";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/">
          g2a<span> / social hub</span>
        </a>
        <div className="agency">
          <div className="agency-icon">G</div>
          <div>
            <strong>G2A Marketing</strong>
            <small>Agency workspace</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {navigation
            .filter(([label]) => label !== "Team" || data?.canManageTeam)
            .map(([label, Icon]) => (
              <button
                key={label}
                className={view === label ? "active" : ""}
                onClick={() => {
                  if (label === "Create") setEditing(undefined);
                  setView(label);
                  setFilter("ALL");
                }}
              >
                <Icon size={18} />
                {label}
                {label === "Approvals" &&
                  !!data?.posts.filter((p) => p.status === "PENDING_APPROVAL")
                    .length && (
                    <span className="nav-count">
                      {
                        data.posts.filter(
                          (p) => p.status === "PENDING_APPROVAL",
                        ).length
                      }
                    </span>
                  )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mode">
            <span className="dot" />
            {data?.meta.enabled
              ? "Meta integration enabled"
              : data?.mode === "mock"
                ? "Mock social connections"
                : "Social workspace"}
            <small>
              {data?.meta.enabled
                ? "Live accounts require approved Meta access"
                : data?.mode === "mock"
                  ? "No real posts will be published"
                  : "Check provider status before publishing"}
            </small>
          </div>
          <button
            className="profile"
            onClick={async () => {
              await fetch("/api/auth/sign-out", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              window.location.href = "/login";
            }}
          >
            <span className="avatar">
              {data?.user.name.slice(0, 2).toUpperCase() ?? "G2"}
            </span>
            <span>
              {data?.user.name ?? "Your workspace"}
              <small>Sign out</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} /> <strong>{view}</strong>
          </div>
          <div className="topbar-actions">
            <label className="client-select">
              <span className="sr-only">Active client</span>
              <select
                disabled={busy}
                value={data?.clientId ?? ""}
                onChange={(e) => {
                  loadSequence.current++;
                  setData(undefined);
                  setClientId(e.target.value);
                  setSelected(undefined);
                  setEditing(undefined);
                }}
              >
                {data?.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              title="Refresh workspace"
              onClick={() => {
                setCalendarRefresh((value) => value + 1);
                load().catch((e) => setError(e.message));
              }}
            >
              <RefreshCw size={18} />
            </button>
            <button
              className="icon-button"
              title="Notifications"
              onClick={() => setView("Notifications")}
            >
              <Bell size={19} />
            </button>
            <span className="avatar small">
              {data?.user.name.slice(0, 2).toUpperCase() ?? "G2"}
            </span>
          </div>
        </header>
        <main className="content">
          {error && (
            <div role="alert" className="alert">
              {error}
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  load().catch((e) => setError(e.message));
                }}
              >
                Try again
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="success-notice">
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                Dismiss
              </button>
            </div>
          )}
          {!data ? (
            <div className="empty">
              <RefreshCw />
              <h2>Loading your workspace</h2>
              <p>Connecting to the application services.</p>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {view === "Home"
                      ? "YOUR WORKSPACE AT A GLANCE"
                      : (data.clients.find((c) => c.id === data.clientId)
                          ?.name ?? "G2A MARKETING")}
                  </p>
                  <h1>
                    {view === "Home"
                      ? `Let’s make good things happen${data.user.name ? ", " + data.user.name.split(" ")[0] : ""}.`
                      : view}
                  </h1>
                  <p className="muted">
                    {view === "Home"
                      ? "A clear view of what’s next, and what needs your attention."
                      : view === "Create"
                        ? "One idea. Every network. Your brand’s voice."
                        : view === "Calendar"
                          ? `Plan your content with confidence. Times shown in ${timeZone}.`
                          : view === "Approvals"
                            ? "Keep feedback and decisions moving."
                            : view === "Analytics"
                              ? "Mock metrics are labeled and kept separate by network."
                              : view === "Team"
                                ? "Invite people and give them only the client access they need."
                                : ""}
                  </p>
                </div>
                {view !== "Create" && (
                  <button
                    className="primary"
                    onClick={() => {
                      setEditing(undefined);
                      setView("Create");
                    }}
                    disabled={!data.clientId}
                  >
                    <Plus size={17} /> Create post
                  </button>
                )}
              </div>
              {!data.clients.length && view !== "Clients" ? (
                <div className="empty">
                  <Users />
                  <h2>Create your first client workspace</h2>
                  <p>
                    Each client gets separate accounts, media, brand knowledge
                    and content.
                  </p>
                  <button
                    className="primary"
                    onClick={() => setView("Clients")}
                  >
                    Add a client
                  </button>
                </div>
              ) : (
                <>
                  {view === "Home" && (
                    <>
                      {data.operations?.needsAttention && (
                        <div role="status" className="notice">
                          <strong>Operations needs attention.</strong>{" "}
                          {data.operations.publishDead +
                            data.operations.mediaDead +
                            data.operations.approvalDeliveriesFailed +
                            data.operations.analyticsDead}{" "}
                          failed jobs or deliveries,{" "}
                          {data.operations.unhealthyTokens} account tokens
                          requiring review.
                          <button
                            className="text-button"
                            onClick={() => setView("Settings")}
                          >
                            View operations
                          </button>
                        </div>
                      )}
                      <div className="stats">
                        {[
                          ["Scheduled", "SCHEDULED", "Calendar"],
                          [
                            "Awaiting approval",
                            "PENDING_APPROVAL",
                            "Approvals",
                          ],
                          ["Published", "PUBLISHED", "Posts"],
                          ["Needs attention", "FAILED", "Posts"],
                        ].map(([label, status, target]) => (
                          <button
                            className="stat"
                            key={status}
                            onClick={() => {
                              setView(target);
                              setFilter(status);
                            }}
                          >
                            <span>
                              {label}
                              <ArrowUpRight size={15} />
                            </span>
                            <strong>
                              {
                                data.posts.filter(
                                  (p) =>
                                    p.status === status ||
                                    (status === "FAILED" &&
                                      p.status === "PARTIALLY_PUBLISHED"),
                                ).length
                              }
                            </strong>
                            <small>In the current 50-post page</small>
                          </button>
                        ))}
                      </div>
                      <div className="dashboard-grid">
                        <section className="panel">
                          <div className="panel-title">
                            <h2>Coming up next</h2>
                            <button
                              className="text-button"
                              onClick={() => setView("Calendar")}
                            >
                              View calendar <ArrowUpRight size={15} />
                            </button>
                          </div>
                          <div className="list-tabs">
                            <span className="active">Scheduled content</span>
                            <span>{timeZone}</span>
                          </div>
                          {data.posts
                            .filter((p) => p.status === "SCHEDULED")
                            .slice(0, 5)
                            .map((p) => (
                              <button
                                className="upcoming-row"
                                key={p.id}
                                onClick={() => openPost(p)}
                              >
                                <div className="date-tile">
                                  <strong>
                                    {new Date(
                                      p.scheduled_at!,
                                    ).toLocaleDateString("en-GB", {
                                      timeZone,
                                      day: "2-digit",
                                    })}
                                  </strong>
                                  <span>
                                    {new Date(
                                      p.scheduled_at!,
                                    ).toLocaleDateString("en-GB", {
                                      timeZone,
                                      month: "short",
                                    })}
                                  </span>
                                </div>
                                <div className="row-body">
                                  <strong>
                                    {p.caption.slice(0, 75) || "Media post"}
                                  </strong>
                                  <small>
                                    {formatDate(p.scheduled_at, timeZone)}
                                  </small>
                                </div>
                                <div className="network-stack">
                                  {p.targets.map((t) => (
                                    <Network key={t.id} platform={t.platform} />
                                  ))}
                                </div>
                                <ChevronRight size={16} />
                              </button>
                            ))}
                          {!data.posts.some(
                            (p) => p.status === "SCHEDULED",
                          ) && (
                            <div className="empty compact">
                              Your approved and scheduled posts will appear
                              here.
                            </div>
                          )}
                          <button
                            className="panel-footer"
                            onClick={() => setView("Create")}
                          >
                            <Plus size={16} /> Plan your next post
                          </button>
                        </section>
                        <section className="panel">
                          <div className="panel-title">
                            <h2>Needs your attention</h2>
                            <span className="attention-dot" />
                          </div>
                          {data.posts
                            .filter((p) =>
                              [
                                "PENDING_APPROVAL",
                                "FAILED",
                                "PARTIALLY_PUBLISHED",
                              ].includes(p.status),
                            )
                            .slice(0, 4)
                            .map((p) => (
                              <button
                                key={p.id}
                                className="attention-row"
                                onClick={() => openPost(p)}
                              >
                                <span
                                  className={`attention-icon ${p.status === "PENDING_APPROVAL" ? "yellow" : "red"}`}
                                >
                                  {p.status === "PENDING_APPROVAL" ? (
                                    <CheckCheck size={19} />
                                  ) : (
                                    <Bell size={19} />
                                  )}
                                </span>
                                <div>
                                  <strong>
                                    {p.status === "PENDING_APPROVAL"
                                      ? "Ready for review"
                                      : "Publishing needs a look"}
                                  </strong>
                                  <p>{p.caption.slice(0, 60)}</p>
                                  <Badge status={p.status} />
                                </div>
                                <ChevronRight size={15} />
                              </button>
                            ))}
                          {!data.posts.some((p) =>
                            [
                              "PENDING_APPROVAL",
                              "FAILED",
                              "PARTIALLY_PUBLISHED",
                            ].includes(p.status),
                          ) && (
                            <div className="empty compact">
                              You’re all caught up.
                            </div>
                          )}
                        </section>
                      </div>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>Your connected accounts</h2>
                          <button
                            className="text-button"
                            onClick={() => setView("Connected accounts")}
                          >
                            Manage accounts <ArrowUpRight size={15} />
                          </button>
                        </div>
                        <div className="account-strip">
                          {data.accounts.map((a) => (
                            <div key={a.id}>
                              <Network platform={a.platform} />
                              <span>
                                <strong>{a.name}</strong>
                                <small>
                                  <span className="dot" />
                                  {a.status.toLowerCase()}
                                </small>
                              </span>
                            </div>
                          ))}
                          {!data.accounts.length && (
                            <p className="muted">
                              Connect a mock account to start creating.
                            </p>
                          )}
                        </div>
                      </section>
                    </>
                  )}
                  {view === "Create" && (
                    <Composer
                      key={`${data.clientId}-${editing?.id ?? "new"}`}
                      editing={editing}
                      data={data}
                      mutate={mutate}
                      busy={busy}
                      onCreated={(p) => {
                        setEditing(undefined);
                        setView("Posts");
                        openPost(p);
                      }}
                    />
                  )}
                  {view === "Calendar" && (
                    <Calendar
                      clientId={data.clientId!}
                      timeZone={timeZone}
                      busy={busy}
                      canReschedule={[
                        "OWNER",
                        "ADMIN",
                        "SOCIAL_MANAGER",
                      ].includes(data.role)}
                      refreshKey={calendarRefresh}
                      onOpen={openPost}
                      onError={setError}
                      onReschedule={(post, scheduledAt) =>
                        reschedule(post, scheduledAt, false)
                      }
                    />
                  )}
                  {(view === "Posts" || view === "Approvals") && (
                    <PostList
                      key={`${data.clientId}-${view}-${filter}`}
                      clientId={data.clientId!}
                      timeZone={timeZone}
                      view={view}
                      initialStatus={filter}
                      refreshKey={calendarRefresh}
                      onOpen={openPost}
                      onError={setError}
                    />
                  )}
                  {view === "Media" && (
                    <Library
                      data={data}
                      mutate={mutate}
                      reload={load}
                      onError={setError}
                    />
                  )}
                  {view === "Connected accounts" && (
                    <Accounts data={data} mutate={mutate} busy={busy} />
                  )}
                  {view === "Clients" && (
                    <Clients
                      key={data.clientId}
                      data={data}
                      mutate={mutate}
                      busy={busy}
                    />
                  )}
                  {view === "Analytics" && (
                    <Analytics
                      clientId={data.clientId!}
                      refreshKey={calendarRefresh}
                      onOpen={(id) => void openPostById(id)}
                      onError={setError}
                    />
                  )}
                  {view === "Team" && data.canManageTeam && (
                    <Team data={data} mutate={mutate} busy={busy} />
                  )}
                  {view === "Notifications" && (
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Latest notifications</h2>
                      </div>
                      {data.notifications.map((n) => (
                        <div className="activity-row" key={n.id}>
                          <Bell size={16} />
                          <span>{n.message}</span>
                          <small>{formatDate(n.created_at, timeZone)}</small>
                        </div>
                      ))}
                      {!data.notifications.length && (
                        <div className="empty compact">
                          No notifications yet.
                        </div>
                      )}
                    </section>
                  )}
                  {view === "Settings" && (
                    <>
                      <PasswordSettings />
                      <TimeZoneSettings
                        key={data.user.timezone}
                        data={data}
                        mutate={mutate}
                        busy={busy}
                      />
                      <PrivacySettings
                        key={`${data.privacy.organization?.retentionDays ?? 0}-${data.privacy.userRequest?.id ?? "none"}-${data.privacy.organization?.request?.id ?? "none"}`}
                        data={data}
                        mutate={mutate}
                        busy={busy}
                      />
                      {data.operations && (
                        <section className="panel">
                          <div className="panel-title">
                            <h2>Operations</h2>
                            <Badge
                              status={
                                data.operations.needsAttention
                                  ? "ATTENTION"
                                  : "HEALTHY"
                              }
                            />
                          </div>
                          <div className="settings-grid operations-grid">
                            <div>
                              <small>Worker</small>
                              <strong>
                                {data.operations.worker.healthy
                                  ? "Healthy"
                                  : "Offline or stale"}
                              </strong>
                              <small>
                                {data.operations.worker.lastSeenAt
                                  ? formatDate(
                                      data.operations.worker.lastSeenAt,
                                      timeZone,
                                    )
                                  : "No heartbeat"}
                              </small>
                            </div>
                            <div>
                              <small>Publish queue</small>
                              <strong>
                                {data.operations.publishWaiting} waiting ·{" "}
                                {data.operations.publishDead} dead
                              </strong>
                              <small>
                                {data.operations.publishUncertain} uncertain
                                deliveries
                              </small>
                              <small>
                                {data.operations.publishReconciliationWaiting}{" "}
                                reconciling ·{" "}
                                {
                                  data.operations
                                    .publishReconciliationUnresolved
                                }{" "}
                                unresolved
                              </small>
                              <small>
                                Last confirmed: {" "}
                                {data.operations
                                  .publishReconciliationLastSuccessAt
                                  ? formatDate(
                                      data.operations
                                        .publishReconciliationLastSuccessAt,
                                      timeZone,
                                    )
                                  : "No reconciled delivery"}
                              </small>
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() =>
                                  mutate("publishing.reconcile").catch(
                                    () => {},
                                  )
                                }
                              >
                                Recheck uncertain deliveries
                              </button>
                            </div>
                            <div>
                              <small>Media queue</small>
                              <strong>
                                {data.operations.mediaWaiting} active ·{" "}
                                {data.operations.mediaDead} dead
                              </strong>
                              <small>
                                Oldest due job:{" "}
                                {data.operations.oldestDueSeconds}s
                              </small>
                            </div>
                            <div>
                              <small>Approval email outbox</small>
                              <strong>
                                {data.operations.approvalDeliveriesWaiting}{" "}
                                waiting ·{" "}
                                {data.operations.approvalDeliveriesFailed}{" "}
                                failed
                              </strong>
                              <small>Automatic reminders and escalations</small>
                            </div>
                            <div>
                              <small>Social credentials</small>
                              <strong>
                                {data.operations.connectedAccounts} connected
                              </strong>
                              <small>
                                {data.operations.unhealthyTokens} require review
                              </small>
                            </div>
                            <div>
                              <small>Analytics reconciliation</small>
                              <strong>
                                {data.operations.analyticsWaiting} active ·{" "}
                                {data.operations.analyticsDead} dead
                              </strong>
                              <small>
                                Last success:{" "}
                                {data.operations.analyticsLastSuccessAt
                                  ? formatDate(
                                      data.operations.analyticsLastSuccessAt,
                                      timeZone,
                                    )
                                  : "No completed sync"}
                              </small>
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() =>
                                  mutate("analytics.backfill", {
                                    days: 30,
                                  }).catch(() => {})
                                }
                              >
                                Queue 30-day backfill
                              </button>
                            </div>
                          </div>
                          <p className="panel-note">
                            Liveness: <code>/api/health/live</code> · Readiness:{" "}
                            <code>/api/health/ready</code>
                          </p>
                        </section>
                      )}
                      <section className="panel">
                        <div className="panel-title">
                          <h2>Workspace settings</h2>
                        </div>
                        <div className="settings-grid">
                          <div>
                            <small>Current role</small>
                            <strong>{data.role}</strong>
                          </div>
                          <div>
                            <small>Social provider</small>
                            <strong>{data.mode}</strong>
                          </div>
                        </div>
                        <p className="panel-note">
                          <a href="/legal/privacy">Privacy</a> ·{" "}
                          <a href="/legal/terms">Terms</a> ·{" "}
                          <a href="/legal/deletion">
                            Data deletion instructions
                          </a>
                        </p>
                      </section>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>Audit log</h2>
                          <span className="muted">Latest 50 events</span>
                        </div>
                        {data.audit.map((a, i) => (
                          <div className="activity-row" key={i}>
                            <span className="dot" />
                            <span>{a.action.replaceAll(".", " · ")}</span>
                            <code>{a.resource_id?.slice(0, 8)}</code>
                            <small>{formatDate(a.created_at, timeZone)}</small>
                          </div>
                        ))}
                      </section>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
      {currentPost && (
        <div className="modal-backdrop" onClick={() => setSelected(undefined)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="post-title"
            className="post-dialog"
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title">
              <h2 id="post-title">Post details</h2>
              <button
                onClick={() => setSelected(undefined)}
                aria-label="Close post"
              >
                Close
              </button>
            </div>
            <div className="dialog-body">
              <Badge status={currentPost.status} />
              <p className="caption-full">{currentPost.caption}</p>
              <p className="muted">
                {formatDate(currentPost.scheduled_at, timeZone)}
              </p>
              {currentPost.targets.map((t) => (
                <div className="target-detail" key={t.id}>
                  <div>
                    <Network platform={t.platform} />
                    <strong>{names[t.platform]}</strong>
                    <Badge status={t.status} />
                  </div>
                  <p>{t.caption}</p>
                  {t.errorCode && <p className="alert">{t.errorCode}</p>}
                </div>
              ))}
              {approvalUrl && (
                <div className="notice">
                  <strong>External approval link · expires in 7 days</strong>
                  <a href={approvalUrl} target="_blank" rel="noreferrer">
                    Open client review
                  </a>
                  <input
                    aria-label="Approval link"
                    value={approvalUrl}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                </div>
              )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_escalated_at && (
                  <div className="notice warning">
                    <strong>Approval escalated</strong>
                    <p>
                      Organization administrators were notified on{" "}
                      {formatDate(currentPost.approval_escalated_at, timeZone)}.
                    </p>
                  </div>
                )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_kind === "EXTERNAL" &&
                currentPost.approval_status === "PENDING" &&
                [
                  "OWNER",
                  "ADMIN",
                  "SOCIAL_MANAGER",
                  "CONTENT_CREATOR",
                ].includes(data?.role ?? "") && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      mutate("post.approval-link", { id: currentPost.id })
                        .then((r) => setApprovalUrl(r.url))
                        .catch(() => {})
                    }
                  >
                    Generate new review link
                  </button>
                )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_kind === "INTERNAL" &&
                currentPost.approval_status === "PENDING" && (
                  <div className="notice">
                    <strong>
                      Internal review ·{" "}
                      {currentPost.approval_reviewer_name ?? "Unassigned"}
                    </strong>
                    <p>
                      Due{" "}
                      {currentPost.approval_expires_at
                        ? formatDate(currentPost.approval_expires_at, timeZone)
                        : "within seven days"}
                      . Reminders sent:{" "}
                      {currentPost.approval_reminder_count ?? 0}, including{" "}
                      {currentPost.approval_automatic_reminder_count ?? 0}{" "}
                      automatic.
                    </p>
                    {currentPost.approval_next_reminder_at && (
                      <p>
                        Next automatic reminder:{" "}
                        {formatDate(
                          currentPost.approval_next_reminder_at,
                          timeZone,
                        )}
                        .
                      </p>
                    )}
                    {["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(
                      data?.role ?? "",
                    ) && (
                      <div className="review-assignment">
                        <label>
                          Assigned reviewer
                          <select
                            aria-label="Assigned reviewer"
                            value={reviewerId}
                            onChange={(event) =>
                              setReviewerId(event.target.value)
                            }
                          >
                            {data?.reviewers.map((reviewer) => (
                              <option key={reviewer.id} value={reviewer.id}>
                                {reviewer.name} ·{" "}
                                {reviewer.role
                                  .toLowerCase()
                                  .replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="button-row">
                          <button
                            disabled={
                              busy ||
                              !reviewerId ||
                              reviewerId === currentPost.approval_assigned_to
                            }
                            onClick={() =>
                              mutate("post.review.assign", {
                                id: currentPost.id,
                                reviewerId,
                              }).catch(() => {})
                            }
                          >
                            Assign reviewer
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              mutate("post.review.remind", {
                                id: currentPost.id,
                              }).catch(() => {})
                            }
                          >
                            Send reminder
                          </button>
                        </div>
                      </div>
                    )}
                    {currentPost.approval_assigned_to === data?.user.id ? (
                      <>
                        <label>
                          Review feedback
                          <textarea
                            value={reviewComment}
                            onChange={(e) => setReviewComment(e.target.value)}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            disabled={busy}
                            className="primary"
                            onClick={() =>
                              mutate("post.review", {
                                id: currentPost.id,
                                decision: "approve",
                                comment: reviewComment,
                              })
                                .then((r) => {
                                  setApprovalUrl(r.url ?? "");
                                  setReviewComment("");
                                })
                                .catch(() => {})
                            }
                          >
                            Approve internally
                          </button>
                          <button
                            disabled={busy || !reviewComment.trim()}
                            onClick={() =>
                              mutate("post.review", {
                                id: currentPost.id,
                                decision: "changes",
                                comment: reviewComment,
                              }).catch(() => {})
                            }
                          >
                            Request changes
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>
                        Waiting for{" "}
                        {currentPost.approval_reviewer_name ??
                          "the assigned reviewer"}
                        .
                      </p>
                    )}
                  </div>
                )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_status === "EXPIRED" && (
                  <div className="notice warning">
                    <strong>Review expired</strong>
                    <p>
                      Renew this {currentPost.approval_kind?.toLowerCase()}{" "}
                      review for another seven days.
                    </p>
                    {currentPost.approval_kind === "INTERNAL" && (
                      <label>
                        Assigned reviewer
                        <select
                          aria-label="Renewal reviewer"
                          value={reviewerId}
                          onChange={(event) =>
                            setReviewerId(event.target.value)
                          }
                        >
                          {data?.reviewers.map((reviewer) => (
                            <option key={reviewer.id} value={reviewer.id}>
                              {reviewer.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        ![
                          "OWNER",
                          "ADMIN",
                          "SOCIAL_MANAGER",
                          "CONTENT_CREATOR",
                        ].includes(data?.role ?? "") ||
                        (currentPost.approval_kind === "INTERNAL" &&
                          !reviewerId)
                      }
                      onClick={() =>
                        mutate("post.review.renew", {
                          id: currentPost.id,
                          ...(currentPost.approval_kind === "INTERNAL"
                            ? { reviewerId }
                            : {}),
                        })
                          .then((result) => setApprovalUrl(result.url ?? ""))
                          .catch(() => {})
                      }
                    >
                      Renew review
                    </button>
                  </div>
                )}
              {!!currentPost.approval_history?.length && (
                <div className="approval-history">
                  <h3>Approval history</h3>
                  {currentPost.approval_history.map((review) => (
                    <div className="approval-history-row" key={review.id}>
                      <Badge status={review.status} />
                      <span>
                        {review.kind.toLowerCase()} review
                        {review.reviewerName ? ` · ${review.reviewerName}` : ""}
                        {review.automaticReminderCount
                          ? ` · ${review.automaticReminderCount} automatic reminder${review.automaticReminderCount === 1 ? "" : "s"}`
                          : ""}
                        {review.escalatedAt ? " · escalated" : ""}
                      </span>
                      <small>{formatDate(review.createdAt, timeZone)}</small>
                    </div>
                  ))}
                </div>
              )}
              {currentPost.status === "DRAFT" && (
                <button
                  onClick={() => {
                    setEditing(currentPost);
                    setSelected(undefined);
                    setView("Create");
                  }}
                >
                  Edit draft
                </button>
              )}
              {[
                "DRAFT",
                "PENDING_APPROVAL",
                "APPROVED",
                "SCHEDULED",
                "QUEUED",
                "FAILED",
              ].includes(currentPost.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    mutate("post.cancel", { id: currentPost.id })
                      .then(() => setSelected(undefined))
                      .catch(() => {})
                  }
                >
                  Cancel post
                </button>
              )}
              {currentPost.status === "DRAFT" && (
                <>
                  {data?.workflow[0] === "INTERNAL" && (
                    <label>
                      Internal reviewer
                      <select
                        aria-label="Internal reviewer"
                        value={reviewerId}
                        onChange={(event) => setReviewerId(event.target.value)}
                      >
                        <option value="">Choose a reviewer</option>
                        {data.reviewers.map((reviewer) => (
                          <option key={reviewer.id} value={reviewer.id}>
                            {reviewer.name} ·{" "}
                            {reviewer.role.toLowerCase().replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="primary"
                    disabled={
                      busy || (data?.workflow[0] === "INTERNAL" && !reviewerId)
                    }
                    onClick={() =>
                      mutate("post.submit", {
                        id: currentPost.id,
                        ...(data?.workflow[0] === "INTERNAL"
                          ? { reviewerId }
                          : {}),
                      })
                        .then((r) => setApprovalUrl(r.url ?? ""))
                        .catch(() => {})
                    }
                  >
                    Send for approval
                  </button>
                </>
              )}
              {currentPost.status === "APPROVED" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const date = String(
                      new FormData(e.currentTarget).get("schedule"),
                    );
                    const parsed = localDateTimeToUtc(date, timeZone);
                    if (parsed.error) {
                      setError(parsed.error);
                      return;
                    }
                    mutate("post.schedule", {
                      id: currentPost.id,
                      scheduledAt: parsed.iso,
                    }).catch(() => {});
                  }}
                >
                  <label>
                    Schedule · {timeZone}
                    <input name="schedule" type="datetime-local" required />
                  </label>
                  <div className="button-row">
                    <button className="primary" disabled={busy}>
                      Schedule post
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        mutate("post.schedule", {
                          id: currentPost.id,
                          scheduledAt: new Date(
                            Date.now() + 1000,
                          ).toISOString(),
                        }).catch(() => {})
                      }
                    >
                      Publish now
                    </button>
                  </div>
                </form>
              )}
              {currentPost.status === "SCHEDULED" &&
                ["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(
                  data?.role ?? "",
                ) && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = String(
                        new FormData(event.currentTarget).get("reschedule"),
                      );
                      const parsed = localDateTimeToUtc(value, timeZone);
                      if (parsed.error) {
                        setError(parsed.error);
                        return;
                      }
                      void reschedule(currentPost, parsed.iso!);
                    }}
                  >
                    <label>
                      Move to · {timeZone}
                      <input
                        name="reschedule"
                        type="datetime-local"
                        required
                        defaultValue={localInputValue(
                          currentPost.scheduled_at!,
                          timeZone,
                        )}
                      />
                    </label>
                    <button className="primary" disabled={busy}>
                      Reschedule post
                    </button>
                  </form>
                )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
