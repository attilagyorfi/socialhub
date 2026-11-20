// Calendar export, first layer: a plain document model (texts already
// translated and formatted) and the line wrapping used to lay it out. The
// PDF renderer in packages/server/calendar-pdf.ts only draws this model.

export type CalendarPdfLabels = {
  title: string;
  period: string;
  generated: string;
  channel: string;
  firstComment: string;
  status: string;
  approval: string;
  empty: string;
  truncated: string;
  page: string;
};

export type CalendarPdfTarget = {
  channel: string;
  caption: string;
  firstComment: string | null;
};

export type CalendarPdfEntry = {
  date: string;
  status: string;
  approval: string;
  targets: CalendarPdfTarget[];
  // Reference to an image in the app's own storage, resolved by the renderer.
  thumbnail: string | null;
};

export type CalendarPdfDocument = {
  locale: "hu" | "en";
  clientName: string;
  period: string;
  generated: string;
  labels: CalendarPdfLabels;
  entries: CalendarPdfEntry[];
  truncated: boolean;
};

// Greedy word wrap. Paragraph breaks are kept; a word wider than the line is
// split between characters, so no text runs past the margin.
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let rest = word;
      while (measure(rest) > maxWidth) {
        const chars = [...rest];
        let fit = 1;
        while (
          fit < chars.length &&
          measure(chars.slice(0, fit + 1).join("")) <= maxWidth
        )
          fit++;
        lines.push(chars.slice(0, fit).join(""));
        rest = chars.slice(fit).join("");
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// Drops control characters and anything the embedded font cannot draw
// (e.g. emoji), so the PDF shows no empty boxes.
export function printable(text: string, hasGlyph: (code: number) => boolean) {
  let result = "";
  for (const char of text.replace(/\t/g, " ")) {
    const code = char.codePointAt(0)!;
    if (char === "\n" || (code >= 0x20 && code !== 0x7f && hasGlyph(code)))
      result += char;
  }
  return result;
}
