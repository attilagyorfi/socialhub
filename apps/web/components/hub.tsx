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
import { MediaThumb } from "./media";
import { Composer } from "./composer";
import { PasswordSettings } from "./password-settings";
import { Calendar } from "./calendar";
import { Library, Accounts, Clients } from "./sections";
import { Analytics } from "./analytics";
import { Team } from "./team";
import { PostList } from "./post-list";
import { TimeZoneSettings } from "./timezone-settings";
import { PrivacySettings } from "./privacy-settings";
import { LanguageSettings } from "./language-settings";
import {
  apiError,
  errorMessage,
  intlLocale,
  useT,
  type MessageKey,
} from "../i18n";
import { localDateTimeToUtc, localInputValue } from "./time";
import { type HubData, type Post, Badge, formatDate, Network } from "./types";
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
// Post states in which per-network delivery status means something.
const deliveryStates = [
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
  "PARTIALLY_PUBLISHED",
  "FAILED",
];
export function Hub() {
  const { t, locale, setLocale } = useT();
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
    const code = params.get("code") ?? "OAUTH_FAILED";
    if (result === "connected") setNotice(t("hub.meta.connected"));
    else
      setError(
        t("hub.meta.failed", { reason: errorMessage(locale, code, code) }),
      );
    window.history.replaceState({}, "", window.location.pathname);
  }, []);
  // A saved per-user language wins over the browser cookie.
  const savedLocale = data?.user.locale;
  useEffect(() => {
    if (savedLocale && savedLocale !== locale) setLocale(savedLocale);
  }, [savedLocale, locale, setLocale]);
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
    if (!res.ok) throw new Error(apiError(result));
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
      if (!res.ok) throw new Error(apiError(result));
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
      setNotice(t("hub.notice.saved"));
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.error.save"));
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
      if (!response.ok) throw new Error(apiError(result));
      if (updateDialog)
        setSelected({
          ...post,
          scheduled_at: result.scheduledAt,
          revision: result.revision,
        });
      setCalendarRefresh((value) => value + 1);
      await load();
      setNotice(t("hub.notice.rescheduled"));
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("hub.error.reschedule"),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  function openPost(p: Post) {
    setSelected(p);
    setApprovalUrl("");
    // Authors may only review their own post when nobody else can.
    const independent = data?.reviewers.filter(
      (reviewer) => reviewer.id !== p.author_id,
    );
    setReviewerId(
      p.approval_assigned_to ??
        independent?.find((reviewer) => reviewer.id === data?.user.id)?.id ??
        independent?.[0]?.id ??
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
      if (!response.ok) throw new Error(apiError(body));
      openPost(body.post);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("hub.error.loadPost"),
      );
    }
  }
  const currentPost =
    data?.posts.find((p) => p.id === selected?.id) ?? selected;
  const timeZone = data?.user.timezone ?? "Europe/Budapest";
  const viewLabel = (name: string) => t(`hub.nav.${name}` as MessageKey);
  const roleLabel = (role: string) => t(`common.role.${role}` as MessageKey);
  const failedOperations = data?.operations
    ? data.operations.publishDead +
      data.operations.mediaDead +
      data.operations.approvalDeliveriesFailed +
      data.operations.analyticsDead
    : 0;
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
            <small>{t("hub.sidebar.agency")}</small>
          </div>
        </div>
        <p className="nav-label">{t("hub.sidebar.workspace")}</p>
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
                {viewLabel(label)}
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
              ? t("hub.mode.meta")
              : data?.mode === "mock"
                ? t("hub.mode.mock")
                : t("hub.mode.other")}
            <small>
              {data?.meta.enabled
                ? t("hub.mode.metaHint")
                : data?.mode === "mock"
                  ? t("hub.mode.mockHint")
                  : t("hub.mode.otherHint")}
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
              {data?.user.name ?? t("hub.profile.fallback")}
              <small>{t("hub.profile.signOut")}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            {t("hub.topbar.workspace")} <ChevronRight size={14} />{" "}
            <strong>{viewLabel(view)}</strong>
          </div>
          <div className="topbar-actions">
            <label className="client-select">
              <span className="sr-only">{t("hub.topbar.client")}</span>
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
              title={t("hub.topbar.refresh")}
              onClick={() => {
                setCalendarRefresh((value) => value + 1);
                load().catch((e) => setError(e.message));
              }}
            >
              <RefreshCw size={18} />
            </button>
            <button
              className="icon-button"
              title={t("hub.topbar.notifications")}
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
          {/* While a post dialog is open its own alert shows the error. */}
          {error && !currentPost && (
            <div role="alert" className="alert">
              {error}
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  load().catch((e) => setError(e.message));
                }}
              >
                {t("common.action.tryAgain")}
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="success-notice">
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                {t("common.action.dismiss")}
              </button>
            </div>
          )}
          {!data ? (
            <div className="empty">
              <RefreshCw />
              <h2>{t("hub.loading.title")}</h2>
              <p>{t("hub.loading.body")}</p>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {view === "Home"
                      ? t("hub.home.eyebrow")
                      : (data.clients.find((c) => c.id === data.clientId)
                          ?.name ?? "G2A MARKETING")}
                  </p>
                  <h1>
                    {view === "Home"
                      ? t("hub.home.greeting", {
                          name: data.user.name
                            ? ", " + data.user.name.split(" ")[0]
                            : "",
                        })
                      : viewLabel(view)}
                  </h1>
                  <p className="muted">
                    {view === "Home"
                      ? t("hub.subtitle.Home")
                      : view === "Create"
                        ? t("hub.subtitle.Create")
                        : view === "Calendar"
                          ? t("hub.subtitle.Calendar", { timeZone })
                          : view === "Approvals"
                            ? t("hub.subtitle.Approvals")
                            : view === "Analytics"
                              ? data.mode === "mock"
                                ? t("hub.subtitle.AnalyticsMock")
                                : t("hub.subtitle.Analytics")
                              : view === "Team"
                                ? t("hub.subtitle.Team")
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
                    <Plus size={17} /> {t("hub.createPost")}
                  </button>
                )}
              </div>
              {!data.clients.length && view !== "Clients" ? (
                <div className="empty">
                  <Users />
                  <h2>{t("hub.noClients.title")}</h2>
                  <p>{t("hub.noClients.body")}</p>
                  <button
                    className="primary"
                    onClick={() => setView("Clients")}
                  >
                    {t("hub.noClients.action")}
                  </button>
                </div>
              ) : (
                <>
                  {view === "Home" && (
                    <>
                      {data.operations?.needsAttention && (
                        <div role="status" className="notice">
                          <strong>{t("hub.ops.title")}</strong>{" "}
                          {!!failedOperations &&
                            t(
                              failedOperations === 1
                                ? "hub.ops.failed.one"
                                : "hub.ops.failed.other",
                              { count: failedOperations },
                            )}{" "}
                          {!!data.operations.unhealthyTokens &&
                            t(
                              data.operations.unhealthyTokens === 1
                                ? "hub.ops.tokens.one"
                                : "hub.ops.tokens.other",
                              { count: data.operations.unhealthyTokens },
                            )}
                          <button
                            className="text-button"
                            onClick={() => setView("Settings")}
                          >
                            {t("hub.ops.view")}
                          </button>
                        </div>
                      )}
                      <div className="stats">
                        {(
                          [
                            ["hub.stats.Scheduled", "SCHEDULED", "Calendar"],
                            [
                              "hub.stats.Awaiting",
                              "PENDING_APPROVAL",
                              "Approvals",
                            ],
                            ["hub.stats.Published", "PUBLISHED", "Posts"],
                            ["hub.stats.Attention", "FAILED", "Posts"],
                          ] as const
                        ).map(([label, status, target]) => (
                          <button
                            className="stat"
                            key={status}
                            onClick={() => {
                              setView(target);
                              setFilter(status);
                            }}
                          >
                            <span>
                              {t(label)}
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
                            <small>{t("hub.stats.scope")}</small>
                          </button>
                        ))}
                      </div>
                      <div className="dashboard-grid">
                        <section className="panel">
                          <div className="panel-title">
                            <h2>{t("hub.upcoming.title")}</h2>
                            <button
                              className="text-button"
                              onClick={() => setView("Calendar")}
                            >
                              {t("hub.upcoming.viewCalendar")}{" "}
                              <ArrowUpRight size={15} />
                            </button>
                          </div>
                          <div className="list-tabs">
                            <span className="active">
                              {t("hub.upcoming.tab")}
                            </span>
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
                                    ).toLocaleDateString(intlLocale(), {
                                      timeZone,
                                      day: "2-digit",
                                    })}
                                  </strong>
                                  <span>
                                    {new Date(
                                      p.scheduled_at!,
                                    ).toLocaleDateString(intlLocale(), {
                                      timeZone,
                                      month: "short",
                                    })}
                                  </span>
                                </div>
                                <div className="row-body">
                                  <strong>
                                    {p.caption.slice(0, 75) ||
                                      t("hub.upcoming.mediaPost")}
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
                              {t("hub.upcoming.empty")}
                            </div>
                          )}
                          <button
                            className="panel-footer"
                            onClick={() => setView("Create")}
                          >
                            <Plus size={16} /> {t("hub.upcoming.plan")}
                          </button>
                        </section>
                        <section className="panel">
                          <div className="panel-title">
                            <h2>{t("hub.attention.title")}</h2>
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
                                      ? t("hub.attention.review")
                                      : t("hub.attention.failed")}
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
                              {t("hub.attention.empty")}
                            </div>
                          )}
                        </section>
                      </div>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>{t("hub.accounts.title")}</h2>
                          <button
                            className="text-button"
                            onClick={() => setView("Connected accounts")}
                          >
                            {t("hub.accounts.manage")}{" "}
                            <ArrowUpRight size={15} />
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
                                  {t(`common.status.${a.status}` as MessageKey)}
                                </small>
                              </span>
                            </div>
                          ))}
                          {!data.accounts.length && (
                            <p className="muted">
                              {data.mode === "mock"
                                ? t("hub.accounts.emptyMock")
                                : t("hub.accounts.empty")}
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
                      error={error}
                      reload={load}
                      onError={setError}
                      onCreated={(p, reviewUrl) => {
                        setEditing(undefined);
                        setView("Posts");
                        openPost(p);
                        if (reviewUrl) setApprovalUrl(reviewUrl);
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
                        <h2>{t("hub.notifications.title")}</h2>
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
                          {t("hub.notifications.empty")}
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
                      <LanguageSettings
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
                            <h2>{t("hub.operations.title")}</h2>
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
                              <small>{t("hub.operations.worker")}</small>
                              <strong>
                                {data.operations.worker.healthy
                                  ? t("hub.operations.healthy")
                                  : t("hub.operations.offline")}
                              </strong>
                              <small>
                                {data.operations.worker.lastSeenAt
                                  ? formatDate(
                                      data.operations.worker.lastSeenAt,
                                      timeZone,
                                    )
                                  : t("hub.operations.noHeartbeat")}
                              </small>
                            </div>
                            <div>
                              <small>{t("hub.operations.publishQueue")}</small>
                              <strong>
                                {t("hub.operations.waitingDead", {
                                  waiting: data.operations.publishWaiting,
                                  dead: data.operations.publishDead,
                                })}
                              </strong>
                              <small>
                                {t("hub.operations.uncertain", {
                                  count: data.operations.publishUncertain,
                                })}
                              </small>
                              <small>
                                {t("hub.operations.reconciling", {
                                  waiting:
                                    data.operations
                                      .publishReconciliationWaiting,
                                  unresolved:
                                    data.operations
                                      .publishReconciliationUnresolved,
                                })}
                              </small>
                              <small>
                                {t("hub.operations.lastConfirmed", {
                                  when: data.operations
                                    .publishReconciliationLastSuccessAt
                                    ? formatDate(
                                        data.operations
                                          .publishReconciliationLastSuccessAt,
                                        timeZone,
                                      )
                                    : t("hub.operations.noReconciled"),
                                })}
                              </small>
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() =>
                                  mutate("publishing.reconcile").catch(() => {})
                                }
                              >
                                {t("hub.operations.recheck")}
                              </button>
                            </div>
                            <div>
                              <small>{t("hub.operations.mediaQueue")}</small>
                              <strong>
                                {t("hub.operations.activeDead", {
                                  active: data.operations.mediaWaiting,
                                  dead: data.operations.mediaDead,
                                })}
                              </strong>
                              <small>
                                {t("hub.operations.oldestDue", {
                                  seconds: data.operations.oldestDueSeconds,
                                })}
                              </small>
                            </div>
                            <div>
                              <small>
                                {t("hub.operations.approvalOutbox")}
                              </small>
                              <strong>
                                {t("hub.operations.waitingFailed", {
                                  waiting:
                                    data.operations.approvalDeliveriesWaiting,
                                  failed:
                                    data.operations.approvalDeliveriesFailed,
                                })}
                              </strong>
                              <small>{t("hub.operations.approvalHint")}</small>
                            </div>
                            <div>
                              <small>{t("hub.operations.credentials")}</small>
                              <strong>
                                {t("hub.operations.connected", {
                                  count: data.operations.connectedAccounts,
                                })}
                              </strong>
                              <small>
                                {t("hub.operations.requireReview", {
                                  count: data.operations.unhealthyTokens,
                                })}
                              </small>
                            </div>
                            <div>
                              <small>{t("hub.operations.analytics")}</small>
                              <strong>
                                {t("hub.operations.activeDead", {
                                  active: data.operations.analyticsWaiting,
                                  dead: data.operations.analyticsDead,
                                })}
                              </strong>
                              <small>
                                {t("hub.operations.lastSuccess", {
                                  when: data.operations.analyticsLastSuccessAt
                                    ? formatDate(
                                        data.operations.analyticsLastSuccessAt,
                                        timeZone,
                                      )
                                    : t("hub.operations.noSync"),
                                })}
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
                                {t("hub.operations.backfill")}
                              </button>
                            </div>
                          </div>
                          <p className="panel-note">
                            {t("hub.operations.liveness")}:{" "}
                            <code>/api/health/live</code> ·{" "}
                            {t("hub.operations.readiness")}:{" "}
                            <code>/api/health/ready</code>
                          </p>
                        </section>
                      )}
                      <section className="panel">
                        <div className="panel-title">
                          <h2>{t("hub.workspace.title")}</h2>
                        </div>
                        <div className="settings-grid">
                          <div>
                            <small>{t("hub.workspace.role")}</small>
                            <strong>{roleLabel(data.role)}</strong>
                          </div>
                          <div>
                            <small>{t("hub.workspace.provider")}</small>
                            <strong>
                              {data.mode === "mock"
                                ? t("hub.workspace.providerMock")
                                : data.mode}
                            </strong>
                          </div>
                        </div>
                        <p className="panel-note">
                          <a href="/legal/privacy">{t("hub.legal.privacy")}</a>{" "}
                          · <a href="/legal/terms">{t("hub.legal.terms")}</a> ·{" "}
                          <a href="/legal/deletion">
                            {t("hub.legal.deletion")}
                          </a>
                        </p>
                      </section>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>{t("hub.audit.title")}</h2>
                          <span className="muted">{t("hub.audit.latest")}</span>
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
              <h2 id="post-title">{t("hub.dialog.title")}</h2>
              <button
                onClick={() => setSelected(undefined)}
                aria-label={t("hub.dialog.close")}
              >
                {t("common.action.close")}
              </button>
            </div>
            <div className="dialog-body">
              <Badge status={currentPost.status} />
              <p className="caption-full">{currentPost.caption}</p>
              <p className="muted">
                {formatDate(currentPost.scheduled_at, timeZone)}
              </p>
              {currentPost.targets.map((target) => (
                <div className="target-detail" key={target.id}>
                  <div>
                    <Network platform={target.platform} />
                    <strong>
                      {t(`common.network.${target.platform}` as MessageKey)}
                    </strong>
                    {deliveryStates.includes(currentPost.status) && (
                      <Badge status={target.status} />
                    )}
                  </div>
                  <p>{target.caption}</p>
                  {!!target.mediaIds.length && data?.clientId && (
                    <div className="target-media">
                      {target.mediaIds.map((id) => (
                        <MediaThumb
                          key={id}
                          clientId={data.clientId!}
                          asset={
                            data.media.find((m) => m.id === id) ?? {
                              id,
                              name: "",
                              mime_type: "image/",
                            }
                          }
                        />
                      ))}
                    </div>
                  )}
                  {target.errorCode && (
                    <p className="alert">
                      {errorMessage(locale, target.errorCode, target.errorCode)}
                    </p>
                  )}
                </div>
              ))}
              {approvalUrl && (
                <div className="notice">
                  <strong>{t("hub.dialog.approvalLink")}</strong>
                  <a href={approvalUrl} target="_blank" rel="noreferrer">
                    {t("hub.dialog.openReview")}
                  </a>
                  <input
                    aria-label={t("hub.dialog.approvalLinkLabel")}
                    value={approvalUrl}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                </div>
              )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_escalated_at && (
                  <div className="notice warning">
                    <strong>{t("hub.dialog.escalated")}</strong>
                    <p>
                      {t("hub.dialog.escalatedBody", {
                        date: formatDate(
                          currentPost.approval_escalated_at,
                          timeZone,
                        ),
                      })}
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
                    {t("hub.dialog.newLink")}
                  </button>
                )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_kind === "INTERNAL" &&
                currentPost.approval_status === "PENDING" && (
                  <div className="notice">
                    <strong>
                      {t("hub.dialog.internalReview", {
                        name:
                          currentPost.approval_reviewer_name ??
                          t("hub.dialog.unassigned"),
                      })}
                    </strong>
                    <p>
                      {t("hub.dialog.due", {
                        due: currentPost.approval_expires_at
                          ? formatDate(
                              currentPost.approval_expires_at,
                              timeZone,
                            )
                          : t("hub.dialog.dueWithin"),
                        sent: currentPost.approval_reminder_count ?? 0,
                        automatic:
                          currentPost.approval_automatic_reminder_count ?? 0,
                      })}
                    </p>
                    {currentPost.approval_next_reminder_at && (
                      <p>
                        {t("hub.dialog.nextReminder", {
                          date: formatDate(
                            currentPost.approval_next_reminder_at,
                            timeZone,
                          ),
                        })}
                      </p>
                    )}
                    {["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(
                      data?.role ?? "",
                    ) && (
                      <div className="review-assignment">
                        <label>
                          {t("hub.dialog.assignedReviewer")}
                          <select
                            aria-label={t("hub.dialog.assignedReviewer")}
                            value={reviewerId}
                            onChange={(event) =>
                              setReviewerId(event.target.value)
                            }
                          >
                            {data?.reviewers.map((reviewer) => (
                              <option key={reviewer.id} value={reviewer.id}>
                                {reviewer.name} · {roleLabel(reviewer.role)}
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
                            {t("hub.dialog.assign")}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              mutate("post.review.remind", {
                                id: currentPost.id,
                              }).catch(() => {})
                            }
                          >
                            {t("hub.dialog.remind")}
                          </button>
                        </div>
                      </div>
                    )}
                    {currentPost.approval_assigned_to === data?.user.id ? (
                      <>
                        <label>
                          {t("hub.dialog.feedback")}
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
                            {t("hub.dialog.approve")}
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
                            {t("hub.dialog.requestChanges")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>
                        {t("hub.dialog.waitingFor", {
                          name:
                            currentPost.approval_reviewer_name ??
                            t("hub.dialog.assignedFallback"),
                        })}
                      </p>
                    )}
                  </div>
                )}
              {currentPost.status === "PENDING_APPROVAL" &&
                currentPost.approval_status === "EXPIRED" && (
                  <div className="notice warning">
                    <strong>{t("hub.dialog.expired")}</strong>
                    <p>
                      {t(
                        currentPost.approval_kind === "INTERNAL"
                          ? "hub.dialog.renew.INTERNAL"
                          : "hub.dialog.renew.EXTERNAL",
                      )}
                    </p>
                    {currentPost.approval_kind === "INTERNAL" && (
                      <label>
                        {t("hub.dialog.assignedReviewer")}
                        <select
                          aria-label={t("hub.dialog.renewalReviewer")}
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
                      {t("hub.dialog.renewAction")}
                    </button>
                  </div>
                )}
              {!!currentPost.approval_history?.length && (
                <div className="approval-history">
                  <h3>{t("hub.dialog.history")}</h3>
                  {currentPost.approval_history.map((review) => (
                    <div className="approval-history-row" key={review.id}>
                      <Badge status={review.status} />
                      <span>
                        {t(
                          review.kind === "INTERNAL"
                            ? "hub.dialog.history.INTERNAL"
                            : "hub.dialog.history.EXTERNAL",
                        )}
                        {review.reviewerName ? ` · ${review.reviewerName}` : ""}
                        {review.automaticReminderCount
                          ? ` · ${t(
                              review.automaticReminderCount === 1
                                ? "hub.dialog.history.reminders.one"
                                : "hub.dialog.history.reminders.other",
                              { count: review.automaticReminderCount },
                            )}`
                          : ""}
                        {review.escalatedAt
                          ? ` · ${t("hub.dialog.history.escalated")}`
                          : ""}
                      </span>
                      <small>{formatDate(review.createdAt, timeZone)}</small>
                    </div>
                  ))}
                </div>
              )}
              {error && (
                <div role="alert" className="alert dialog-alert">
                  {error}
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
                  {t("hub.dialog.editDraft")}
                </button>
              )}
              {currentPost.status === "DRAFT" && (
                <>
                  {data?.workflow[0] === "INTERNAL" && (
                    <label>
                      {t("hub.dialog.internalReviewer")}
                      <select
                        aria-label={t("hub.dialog.internalReviewer")}
                        value={reviewerId}
                        onChange={(event) => setReviewerId(event.target.value)}
                      >
                        <option value="">
                          {t("hub.dialog.chooseReviewer")}
                        </option>
                        {data.reviewers.map((reviewer) => (
                          <option key={reviewer.id} value={reviewer.id}>
                            {reviewer.name} · {roleLabel(reviewer.role)}
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
                    {t("hub.dialog.submit")}
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
                    {t("hub.dialog.schedule", { timeZone })}
                    <input name="schedule" type="datetime-local" required />
                  </label>
                  <div className="button-row">
                    <button className="primary" disabled={busy}>
                      {t("hub.dialog.schedulePost")}
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
                      {t("hub.dialog.publishNow")}
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
                      {t("hub.dialog.moveTo", { timeZone })}
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
                      {t("hub.dialog.reschedule")}
                    </button>
                  </form>
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
                  className="text-button danger-button dialog-cancel"
                  disabled={busy}
                  onClick={() =>
                    mutate("post.cancel", { id: currentPost.id })
                      .then(() => setSelected(undefined))
                      .catch(() => {})
                  }
                >
                  {t("hub.dialog.cancelPost")}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
