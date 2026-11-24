"use client";
import { useRef, useState } from "react";
import { Download, FileUp } from "lucide-react";
import {
  maxImportRows,
  sampleCsv,
  sampleJson,
} from "../../../packages/core/calendar-import";
import type { Account } from "./types";
import { apiError, useT } from "../i18n";

type PreviewRow = {
  line: number;
  suggested_at: string | null;
  targets: string[];
  text: string;
  errors: string[];
};
type Preview = {
  fileName: string;
  format: "csv" | "json";
  rows: PreviewRow[];
  errors: { line: number; message: string }[];
  ok: boolean;
};

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

// Uploads a month's drafts from a CSV or JSON file: the server previews every
// row first and imports only a file without errors, all rows at once.
export function CalendarImport({
  clientId,
  accounts,
  onImported,
}: {
  clientId: string;
  accounts: Account[];
  onImported: (count: number) => void;
}) {
  const { t } = useT();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const connected = accounts.filter((a) => a.status === "CONNECTED");
  const ids = connected.map((a) => a.id);
  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? id;

  async function send(mode: "preview" | "import", chosen: File) {
    const form = new FormData();
    form.set("clientId", clientId);
    form.set("mode", mode);
    form.set("file", chosen);
    const response = await fetch("/api/calendar/import", {
      method: "POST",
      body: form,
    });
    return { response, body: await response.json().catch(() => ({})) };
  }

  async function choose(chosen: File | undefined) {
    setFile(chosen);
    setPreview(undefined);
    setError("");
    if (!chosen) return;
    setBusy(true);
    try {
      const { response, body } = await send("preview", chosen);
      if (response.ok) setPreview(body);
      else setError(apiError(body));
    } catch {
      setError(t("calendar.import.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!file || !preview?.ok) return;
    setBusy(true);
    setError("");
    try {
      const { response, body } = await send("import", file);
      if (response.ok) {
        setFile(undefined);
        setPreview(undefined);
        if (input.current) input.current.value = "";
        onImported(body.created);
      } else {
        if (body.preview) setPreview(body.preview);
        setError(apiError(body));
      }
    } catch {
      setError(t("calendar.import.failed"));
    } finally {
      setBusy(false);
    }
  }

  const errorCount =
    (preview?.errors.length ?? 0) +
    (preview?.rows.filter((r) => r.errors.length).length ?? 0);

  return (
    <section className="panel" aria-labelledby="calendar-import-title">
      <div className="panel-title">
        <div>
          <h2 id="calendar-import-title">{t("calendar.import.title")}</h2>
          <span className="muted">
            {t("calendar.import.subtitle", { max: maxImportRows })}
          </span>
        </div>
        <FileUp size={20} />
      </div>
      <div className="inline-form">
        <label>
          {t("calendar.import.file")}
          <input
            ref={input}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            disabled={busy}
            // Choosing the same, corrected file again must re-run the preview.
            onClick={(event) => {
              event.currentTarget.value = "";
            }}
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            download(
              "naptar-minta.csv",
              sampleCsv(ids),
              "text/csv;charset=utf-8",
            )
          }
        >
          <Download size={15} /> {t("calendar.import.sampleCsv")}
        </button>
        <button
          type="button"
          onClick={() =>
            download("naptar-minta.json", sampleJson(ids), "application/json")
          }
        >
          <Download size={15} /> {t("calendar.import.sampleJson")}
        </button>
      </div>
      <p className="muted">{t("calendar.import.help")}</p>
      {connected.length ? (
        <ul className="muted">
          {connected.map((a) => (
            <li key={a.id}>
              {a.name} ({a.platform}): <code>{a.id}</code>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty compact">{t("calendar.import.noAccounts")}</div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {busy && !preview && (
        <div className="muted" role="status">
          {t("calendar.import.checking")}
        </div>
      )}
      {preview && (
        <>
          <div className="muted" role="status">
            {preview.ok
              ? t("calendar.import.ready", { count: preview.rows.length })
              : t("calendar.import.hasErrors", { count: errorCount })}
          </div>
          {preview.errors.map((e) => (
            <div className="notice" role="alert" key={`${e.line}-${e.message}`}>
              {e.line
                ? t("calendar.import.lineError", {
                    line: e.line,
                    message: e.message,
                  })
                : e.message}
            </div>
          ))}
          {!!preview.rows.length && (
            <div className="table-scroll">
              <table aria-label={t("calendar.import.previewLabel")}>
                <thead>
                  <tr>
                    <th>{t("calendar.import.col.line")}</th>
                    <th>{t("calendar.import.col.date")}</th>
                    <th>{t("calendar.import.col.channels")}</th>
                    <th>{t("calendar.import.col.text")}</th>
                    <th>{t("calendar.import.col.result")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.line}>
                      <td>{row.line}</td>
                      <td>{row.suggested_at ?? "–"}</td>
                      <td>{row.targets.map(accountName).join(", ")}</td>
                      <td>{row.text}</td>
                      <td>
                        {row.errors.length
                          ? row.errors.join(" ")
                          : t("calendar.import.rowOk")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            className="primary"
            type="button"
            disabled={busy || !preview.ok}
            onClick={submit}
          >
            {t("calendar.import.submit")}
          </button>
        </>
      )}
    </section>
  );
}
