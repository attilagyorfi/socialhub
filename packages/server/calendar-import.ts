import type { z } from "zod";
import { pool } from "../db";
import {
  importFormat,
  maxImportBytes,
  maxImportRows,
  parseCalendarImport,
  type ImportError,
  type ImportFormat,
} from "../core/calendar-import";
import { AppError } from "../core/security";
import {
  checkDrafts,
  DraftIssuesError,
  draftsInputWithMax,
  duplicateTargetIssues,
  insertDrafts,
  maxMediaUrlsPerDraft,
  maxTargetsPerDraft,
  type DraftInput,
  type DraftIssue,
} from "./api-v1-posts";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";

// Calendar import from the UI: the same drafts schema and creation core as
// POST /api/v1/clients/{id}/drafts, with Hungarian row-level messages.

export type PreviewRow = {
  line: number;
  suggested_at: string | null;
  targets: string[];
  text: string;
  errors: string[];
};
export type ImportPreview = {
  fileName: string;
  format: ImportFormat;
  rows: PreviewRow[];
  errors: ImportError[];
  ok: boolean;
};

export class ImportInvalidError extends AppError {
  constructor(readonly preview: ImportPreview) {
    super(
      422,
      "IMPORT_INVALID",
      "A fájlban hibák vannak, ezért semmit sem importáltunk.",
    );
  }
}

// Stored in the audit log and echoed back; never the file's content.
export function cleanFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
}

const datetimeExample = "2026-12-01T09:00:00+01:00";

// Hungarian text for an issue of the shared (English) drafts schema.
export function issueMessage(issue: z.core.$ZodIssue) {
  const field = issue.path.slice(2);
  const [name] = field;
  if (issue.code === "unrecognized_keys")
    return `Ismeretlen mező: ${issue.keys.join(", ")}.`;
  if (name === "text")
    return issue.code === "too_big"
      ? "A szöveg (text) túl hosszú."
      : "A szöveg (text) kötelező.";
  if (name === "targets") {
    if (field.length === 1)
      return issue.code === "too_big"
        ? `Legfeljebb ${maxTargetsPerDraft} célfiókot adhatsz meg (targets).`
        : "Adj meg legalább egy célfiókot (targets).";
    if (field[2] === "text")
      return "A célfiók saját szövege nem lehet üres vagy túl hosszú.";
    return "A célfiók azonosítója (targets) nem érvényes azonosító.";
  }
  if (name === "suggested_at")
    return `Hibás dátum (suggested_at). Időzónával add meg, például: ${datetimeExample}.`;
  if (name === "media_urls")
    return issue.code === "too_big" && field.length === 1
      ? `Legfeljebb ${maxMediaUrlsPerDraft} média-URL-t adhatsz meg.`
      : "A média-URL-nek https:// kezdetű linknek kell lennie (media_urls).";
  if (name === "pillar")
    return "A pillér (pillar) nem lehet üres, és legfeljebb 100 karakter.";
  if (field.length === 0) return "A sornak objektumnak kell lennie.";
  return `Hibás mező: ${field.join(".")}.`;
}

export function draftIssueMessage(issue: DraftIssue) {
  if (issue.code === "DUPLICATE_TARGET")
    return "Egy célfiók egy soron belül csak egyszer szerepelhet.";
  if (issue.code === "ACCOUNT_NOT_FOUND")
    return `Nincs ilyen célfiók ennél az ügyfélnél: ${issue.accountId}.`;
  return `A(z) ${issue.accountId} célfiók nincs csatlakoztatva. Előbb csatlakoztasd újra.`;
}

type ValidatedImport = {
  preview: ImportPreview;
  // Drafts that passed the schema, with their preview row.
  valid: { row: PreviewRow; draft: DraftInput }[];
};

const excerpt = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 80)
    : "";

// Everything that needs no database: size, format, encoding, parsing and the
// shared schema. Size is checked on the raw bytes, before decoding.
export function validateImportFile(
  bytes: Uint8Array,
  name: string,
): ValidatedImport {
  if (bytes.byteLength > maxImportBytes)
    throw new AppError(
      413,
      "IMPORT_TOO_LARGE",
      "A fájl túl nagy: legfeljebb 1 MB lehet.",
    );
  const fileName = cleanFileName(name);
  const format = importFormat(fileName);
  if (!format)
    throw new AppError(
      422,
      "IMPORT_FORMAT",
      "Csak .csv vagy .json fájlt tölthetsz fel.",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(
      422,
      "IMPORT_ENCODING",
      "A fájl nem UTF-8 kódolású. Mentsd el UTF-8-ként (Excelben: CSV UTF-8), és próbáld újra.",
    );
  }
  const parsed = parseCalendarImport(text, format);
  if (parsed.rows.length > maxImportRows)
    throw new AppError(
      422,
      "IMPORT_TOO_MANY_ROWS",
      `Egyszerre legfeljebb ${maxImportRows} sort importálhatsz, a fájlban ${parsed.rows.length} van.`,
    );
  const errors = [...parsed.errors];
  if (!parsed.rows.length && !errors.length)
    errors.push({ line: 0, message: "A fájlban nincs importálható sor." });

  const rows: PreviewRow[] = parsed.rows.map(({ line, draft }) => {
    const object = draft && typeof draft === "object" ? draft : {};
    const targets = Array.isArray(object.targets) ? object.targets : [];
    return {
      line,
      suggested_at:
        typeof object.suggested_at === "string" ? object.suggested_at : null,
      targets: targets.map((t) =>
        String((t as { social_account_id?: unknown })?.social_account_id ?? ""),
      ),
      text: excerpt(object.text),
      // The import marks every post itself; a row's own label would be lost.
      errors:
        "source" in object
          ? [
              "Importnál a forrást a rendszer tölti ki, hagyd ki a source mezőt.",
            ]
          : [],
    };
  });
  const result = draftsInputWithMax(maxImportRows).safeParse({
    drafts: parsed.rows.map((row) => row.draft),
  });
  if (!result.success)
    for (const issue of result.error.issues) {
      const index = issue.path[1];
      if (issue.path[0] === "drafts" && typeof index === "number") {
        const message = issueMessage(issue);
        if (!rows[index].errors.includes(message))
          rows[index].errors.push(message);
      } else if (rows.length && !errors.length)
        errors.push({ line: 0, message: "A fájl szerkezete hibás." });
    }
  const valid = result.success
    ? result.data.drafts.map((draft, index) => ({ row: rows[index], draft }))
    : rows.flatMap((row, index) => {
        const draft = draftsInputWithMax(1).safeParse({
          drafts: [parsed.rows[index].draft],
        });
        return draft.success ? [{ row, draft: draft.data.drafts[0] }] : [];
      });
  for (const issue of duplicateTargetIssues(valid.map((v) => v.draft)))
    valid[issue.index].row.errors.push(draftIssueMessage(issue));
  return {
    preview: {
      fileName,
      format,
      rows,
      errors,
      ok: false,
    },
    valid,
  };
}

const finish = (preview: ImportPreview): ImportPreview => ({
  ...preview,
  ok: !preview.errors.length && preview.rows.every((r) => !r.errors.length),
});

function addIssues(validated: ValidatedImport, issues: DraftIssue[]) {
  for (const issue of issues) {
    // Duplicates were already reported without the database.
    if (issue.code === "DUPLICATE_TARGET") continue;
    validated.valid[issue.index].row.errors.push(draftIssueMessage(issue));
  }
}

const scopeOf = (c: Context) => ({
  organizationId: c.organizationId,
  clientId: c.clientId,
  userId: c.userId,
});

// What the import would create, and every error by line. Writes nothing.
export async function previewCalendarImport(
  c: Context,
  file: { name: string; bytes: Uint8Array },
) {
  const validated = validateImportFile(file.bytes, file.name);
  addIssues(
    validated,
    await checkDrafts(
      pool,
      scopeOf(c),
      validated.valid.map((v) => v.draft),
    ),
  );
  return finish(validated.preview);
}

// Re-reads the raw file; never trusts the client's preview. All drafts and
// their audit events commit together, or none when any row has an error.
export async function importCalendar(
  c: Context,
  file: { name: string; bytes: Uint8Array },
) {
  const validated = validateImportFile(file.bytes, file.name);
  const preview = finish(validated.preview);
  if (!preview.ok) {
    addIssues(
      validated,
      await checkDrafts(
        pool,
        scopeOf(c),
        validated.valid.map((v) => v.draft),
      ),
    );
    throw new ImportInvalidError(finish(validated.preview));
  }
  const drafts = validated.valid.map((v) => v.draft);
  try {
    return await transaction(async (tx) => {
      const ids = await insertDrafts(tx, scopeOf(c), drafts, {
        source: "import",
        audit: { file_name: preview.fileName },
      });
      await audit(tx, c, "calendar.imported", c.clientId, {
        file_name: preview.fileName,
        format: preview.format,
        rows: ids.length,
      });
      return { created: ids.length, ids };
    });
  } catch (error) {
    if (!(error instanceof DraftIssuesError)) throw error;
    addIssues(validated, error.issues);
    throw new ImportInvalidError(finish(validated.preview));
  }
}
