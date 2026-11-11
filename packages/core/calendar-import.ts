// Calendar import files (JSON or CSV) parsed into the body of
// POST /api/v1/clients/{id}/drafts: { drafts: [...] }. Pure: validation of
// the drafts themselves is the API's shared schema on the server.

export const maxImportBytes = 1024 * 1024;
export const maxImportRows = 200;
export const csvColumns = [
  "suggested_at",
  "text",
  "targets",
  "media_urls",
  "pillar",
] as const;
const requiredColumns = ["text", "targets"] as const;
// Several targets or media URLs share one CSV cell.
export const listSeparator = "|";

export type ImportFormat = "csv" | "json";
// `line` is the physical line of a CSV record's first line (the header is
// line 1) or the 1-based array position of a JSON draft; 0 is the whole file.
export type ImportRow = { line: number; draft: Record<string, unknown> };
export type ImportError = { line: number; message: string };
export type ParsedImport = {
  format: ImportFormat;
  rows: ImportRow[];
  errors: ImportError[];
};

export function importFormat(fileName: string): ImportFormat | null {
  const extension = fileName.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return extension === "csv" || extension === "json" ? extension : null;
}

export function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const fileError = (format: ImportFormat, message: string): ParsedImport => ({
  format,
  rows: [],
  errors: [{ line: 0, message }],
});

export function parseCalendarImport(
  text: string,
  format: ImportFormat,
): ParsedImport {
  return format === "json"
    ? parseJsonImport(stripBom(text))
    : parseCsvImport(stripBom(text));
}

function parseJsonImport(text: string): ParsedImport {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fileError("json", "A fájl nem érvényes JSON.");
  }
  const drafts =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { drafts?: unknown }).drafts
      : undefined;
  if (!Array.isArray(drafts))
    return fileError(
      "json",
      'A JSON-nak { "drafts": [...] } alakúnak kell lennie.',
    );
  const extra = Object.keys(body as object).filter((key) => key !== "drafts");
  return {
    format: "json",
    rows: drafts.map((draft, index) => ({
      line: index + 1,
      draft: draft as Record<string, unknown>,
    })),
    errors: extra.length
      ? [
          {
            line: 0,
            message: `Ismeretlen mező a fájlban: ${extra.join(", ")}.`,
          },
        ]
      : [],
  };
}

type CsvRecord = { line: number; cells: string[] };

// Excel saves ";" in Hungarian locales and "," elsewhere; the header row
// decides (quoted parts are ignored).
export function detectDelimiter(text: string): "," | ";" {
  let commas = 0,
    semicolons = 0,
    quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char === ",") commas++;
    else if (!quoted && char === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

// RFC 4180: quoted fields, "" escapes, line breaks inside quotes, CRLF or LF.
export function parseCsv(
  text: string,
  delimiter: "," | ";",
): { records: CsvRecord[]; error?: ImportError } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else {
        if (char === "\n") line++;
        // A CRLF inside quotes is one line break.
        if (char === "\r" && text[i + 1] === "\n") continue;
        if (char === "\r") line++;
        cell += char === "\r" ? "\n" : char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
      quoteLine = line;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      records.push({ line: recordLine, cells });
      cells = [];
      cell = "";
      line++;
      recordLine = line;
    } else cell += char;
  }
  if (quoted)
    return {
      records,
      error: {
        line: quoteLine,
        message: 'Lezáratlan idézőjel: a mező végéről hiányzik a ".',
      },
    };
  if (cell !== "" || cells.length) {
    cells.push(cell);
    records.push({ line: recordLine, cells });
  }
  return { records };
}

const splitList = (value: string) =>
  value
    .split(listSeparator)
    .map((item) => item.trim())
    .filter(Boolean);

function parseCsvImport(text: string): ParsedImport {
  const { records, error } = parseCsv(text, detectDelimiter(text));
  if (error) return { format: "csv", rows: [], errors: [error] };
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim()));
  const header = nonEmpty.shift();
  if (!header) return fileError("csv", "A fájl üres.");
  const columns = header.cells.map((c) => c.trim().toLowerCase());
  const errors: ImportError[] = [];
  const unknown = columns.filter(
    (c) => !(csvColumns as readonly string[]).includes(c),
  );
  if (unknown.length)
    errors.push({
      line: header.line,
      message: `Ismeretlen oszlop: ${unknown.join(", ")}. Használható oszlopok: ${csvColumns.join(", ")}.`,
    });
  const duplicates = columns.filter((c, i) => c && columns.indexOf(c) !== i);
  if (duplicates.length)
    errors.push({
      line: header.line,
      message: `Ismétlődő oszlop: ${[...new Set(duplicates)].join(", ")}.`,
    });
  const missing = requiredColumns.filter((c) => !columns.includes(c));
  if (missing.length)
    errors.push({
      line: header.line,
      message: `Hiányzó kötelező oszlop: ${missing.join(", ")}.`,
    });
  if (errors.length) return { format: "csv", rows: [], errors };

  const rows: ImportRow[] = [];
  for (const record of nonEmpty) {
    if (record.cells.length > columns.length) {
      errors.push({
        line: record.line,
        message: `A sorban több mező van (${record.cells.length}), mint a fejlécben (${columns.length}). A vesszőt vagy pontosvesszőt tartalmazó szöveget tedd idézőjelbe.`,
      });
      continue;
    }
    const value = (column: string) =>
      record.cells[columns.indexOf(column)] ?? "";
    const draft: Record<string, unknown> = {
      text: value("text"),
      targets: splitList(value("targets")).map((id) => ({
        social_account_id: id,
      })),
    };
    const suggestedAt = value("suggested_at").trim();
    if (suggestedAt) draft.suggested_at = suggestedAt;
    const mediaUrls = splitList(value("media_urls"));
    if (mediaUrls.length) draft.media_urls = mediaUrls;
    const pillar = value("pillar").trim();
    if (pillar) draft.pillar = pillar;
    rows.push({ line: record.line, draft });
  }
  return { format: "csv", rows, errors };
}

function csvCell(value: string) {
  return /[",;\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// Sample files for one client's connected accounts. The CSV starts with a
// BOM so Excel opens the accents correctly, and uses ";" like Hungarian Excel.
export function sampleDrafts(accountIds: string[], month = "2026-12") {
  const [first = "00000000-0000-4000-8000-000000000001", second] = accountIds;
  const both = second ? [first, second] : [first];
  return [
    {
      suggested_at: `${month}-01T09:00:00+01:00`,
      text: "Árvíztűrő tükörfúrógép: őszi akció, csak ma!",
      targets: both.map((id) => ({ social_account_id: id })),
      pillar: "Akció",
    },
    {
      suggested_at: `${month}-08T18:30:00+01:00`,
      text: 'Hétvégi tipp; "kávé, könyv, pihenés".\nÍrd meg kommentben a tiédet!',
      targets: [{ social_account_id: first }],
      media_urls: ["https://example.com/kepek/kave.jpg"],
      pillar: "Tippek",
    },
  ];
}

export function sampleJson(accountIds: string[], month?: string) {
  return `${JSON.stringify({ drafts: sampleDrafts(accountIds, month) }, null, 2)}\n`;
}

export function sampleCsv(accountIds: string[], month?: string) {
  const rows = sampleDrafts(accountIds, month).map((draft) =>
    [
      draft.suggested_at,
      draft.text,
      draft.targets.map((t) => t.social_account_id).join(listSeparator),
      (draft.media_urls ?? []).join(listSeparator),
      draft.pillar,
    ]
      .map(csvCell)
      .join(";"),
  );
  return `﻿${[csvColumns.join(";"), ...rows].join("\r\n")}\r\n`;
}
