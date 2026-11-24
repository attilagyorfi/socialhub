import { PGlite } from "@electric-sql/pglite";
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PGlite();

vi.mock("../packages/db", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { sql } = await import("drizzle-orm");
  const query = (text: string, params?: unknown[]) => db.query(text, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
    db: drizzle({ client: db }),
    sql,
  };
});
// The session is the user ID in a test header.
vi.mock("../packages/server/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-user");
        return id ? { user: { id } } : null;
      },
    },
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: async () => true,
}));
// Stored objects by key; nothing outside this map can be read.
const objects = new Map<string, Uint8Array>();
const readStoredObject = vi.fn(async (key: string) => {
  const bytes = objects.get(key);
  if (!bytes) throw new Error("missing");
  return Buffer.from(bytes);
});
vi.mock("../packages/server/media", async (original) => ({
  ...(await original<typeof import("../packages/server/media")>()),
  readStoredObject: (key: string) => readStoredObject(key),
}));

const { GET } = await import("../apps/web/app/api/calendar/export/route");
const { renderCalendarPdf, fontDirectory, fontDirectoryCandidates, fontFiles } =
  await import("../packages/server/calendar-pdf");
const { wrapText, printable } = await import("../packages/core/calendar-pdf");
const { translate } = await import("../apps/web/i18n/core");
const { default: nextConfig } = await import("../apps/web/next.config");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = "Árvíztűrő tükörfúrógép";

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function pdfText(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
  }).promise;
  const pages: string[] = [];
  let images = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join("\n"),
    );
    const ops = await page.getOperatorList();
    images += ops.fnArray.filter(
      (fn) => fn === pdfjs.OPS.paintImageXObject,
    ).length;
  }
  return { text: pages.join("\n"), pages: doc.numPages, images };
}

async function member(org: string, role = "OWNER") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO "user"(id,name,email,locale,timezone) VALUES($1,'Member',$2,NULL,'Europe/Budapest')`,
    [id, `${id}@example.test`],
  );
  await db.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
    [org, id, role],
  );
  return id;
}

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    account = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Tükör Kávézó')",
    [client, org],
  );
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
     VALUES($1,$2,$3,'instagram','Tükör IG','ig-1','mock')`,
    [account, org, client],
  );
  return { org, client, account, owner: await member(org) };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function media(w: Workspace, mime: string, bytes: Uint8Array) {
  const id = crypto.randomUUID();
  const key = `${w.org}/${w.client}/${id}`;
  objects.set(key, bytes);
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
     VALUES($1,$2,$3,'file',$4,$5,$6,'READY')`,
    [id, w.org, w.client, key, mime, bytes.length],
  );
  return id;
}

async function post(
  w: Workspace,
  caption: string,
  at: string,
  firstComment: string | null,
  mediaIds: string[] = [],
  approval?: string,
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,caption,status,scheduled_at) VALUES($1,$2,$3,$4,'SCHEDULED',$5)`,
    [id, w.org, w.client, caption, at],
  );
  await db.query(
    `INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids,status,first_comment)
     VALUES($1,$2,$3,$4,$5,$6,'SCHEDULED',$7)`,
    [w.org, w.client, id, w.account, caption, mediaIds, firstComment],
  );
  if (approval)
    await db.query(
      `INSERT INTO approval_requests(organization_id,client_id,post_id,revision,token_hash,expires_at,status)
       VALUES($1,$2,$3,1,$4,now()+interval '7 days',$5)`,
      [w.org, w.client, id, crypto.randomUUID(), approval],
    );
  return id;
}

function download(user: string | null, query: Record<string, string>) {
  return GET(
    new Request(
      `http://localhost:3010/api/calendar/export?${new URLSearchParams(query)}`,
      {
        headers: user ? { "x-test-user": user } : {},
      },
    ),
  );
}

describe("calendar PDF route", () => {
  it("requires a session and the caller's own client", async () => {
    const w = await workspace();
    const stranger = await workspace();
    const query = { clientId: w.client, from: "2026-12-01", to: "2026-12-31" };
    expect((await download(null, query)).status).toBe(401);
    expect((await download(stranger.owner, query)).status).toBe(404);
    expect(
      (await download(w.owner, { ...query, clientId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    const ok = await download(w.owner, query);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    const disposition = ok.headers.get("Content-Disposition")!;
    expect(disposition).toMatch(
      /^attachment; filename="[\x20-\x7e]+\.pdf"; filename\*=UTF-8''/,
    );
    expect(disposition).toContain(
      'filename="Tukor-Kavezo-2026-12-01-2026-12-31.pdf"',
    );
    expect(disposition).toContain(encodeURIComponent("Tükör Kávézó"));
  });

  it("rejects missing, malformed, reversed and too long periods", async () => {
    const w = await workspace();
    for (const range of [
      {} as Record<string, string>,
      { from: "2026-12-01" },
      { from: "december", to: "2026-12-31" },
      { from: "2026-12-31T00:00:00Z", to: "2027-01-31" },
      { from: "2026-12-31", to: "2026-12-01" },
      { from: "2026-12-01", to: "2027-03-04" }, // 94 days
    ]) {
      const response = await download(w.owner, {
        clientId: w.client,
        ...range,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("INVALID_RANGE");
    }
    expect(
      (
        await download(w.owner, {
          clientId: w.client,
          from: "2026-12-01",
          to: "2027-03-03",
        })
      ).status,
    ).toBe(200);
  });

  it("contains the header and every main field, with accents, in Hungarian and English", async () => {
    const w = await workspace();
    await post(
      w,
      sample,
      "2026-12-10T09:00:00Z",
      "Első komment: őszi ünnep",
      [],
      "APPROVED",
    );
    await post(w, "Outside the period", "2027-02-10T09:00:00Z", null);
    for (const locale of ["hu", "en"] as const) {
      const response = await download(w.owner, {
        clientId: w.client,
        from: "2026-12-01",
        to: "2026-12-31",
        locale,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      await PDFDocument.load(bytes);
      const { text } = await pdfText(bytes);
      const t = (key: Parameters<typeof translate>[1]) =>
        translate(locale, key);
      for (const expected of [
        t("calendar.pdf.title"),
        "Tükör Kávézó",
        t("calendar.pdf.period"),
        locale === "hu" ? "2026. december 1." : "1 December 2026",
        locale === "hu" ? "2026. december 31." : "31 December 2026",
        sample,
        "Első komment: őszi ünnep",
        t("calendar.pdf.firstComment"),
        `${t("calendar.pdf.channel")}: Instagram · Tükör IG`,
        `${t("calendar.pdf.status")}: ${t("common.status.SCHEDULED")} · ${t("calendar.pdf.approval")}: ${t("common.status.APPROVED")}`,
      ])
        expect(text).toContain(expected);
      expect(text).not.toContain("Outside the period");
    }
    expect(translate("hu", "calendar.pdf.title")).not.toBe(
      translate("en", "calendar.pdf.title"),
    );
  });

  it("embeds own JPEG and PNG thumbnails and skips other formats without failing", async () => {
    const w = await workspace();
    const jpeg = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#c33" },
    })
      .jpeg()
      .toBuffer();
    const png = await readFile(
      new URL("./fixtures/campaign.png", import.meta.url),
    );
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#3c3" },
    })
      .webp()
      .toBuffer();
    await post(w, "jpeg", "2026-12-01T09:00:00Z", null, [
      await media(w, "image/jpeg", jpeg),
    ]);
    await post(w, "png", "2026-12-02T09:00:00Z", null, [
      await media(w, "image/png", png),
    ]);
    await post(w, "webp", "2026-12-03T09:00:00Z", null, [
      await media(w, "image/webp", webp),
    ]);
    await post(w, "fake jpeg", "2026-12-04T09:00:00Z", null, [
      await media(w, "image/jpeg", new TextEncoder().encode("not an image")),
    ]);
    await post(w, "video", "2026-12-05T09:00:00Z", null, [
      await media(w, "video/mp4", new Uint8Array([1, 2, 3])),
    ]);
    const missing = await media(w, "image/png", new Uint8Array([1]));
    objects.delete(
      (
        await db.query<{ object_key: string }>(
          "SELECT object_key FROM media_assets WHERE id=$1",
          [missing],
        )
      ).rows[0].object_key,
    );
    await post(w, "missing", "2026-12-06T09:00:00Z", null, [missing]);
    readStoredObject.mockClear();
    const response = await download(w.owner, {
      clientId: w.client,
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(response.status).toBe(200);
    const { text, images } = await pdfText(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(images).toBe(2);
    for (const caption of [
      "jpeg",
      "png",
      "webp",
      "fake jpeg",
      "video",
      "missing",
    ])
      expect(text).toContain(caption);
    // Only stored keys of this client were read; WebP and video never were.
    for (const [key] of readStoredObject.mock.calls)
      expect(key.startsWith(`${w.org}/${w.client}/`)).toBe(true);
    expect(readStoredObject).toHaveBeenCalledTimes(4);
  });
});

describe("PDF layout", () => {
  it("wraps long words and paragraphs within the width", () => {
    const measure = (text: string) => text.length;
    expect(wrapText("aaa bbb ccc\n\ndddddddddd", 7, measure)).toEqual([
      "aaa bbb",
      "ccc",
      "",
      "ddddddd",
      "ddd",
    ]);
    expect(printable("a\tb😀c\u0007", (code) => code < 0x1f000)).toBe("a bc");
  });

  it("breaks long exports over pages and keeps every entry", async () => {
    const long = `${sample} `.repeat(120);
    const doc = {
      locale: "hu" as const,
      clientName: "Tükör Kávézó",
      period: "2026. december 1. – 2026. december 31.",
      generated: "ma",
      labels: {
        title: "Tartalomnaptár",
        period: "Időszak",
        generated: "Készült",
        channel: "Csatorna",
        firstComment: "Első komment",
        status: "Állapot",
        approval: "Jóváhagyás",
        empty: "Nincs poszt",
        truncated: "Csonkolva",
        page: "Oldal",
      },
      entries: Array.from({ length: 12 }, (_, index) => ({
        date: `Bejegyzés ${index + 1}`,
        status: "Ütemezett",
        approval: "Jóváhagyva",
        targets: [
          { channel: "Instagram", caption: long, firstComment: "Ő és Ű" },
        ],
        thumbnail: null,
      })),
      truncated: false,
    };
    const bytes = await renderCalendarPdf(doc, async () => new Uint8Array());
    const { text, pages } = await pdfText(bytes);
    expect(pages).toBeGreaterThan(3);
    expect(text).toContain("Bejegyzés 12");
    expect(text).toContain(`Oldal ${pages} / ${pages}`);
    // The caption was split into many lines, none wider than the page.
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(pages);
    expect(
      text.split("\n").filter((line) => line.includes("tükörfúrógép")).length,
    ).toBeGreaterThan(12 * 10);
  });
});

describe("PDF font packaging", () => {
  it("is traced into the build and found from the app directory", () => {
    const includes =
      nextConfig.outputFileTracingIncludes?.["/api/calendar/export"] ?? [];
    expect(includes).toEqual(["../../packages/server/fonts/*"]);
    // The glob is resolved from apps/web, the Next.js project root.
    const traced = path.resolve(
      root,
      "apps/web",
      includes[0].replace(/\*$/, ""),
    );
    const files = readdirSync(traced);
    expect(files).toEqual(
      expect.arrayContaining([
        fontFiles.regular,
        fontFiles.bold,
        "LICENSE-DejaVu.txt",
      ]),
    );
    // Standalone and Vercel run with apps/web as working directory.
    expect(fontDirectory(path.join(root, "apps/web"))).toBe(traced);
    expect(fontDirectory(root)).toBe(traced);
    expect(
      fontDirectoryCandidates("/nowhere").some((dir) => existsSync(dir)),
    ).toBe(false);
  });

  it("has the Hungarian long accents and an open licence", async () => {
    const dir = fontDirectory(root);
    for (const file of [fontFiles.regular, fontFiles.bold]) {
      const font = fontkit.create(await readFile(path.join(dir, file)));
      for (const char of "őűŐŰáéíóöúüÁÉÍÓÖÚÜ")
        expect(font.hasGlyphForCodePoint(char.codePointAt(0)!)).toBe(true);
    }
    const licence = await readFile(
      path.join(dir, "LICENSE-DejaVu.txt"),
      "utf8",
    );
    expect(licence).toContain("Bitstream Vera");
    expect(licence).toMatch(/Permission is hereby granted, free of charge/);
  });

  it("has no headless browser dependency", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps).toEqual(
      expect.arrayContaining(["pdf-lib", "@pdf-lib/fontkit", "pdfjs-dist"]),
    );
    expect(
      deps.filter((name) => /puppeteer|chromium|playwright-core/.test(name)),
    ).toEqual([]);
  });
});
