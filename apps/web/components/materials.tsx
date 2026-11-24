"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Upload, Video } from "lucide-react";
import { formatDate, type HubData, type Mutate } from "./types";
import { apiError, useT, type MessageKey } from "../i18n";
import { MediaPreview } from "./composer";
import { MEDIA_TYPES, sendFile } from "./media";

const NOTE_MAX = 1000;
const REASON_MAX = 500;
const statuses = ["PENDING", "ACCEPTED", "REJECTED"] as const;
type Status = (typeof statuses)[number];
type ClientUpload = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
  asset_status: string;
  status: Status;
  note: string | null;
  reason: string | null;
  created_at: string;
  uploader_name?: string | null;
};
type Page = {
  items: ClientUpload[];
  nextCursor: string | null;
  pending?: number;
};

async function callPortal(clientId: string, body: Record<string, unknown>) {
  const response = await fetch("/api/client-uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, ...body }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(apiError(result));
  return result;
}

// One page of uploads at a time; refreshes while files are being processed.
function useUploads(clientId: string, status?: Status) {
  const { t } = useT();
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null });
  const [error, setError] = useState("");
  // A slow answer for an earlier filter must not replace a newer list.
  const latest = useRef(0);
  const fetchPage = useCallback(
    async (before?: string) => {
      const query = new URLSearchParams({ clientId });
      if (status) query.set("status", status);
      if (before) query.set("before", before);
      const response = await fetch(`/api/client-uploads?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result));
      return result as Page;
    },
    [clientId, status],
  );
  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const first = await fetchPage();
      if (request !== latest.current) return;
      setPage(first);
      setError("");
    } catch (e) {
      if (request !== latest.current) return;
      setError(e instanceof Error ? e.message : t("common.error.generic"));
    }
  }, [fetchPage, t]);
  const loadMore = async () => {
    const request = ++latest.current;
    try {
      const next = await fetchPage(page.nextCursor ?? undefined);
      if (request !== latest.current) return;
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.error.generic"));
    }
  };
  useEffect(() => {
    setPage({ items: [], nextCursor: null });
    void load();
  }, [load]);
  const working = page.items.some((item) =>
    ["UPLOADING", "PROCESSING"].includes(item.asset_status),
  );
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [working, load]);
  return { page, error, setError, load, loadMore };
}

function stateOf(item: ClientUpload) {
  if (item.asset_status === "FAILED") return "failed";
  if (item.asset_status !== "READY") return "processing";
  return item.status.toLowerCase() as "pending" | "accepted" | "rejected";
}

function UploadCard({
  clientId,
  item,
  children,
}: {
  clientId: string;
  item: ClientUpload;
  children?: React.ReactNode;
}) {
  const { t } = useT();
  const video = item.mime_type.startsWith("video/");
  const state = stateOf(item);
  return (
    <section className="panel media-card" aria-label={item.name}>
      <div className="media-image">
        {item.asset_status === "READY" ? (
          <MediaPreview
            clientId={clientId}
            id={item.id}
            name={item.name}
            video={video}
          />
        ) : (
          <div className="media-placeholder">
            {t(`materials.state.${state}` as MessageKey)}
          </div>
        )}
      </div>
      <div>
        <strong>
          {video ? <Video size={15} /> : <ImageIcon size={15} />} {item.name}
        </strong>
        <small>
          {(Number(item.size_bytes) / 1024).toFixed(0)} KB{" "}
          {item.width ? `· ${item.width} × ${item.height}` : ""}
        </small>
        <span
          className={`badge ${
            {
              accepted: "approved",
              rejected: "failed",
              pending: "pending_approval",
            }[state as string] ?? state
          }`}
        >
          {t(`materials.state.${state}` as MessageKey)}
        </span>
        {item.note && <p className="material-text">{item.note}</p>}
        {item.reason && (
          <p className="material-text">
            {t("materials.reason", { reason: item.reason })}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

// The client's own view: upload for the team and follow what happened.
export function Materials({ data }: { data: HubData }) {
  const clientId = data.clientId!;
  const { t } = useT();
  const { page, error, setError, load, loadMore } = useUploads(clientId);
  const [queue, setQueue] = useState<{ file: File; note: string }[]>([]);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = (files: FileList | null) => {
    if (files && !busy)
      setQueue([
        ...queue,
        ...Array.from(files).map((file) => ({ file, note: "" })),
      ]);
  };
  async function uploadAll() {
    setBusy(true);
    setError("");
    const failed: typeof queue = [];
    const messages: string[] = [];
    for (const [index, entry] of queue.entries()) {
      setProgress(
        t("materials.upload.progress", {
          done: index + 1,
          total: queue.length,
        }),
      );
      try {
        await sendFile(
          entry.file,
          t,
          (file) =>
            callPortal(clientId, {
              action: "prepare",
              ...file,
              note: entry.note,
            }),
          (id) => callPortal(clientId, { action: "complete", id }),
        );
      } catch (e) {
        failed.push(entry);
        messages.push(
          t("materials.upload.failed", {
            name: entry.file.name,
            message: e instanceof Error ? e.message : t("media.error.upload"),
          }),
        );
      }
    }
    setQueue(failed);
    setProgress("");
    setBusy(false);
    await load();
    if (messages.length) setError(messages.join(" "));
  }
  async function withdraw(id: string) {
    if (!window.confirm(t("materials.withdraw.confirm"))) return;
    setBusy(true);
    try {
      await callPortal(clientId, { action: "withdraw", id });
      await load();
    } catch (e) {
      await load();
      setError(e instanceof Error ? e.message : t("common.error.generic"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      <div
        className="upload-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          choose(e.dataTransfer.files);
        }}
      >
        <Upload size={25} />
        <h3>{progress || t("materials.upload.title")}</h3>
        <p>{t("materials.upload.formats")}</p>
        <label className="upload-button">
          {t("materials.upload.choose")}
          <input
            type="file"
            multiple
            accept={MEDIA_TYPES.join(",")}
            disabled={busy}
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {queue.length > 0 && (
        <section className="panel material-queue">
          {queue.map((entry, index) => (
            <div key={index}>
              <strong>{entry.file.name}</strong>
              <label>
                {t("materials.note.label")}
                <textarea
                  rows={2}
                  maxLength={NOTE_MAX}
                  disabled={busy}
                  placeholder={t("materials.note.placeholder")}
                  value={entry.note}
                  onChange={(e) =>
                    setQueue(
                      queue.map((other, n) =>
                        n === index
                          ? { ...other, note: e.target.value }
                          : other,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                aria-label={t("materials.note.remove", {
                  name: entry.file.name,
                })}
                onClick={() => setQueue(queue.filter((_, n) => n !== index))}
              >
                {t("materials.team.cancel")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void uploadAll()}
          >
            {t("materials.upload.start")}
          </button>
        </section>
      )}
      <h2 className="material-heading">{t("materials.mine.title")}</h2>
      {!page.items.length && !error && (
        <p className="muted">{t("materials.mine.empty")}</p>
      )}
      <div className="media-grid">
        {page.items.map((item) => (
          <UploadCard key={item.id} clientId={clientId} item={item}>
            {item.status === "PENDING" &&
              ["READY", "FAILED"].includes(item.asset_status) && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("materials.withdraw.label", {
                    name: item.name,
                  })}
                  onClick={() => void withdraw(item.id)}
                >
                  {t("materials.withdraw.action")}
                </button>
              )}
          </UploadCard>
        ))}
      </div>
      {page.nextCursor && (
        <button
          type="button"
          className="text-button"
          onClick={() => void loadMore()}
        >
          {t("materials.more")}
        </button>
      )}
    </>
  );
}

// The team's part of the media library: accept or reject what came in.
export function ClientUploads({
  data,
  mutate,
  reload,
}: {
  data: HubData;
  mutate: Mutate;
  reload: () => Promise<void>;
}) {
  const clientId = data.clientId!;
  const { t } = useT();
  const [status, setStatus] = useState<Status>("PENDING");
  const { page, error, setError, load, loadMore } = useUploads(
    clientId,
    status,
  );
  const [rejecting, setRejecting] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    let message = "";
    try {
      await action();
      setRejecting("");
      setReason("");
    } catch (e) {
      message = e instanceof Error ? e.message : t("common.error.generic");
    }
    await load();
    await reload();
    if (message) setError(message);
    setBusy(false);
  }
  const decide = (item: ClientUpload, decision: "accept" | "reject") =>
    run(() =>
      callPortal(clientId, {
        action: "decide",
        id: item.id,
        decision,
        expectedStatus: item.status,
        ...(decision === "reject" ? { reason } : {}),
      }),
    );
  return (
    <section className="client-uploads">
      <div className="media-toolbar">
        <h2 className="material-heading">
          {t("materials.team.title")}
          {!!page.pending && (
            <span className="badge pending_approval">
              {t("materials.team.count", { count: page.pending })}
            </span>
          )}
        </h2>
        <select
          aria-label={t("materials.team.filter")}
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
        >
          {statuses.map((value) => (
            <option key={value} value={value}>
              {t(`materials.team.filter.${value}`)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {!page.items.length && !error && (
        <p className="muted">{t("materials.team.empty")}</p>
      )}
      <div className="media-grid">
        {page.items.map((item) => (
          <UploadCard key={item.id} clientId={clientId} item={item}>
            <small>
              {t("materials.team.uploader", {
                name: item.uploader_name ?? t("materials.team.unknown"),
                date: formatDate(item.created_at, data.user.timezone),
              })}
            </small>
            {item.asset_status === "READY" && rejecting !== item.id && (
              <div className="material-actions">
                {item.status !== "ACCEPTED" && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    aria-label={t("materials.team.accept.label", {
                      name: item.name,
                    })}
                    onClick={() => void decide(item, "accept")}
                  >
                    {t("materials.team.accept")}
                  </button>
                )}
                {item.status !== "REJECTED" && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("materials.team.reject.label", {
                      name: item.name,
                    })}
                    onClick={() => {
                      setReason("");
                      setRejecting(item.id);
                    }}
                  >
                    {t("materials.team.reject")}
                  </button>
                )}
                {item.status === "REJECTED" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => mutate("media.delete", { id: item.id }))
                    }
                  >
                    {t("materials.team.delete")}
                  </button>
                )}
              </div>
            )}
            {rejecting === item.id && (
              <div className="material-reject">
                <label>
                  {t("materials.team.reason")}
                  <textarea
                    rows={2}
                    maxLength={REASON_MAX}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(item, "reject")}
                >
                  {t("materials.team.reject.confirm")}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRejecting("")}
                >
                  {t("materials.team.cancel")}
                </button>
              </div>
            )}
          </UploadCard>
        ))}
      </div>
      {page.nextCursor && (
        <button
          type="button"
          className="text-button"
          onClick={() => void loadMore()}
        >
          {t("materials.more")}
        </button>
      )}
    </section>
  );
}
