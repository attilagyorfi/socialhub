// Reply templates: plain text with one optional placeholder, {név}, for the
// commenter's name. Nothing here sends anything; the result is only a draft.
export const REPLY_TEMPLATE_LIMIT = 100;
export const REPLY_TEMPLATE_NAME_MAX = 80;
export const REPLY_MAX_LENGTH = 2000;

// Horizontal whitespace, and the placeholder in either Unicode form of "é".
const H = "[^\\S\\r\\n]*";
const NAME = "\\{n(?:é|e\\u0301)v\\}";
const namePattern = new RegExp(NAME, "gu");
const emptyNamePattern = new RegExp(
  `(,?)(${H})${NAME}(?:${H},?${H}${NAME})*(${H})(,?)(${H})`,
  "gu",
);

// The commenter's name as one line of plain text; "" when nothing is visible.
function plainName(authorName: string | null | undefined) {
  const name = (authorName ?? "")
    // Control characters, and the invisible marks that reorder text.
    .replace(/[\s\p{Cc}​‎‏‪-‮⁠-⁩]+/gu, " ")
    .trim();
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(name) ? name : "";
}

function withoutName(
  _match: string,
  beforeComma: string,
  beforeSpace: string,
  afterSpace: string,
  afterComma: string,
  afterCommaSpace: string,
  ...rest: unknown[]
) {
  const source = rest[1] as string;
  const offset = rest[0] as number;
  const previous = Array.from(source.slice(0, offset)).at(-1) ?? "\n";
  const next =
    Array.from(
      source.slice(offset + _match.length, offset + _match.length + 2),
    ).at(0) ?? "\n";
  const lineEnd = /[\r\n]/.test(next);
  const closing = /[.!?…:;)\]}”’»]/u.test(next);
  const gap = afterSpace || afterCommaSpace;
  // "Szia, {név}!" → "Szia!", but "Szia, {név}, köszi" → "Szia, köszi".
  if (beforeComma) {
    if (afterComma) return afterComma + afterCommaSpace;
    if (lineEnd) return "";
    if (/[\p{L}\p{N}\p{Ps}\p{Pi}"'@#]/u.test(next))
      return beforeComma + (gap || beforeSpace);
    return closing ? afterSpace : gap || beforeSpace;
  }
  // A line or sentence starting with the name: the comma after it goes too.
  if (/[\r\n]/.test(previous)) return "";
  if (!/[\p{L}\p{N}\p{M})\]”’'%]/u.test(previous)) {
    if (lineEnd || closing) return "";
    return beforeSpace || (/[\p{Ps}\p{Pi}]/u.test(previous) ? "" : gap);
  }
  if (afterComma) return afterComma + afterCommaSpace;
  if (lineEnd) return "";
  if (afterSpace) return afterSpace;
  return closing ? "" : beforeSpace;
}

// One pass with a function replacement, so "$&" or "{név}" inside a name
// stays literal text.
export function renderReplyTemplate(
  body: string,
  authorName: string | null | undefined,
) {
  const name = plainName(authorName);
  return name
    ? body.replace(namePattern, () => name)
    : body.replace(emptyNamePattern, withoutName);
}

// Adds text to a draft at the caret, or at its end when the caret is not
// known. Never removes anything; null when the result would be too long.
export function insertIntoDraft(
  draft: string,
  text: string,
  caret: number | null,
): { value: string; caret: number } | null {
  // Text fields count a line break as one character.
  const inserted = text.replace(/\r\n?/g, "\n");
  let at =
    caret === null || !Number.isFinite(caret)
      ? draft.length
      : Math.min(Math.max(Math.trunc(caret), 0), draft.length);
  // Never between the two halves of one character (emoji).
  if (
    /[\ud800-\udbff]/.test(draft.charAt(at - 1)) &&
    /[\udc00-\udfff]/.test(draft.charAt(at))
  )
    at++;
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = /[^\s([{„“"]$/u.test(before) && /^\S/.test(inserted) ? " " : "";
  const trail = /^[\p{L}\p{N}]/u.test(after) && /\S$/.test(inserted) ? " " : "";
  const value = before + lead + inserted + trail + after;
  if (value.length > REPLY_MAX_LENGTH) return null;
  return { value, caret: at + lead.length + inserted.length };
}
