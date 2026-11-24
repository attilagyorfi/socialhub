import { describe, expect, it } from "vitest";
import {
  detectDelimiter,
  importFormat,
  parseCalendarImport,
  parseCsv,
  sampleCsv,
  sampleJson,
} from "../packages/core/calendar-import";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const header = "suggested_at,text,targets,media_urls,pillar";

describe("CSV reading", () => {
  it("handles quotes, escapes, embedded line breaks, CRLF and LF", () => {
    const text = 'x,"a, ""b""; c"\r\n"two\r\nlines",z\ny,"\n"\n';
    const { records } = parseCsv(text, ",");
    expect(records).toEqual([
      { line: 1, cells: ["x", 'a, "b"; c'] },
      { line: 2, cells: ["two\nlines", "z"] },
      { line: 4, cells: ["y", "\n"] },
    ]);
  });

  it("detects the delimiter from the header", () => {
    expect(detectDelimiter("suggested_at;text;targets\n1,2,3,4")).toBe(";");
    expect(detectDelimiter(`${header}\n1;2;3`)).toBe(",");
    expect(detectDelimiter('"a;b;c",text\n')).toBe(",");
  });

  it("reports an unterminated quote at the line where it opened", () => {
    const { error } = parseCsv('a,b\nc,"never\nclosed', ",");
    expect(error?.line).toBe(2);
  });
});

describe("calendar import parsing", () => {
  it("maps CSV columns to the API drafts body, with BOM and accents", () => {
    const text = `﻿${header}\r\n2026-12-01T09:00:00+01:00,"Árvíztűrő tükörfúrógép, őszi akció; ma!",${a}|${b},https://example.com/a.jpg|https://example.com/b.jpg,Akció\r\n`;
    const parsed = parseCalendarImport(text, "csv");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        draft: {
          suggested_at: "2026-12-01T09:00:00+01:00",
          text: "Árvíztűrő tükörfúrógép, őszi akció; ma!",
          targets: [{ social_account_id: a }, { social_account_id: b }],
          media_urls: [
            "https://example.com/a.jpg",
            "https://example.com/b.jpg",
          ],
          pillar: "Akció",
        },
      },
    ]);
  });

  it("reads semicolon files from Hungarian Excel and keeps physical line numbers", () => {
    const text = [
      "text;targets",
      `"Első sor\nmásodik sor";${a}`,
      "",
      `"Idézet: ""szia""";${b}`,
    ].join("\n");
    const parsed = parseCalendarImport(text, "csv");
    expect(parsed.rows.map((r) => [r.line, r.draft.text])).toEqual([
      [2, "Első sor\nmásodik sor"],
      [5, 'Idézet: "szia"'],
    ]);
  });

  it("omits empty optional cells", () => {
    const parsed = parseCalendarImport(`${header}\n,Szöveg,${a},,\n`, "csv");
    expect(parsed.rows[0].draft).toEqual({
      text: "Szöveg",
      targets: [{ social_account_id: a }],
    });
  });

  it("rejects a missing required column on the header line", () => {
    const parsed = parseCalendarImport("suggested_at,text\nx,y\n", "csv");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([
      { line: 1, message: "Hiányzó kötelező oszlop: targets." },
    ]);
  });

  it("rejects unknown columns and rows wider than the header", () => {
    expect(
      parseCalendarImport("text,targets,caption\n", "csv").errors[0].message,
    ).toMatch(/Ismeretlen oszlop: caption/);
    const wide = parseCalendarImport(`text,targets\nSzia, világ,${a}\n`, "csv");
    expect(wide.errors[0]).toMatchObject({ line: 2 });
    expect(wide.errors[0].message).toMatch(/idézőjelbe/);
  });

  it("numbers JSON drafts by array position", () => {
    const parsed = parseCalendarImport(
      `﻿${JSON.stringify({ drafts: [{ text: "a" }, { text: "b" }] })}`,
      "json",
    );
    expect(parsed.rows.map((r) => r.line)).toEqual([1, 2]);
    expect(parseCalendarImport("{", "json").errors[0].message).toBe(
      "A fájl nem érvényes JSON.",
    );
    expect(parseCalendarImport("[]", "json").errors).toHaveLength(1);
  });

  it("recognizes the file format from the name", () => {
    expect(importFormat("December.CSV")).toBe("csv");
    expect(importFormat("naptar.json")).toBe("json");
    expect(importFormat("naptar.xlsx")).toBeNull();
  });
});

describe("sample files", () => {
  it("parse back to the same drafts in both formats", () => {
    const csv = sampleCsv([a, b]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Árvíztűrő tükörfúrógép");
    const fromCsv = parseCalendarImport(csv, "csv");
    const fromJson = parseCalendarImport(sampleJson([a, b]), "json");
    expect(fromCsv.errors).toEqual([]);
    expect(fromJson.errors).toEqual([]);
    expect(fromCsv.rows.map((r) => r.draft)).toEqual(
      fromJson.rows.map((r) => r.draft),
    );
    expect(fromCsv.rows.map((r) => r.line)).toEqual([2, 3]);
  });
});
