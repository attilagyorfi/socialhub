import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { DateTime } from "luxon";
import { PDFDocument, type PDFFont, type PDFImage, rgb } from "pdf-lib";
import { pool } from "../db";
import {
  type CalendarPdfDocument,
  type CalendarPdfEntry,
  printable,
  wrapText,
} from "../core/calendar-pdf";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { readStoredObject } from "./media";

// Calendar export, second layer: data from the database and the PDF drawing.
// Pure JavaScript (pdf-lib + fontkit) with an embedded DejaVu Sans, so it
// runs the same in the Docker image and on Vercel; no headless browser.

export const maxExportDays = 93;
export const maxExportPosts = 300;
const maxThumbnailBytes = 5 * 1024 * 1024;
const maxThumbnailTotalBytes = 40 * 1024 * 1024;

export const fontFiles = {
  regular: "DejaVuSans.ttf",
  bold: "DejaVuSans-Bold.ttf",
};

// Where the font may be at run time: the repository root in development and
// tests, and next to the traced packages/ folder when the server runs from
// apps/web (standalone Docker image, Vercel). next.config.ts traces the
// folder into both builds (outputFileTracingIncludes).
export function fontDirectoryCandidates(cwd = process.cwd()) {
  return [
    path.join(cwd, "packages", "server", "fonts"),
    path.join(cwd, "..", "..", "packages", "server", "fonts"),
  ];
}

export function fontDirectory(cwd = process.cwd()) {
  const found = fontDirectoryCandidates(cwd).find((dir) =>
    existsSync(path.join(dir, fontFiles.regular)),
  );
  if (!found) throw new Error("The PDF font is missing from the build.");
  return found;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export type ExportInput = {
  from: DateTime;
  to: DateTime; // exclusive
  timeZone: string;
  locale: "hu" | "en";
  t: Translate;
};

type ExportRow = {
  id: string;
  status: string;
  scheduled_at: Date;
  caption: string;
  approval: string | null;
  targets: {
    platform: string;
    name: string;
    caption: string;
    firstComment: string | null;
    mediaIds: string[];
  }[];
};

// Parses an inclusive YYYY-MM-DD period in the user's time zone.
export function exportPeriod(
  from: string | null,
  to: string | null,
  timeZone: string,
) {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const start = DateTime.fromISO(from ?? "", { zone: timeZone }).startOf("day");
  const last = DateTime.fromISO(to ?? "", { zone: timeZone }).startOf("day");
  if (
    !pattern.test(from ?? "") ||
    !pattern.test(to ?? "") ||
    !start.isValid ||
    !last.isValid ||
    last < start ||
    last.diff(start, "days").days + 1 > maxExportDays
  )
    throw new AppError(
      400,
      "INVALID_RANGE",
      `Choose a period of at most ${maxExportDays} days that ends after it starts.`,
    );
  return { from: start, to: last.plus({ days: 1 }) };
}

async function exportRows(c: Context, input: ExportInput) {
  return (
    await pool.query(
      `SELECT p.id,p.status,p.scheduled_at,p.caption,
         (SELECT CASE WHEN r.status='PENDING' AND r.expires_at<=now()
                   THEN 'EXPIRED' ELSE r.status END
          FROM approval_requests r WHERE r.post_id=p.id
          ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS approval,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
             'platform',a.platform,'name',a.name,'caption',t.caption,
             'firstComment',t.first_comment,'mediaIds',t.media_ids)
           ORDER BY t.created_at,t.id)
          FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
          WHERE t.post_id=p.id),'[]'::jsonb) AS targets
       FROM posts p
       WHERE p.organization_id=$1 AND p.client_id=$2 AND p.deleted_at IS NULL
         AND p.scheduled_at>=$3 AND p.scheduled_at<$4
       ORDER BY p.scheduled_at,p.id LIMIT $5`,
      [
        c.organizationId,
        c.clientId,
        input.from.toJSDate(),
        input.to.toJSDate(),
        maxExportPosts + 1,
      ],
    )
  ).rows as ExportRow[];
}

// Thumbnails come only from the app's own storage: the JPEG preview of a
// processed asset, or the original when it is a small JPEG or PNG. Anything
// else (WebP, video without preview, missing objects) is left out.
async function thumbnailKeys(c: Context, rows: ExportRow[]) {
  const first = new Map<string, string>();
  for (const row of rows) {
    const id = row.targets.find((target) => target.mediaIds?.length)
      ?.mediaIds[0];
    if (id) first.set(row.id, id);
  }
  if (!first.size) return new Map<string, string>();
  const assets = (
    await pool.query(
      `SELECT id,mime_type,size_bytes,object_key,preview_object_key
       FROM media_assets
       WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])
         AND status='READY' AND deleted_at IS NULL`,
      [c.organizationId, c.clientId, [...new Set(first.values())]],
    )
  ).rows;
  const keys = new Map<string, string>();
  for (const asset of assets) {
    if (asset.preview_object_key) keys.set(asset.id, asset.preview_object_key);
    else if (
      ["image/jpeg", "image/png"].includes(asset.mime_type) &&
      Number(asset.size_bytes) <= maxThumbnailBytes
    )
      keys.set(asset.id, asset.object_key);
  }
  return new Map(
    [...first].flatMap(([post, media]) =>
      keys.has(media) ? [[post, keys.get(media)!] as const] : [],
    ),
  );
}

export async function calendarPdfDocument(
  c: Context,
  input: ExportInput,
): Promise<CalendarPdfDocument> {
  const { t, locale, timeZone } = input;
  const intl = locale === "hu" ? "hu-HU" : "en-GB";
  const client = (
    await pool.query(
      "SELECT name FROM clients WHERE organization_id=$1 AND id=$2",
      [c.organizationId, c.clientId],
    )
  ).rows[0];
  const rows = await exportRows(c, input);
  const truncated = rows.length > maxExportPosts;
  const shown = rows.slice(0, maxExportPosts);
  const thumbnails = await thumbnailKeys(c, shown);
  const day = (value: DateTime) =>
    value.setZone(timeZone).setLocale(intl).toLocaleString(DateTime.DATE_FULL);
  const entries: CalendarPdfEntry[] = shown.map((row) => ({
    date: DateTime.fromJSDate(new Date(row.scheduled_at))
      .setZone(timeZone)
      .setLocale(intl)
      .toLocaleString(DateTime.DATETIME_MED_WITH_WEEKDAY),
    status: t(`common.status.${row.status}`),
    approval: row.approval
      ? t(`common.status.${row.approval}`)
      : t("calendar.pdf.noApproval"),
    targets: row.targets.length
      ? row.targets.map((target) => ({
          channel: `${t(`common.network.${target.platform}`)} · ${target.name}`,
          caption: target.caption,
          firstComment: target.firstComment?.trim()
            ? target.firstComment
            : null,
        }))
      : [{ channel: "–", caption: row.caption, firstComment: null }],
    thumbnail: thumbnails.get(row.id) ?? null,
  }));
  return {
    locale,
    clientName: client?.name ?? "",
    period: `${day(input.from)} – ${day(input.to.minus({ days: 1 }))}`,
    generated: DateTime.now()
      .setZone(timeZone)
      .setLocale(intl)
      .toLocaleString(DateTime.DATETIME_MED),
    labels: {
      title: t("calendar.pdf.title"),
      period: t("calendar.pdf.period"),
      generated: t("calendar.pdf.generated"),
      channel: t("calendar.pdf.channel"),
      firstComment: t("calendar.pdf.firstComment"),
      status: t("calendar.pdf.status"),
      approval: t("calendar.pdf.approval"),
      empty: t("calendar.pdf.empty"),
      truncated: t("calendar.pdf.truncated", { count: maxExportPosts }),
      page: t("calendar.pdf.page"),
    },
    entries,
    truncated,
  };
}

const page = { width: 595.28, height: 841.89, margin: 48 };
const thumb = 72;
const gap = 12;
const ink = rgb(0.11, 0.13, 0.16);
const muted = rgb(0.38, 0.42, 0.47);
const rule = rgb(0.85, 0.87, 0.89);

function isJpeg(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
function isPng(bytes: Uint8Array) {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

// Draws the document. `loadImage` returns stored bytes for a thumbnail key;
// failures and unsupported formats only drop that thumbnail.
export async function renderCalendarPdf(
  doc: CalendarPdfDocument,
  loadImage: (key: string) => Promise<Uint8Array>,
  fonts = fontDirectory(),
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(path.join(fonts, fontFiles.regular)),
    readFile(path.join(fonts, fontFiles.bold)),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const glyphs = fontkit.create(regularBytes);
  const clean = (text: string) =>
    printable(text, (code) => glyphs.hasGlyphForCodePoint(code));
  pdf.setTitle(`${doc.labels.title} – ${clean(doc.clientName)}`);
  pdf.setLanguage(doc.locale === "hu" ? "hu-HU" : "en-GB");
  pdf.setCreator("SocialHub");

  const images = new Map<string, PDFImage | null>();
  let imageBytes = 0;
  async function image(key: string) {
    if (images.has(key)) return images.get(key)!;
    let embedded: PDFImage | null = null;
    try {
      if (imageBytes < maxThumbnailTotalBytes) {
        const bytes = await loadImage(key);
        if (bytes.length <= maxThumbnailBytes) {
          imageBytes += bytes.length;
          embedded = isJpeg(bytes)
            ? await pdf.embedJpg(bytes)
            : isPng(bytes)
              ? await pdf.embedPng(bytes)
              : null;
        }
      }
    } catch {
      embedded = null;
    }
    images.set(key, embedded);
    return embedded;
  }

  const width = page.width - page.margin * 2;
  let current = pdf.addPage([page.width, page.height]);
  let y = page.height - page.margin;
  const newPage = () => {
    current = pdf.addPage([page.width, page.height]);
    y = page.height - page.margin;
  };
  const write = (
    text: string,
    options: {
      x: number;
      width: number;
      size: number;
      font?: PDFFont;
      color?: typeof ink;
    },
  ) => {
    const font = options.font ?? regular;
    const lineHeight = options.size * 1.35;
    for (const line of wrapText(clean(text), options.width, (value) =>
      font.widthOfTextAtSize(value, options.size),
    )) {
      if (y - lineHeight < page.margin) newPage();
      y -= lineHeight;
      current.drawText(line, {
        x: options.x,
        y: y + options.size * 0.25,
        size: options.size,
        font,
        color: options.color ?? ink,
      });
    }
  };

  write(doc.labels.title, { x: page.margin, width, size: 18, font: bold });
  write(doc.clientName, { x: page.margin, width, size: 13, font: bold });
  write(`${doc.labels.period}: ${doc.period}`, {
    x: page.margin,
    width,
    size: 10.5,
  });
  write(`${doc.labels.generated}: ${doc.generated}`, {
    x: page.margin,
    width,
    size: 8.5,
    color: muted,
  });
  y -= gap;
  if (!doc.entries.length)
    write(doc.labels.empty, {
      x: page.margin,
      width,
      size: 10.5,
      color: muted,
    });

  for (const entry of doc.entries) {
    // Keep at least the date line and the thumbnail together.
    if (y - Math.min(thumb, 60) - gap < page.margin) newPage();
    current.drawLine({
      start: { x: page.margin, y: y - 2 },
      end: { x: page.width - page.margin, y: y - 2 },
      thickness: 0.5,
      color: rule,
    });
    y -= gap;
    const top = y;
    const picture = entry.thumbnail ? await image(entry.thumbnail) : null;
    const textX = picture ? page.margin + thumb + gap : page.margin;
    const textWidth = page.width - page.margin - textX;
    if (picture) {
      const size = picture.scaleToFit(thumb, thumb);
      current.drawImage(picture, {
        x: page.margin + (thumb - size.width) / 2,
        y: top - size.height,
        width: size.width,
        height: size.height,
      });
    }
    const entryPage = current;
    write(entry.date, { x: textX, width: textWidth, size: 11, font: bold });
    write(
      `${doc.labels.status}: ${entry.status} · ${doc.labels.approval}: ${entry.approval}`,
      { x: textX, width: textWidth, size: 9, color: muted },
    );
    for (const target of entry.targets) {
      y -= 3;
      write(`${doc.labels.channel}: ${target.channel}`, {
        x: textX,
        width: textWidth,
        size: 9.5,
        font: bold,
      });
      write(target.caption, { x: textX, width: textWidth, size: 9.5 });
      if (target.firstComment)
        write(`${doc.labels.firstComment}: ${target.firstComment}`, {
          x: textX,
          width: textWidth,
          size: 9,
          color: muted,
        });
    }
    // Leave room below a thumbnail taller than the text beside it.
    if (picture && current === entryPage) y = Math.min(y, top - thumb);
    y -= gap;
  }
  if (doc.truncated)
    write(doc.labels.truncated, {
      x: page.margin,
      width,
      size: 9,
      color: muted,
    });

  const pages = pdf.getPages();
  pages.forEach((item, index) => {
    const label = `${doc.labels.page} ${index + 1} / ${pages.length}`;
    item.drawText(label, {
      x: page.width - page.margin - regular.widthOfTextAtSize(label, 8),
      y: page.margin / 2,
      size: 8,
      font: regular,
      color: muted,
    });
  });
  return pdf.save();
}

export async function exportCalendarPdf(c: Context, input: ExportInput) {
  const doc = await calendarPdfDocument(c, input);
  return {
    clientName: doc.clientName,
    bytes: await renderCalendarPdf(
      doc,
      async (key) => new Uint8Array(await readStoredObject(key)),
    ),
  };
}
