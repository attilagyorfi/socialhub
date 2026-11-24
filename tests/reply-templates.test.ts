import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ReplyTemplatePicker } from "../apps/web/components/reply-template-picker";
import { translate, type MessageKey } from "../apps/web/i18n/core";
import {
  insertIntoDraft,
  renderReplyTemplate,
  REPLY_MAX_LENGTH,
} from "../packages/core/reply-templates";

describe("reply template text", () => {
  it("puts the commenter's name in every place", () => {
    expect(renderReplyTemplate("Szia {név}!", "Anna")).toBe("Szia Anna!");
    expect(
      renderReplyTemplate("{név}, köszi! Szép napot, {név}!", "Anna"),
    ).toBe("Anna, köszi! Szép napot, Anna!");
    // The same placeholder typed with a combining accent.
    expect(renderReplyTemplate("Szia {név}!".normalize("NFD"), "Anna")).toBe(
      "Szia Anna!",
    );
    // Only this one placeholder exists.
    expect(renderReplyTemplate("{nev} {name} {NÉV} {{}}", "Anna")).toBe(
      "{nev} {name} {NÉV} {{}}",
    );
  });

  it.each(["$&", "$1 $$ $`", "{név}", '<b>Anna</b> & "Béla"', "Ünnep Őrs 👩‍👩‍👧"])(
    "keeps the name %s as plain text",
    (name) => {
      expect(renderReplyTemplate("Szia {név}! {név}?", name)).toBe(
        `Szia ${name}! ${name}?`,
      );
    },
  );

  it("turns line breaks and control characters in a name into one space", () => {
    expect(
      renderReplyTemplate("Szia {név}!", "  Kis\r\n\tAnna\u0000‮  B "),
    ).toBe("Szia Kis Anna B!");
  });

  it.each([null, undefined, "", "   ", "\n\t", "​‍"])(
    "treats %j as no name",
    (name) => expect(renderReplyTemplate("Szia {név}!", name)).toBe("Szia!"),
  );

  it.each([
    ["Kedves {név}, köszönjük!", "Kedves, köszönjük!"],
    ["Szia {név}!", "Szia!"],
    ["{név}, köszönjük!", "köszönjük!"],
    ["{név} köszönjük!", "köszönjük!"],
    ["Szia, {név}!", "Szia!"],
    ["Szia, {név}, köszönjük!", "Szia, köszönjük!"],
    ["Szia, {név} köszönjük!", "Szia, köszönjük!"],
    ["Köszönjük, {név}", "Köszönjük"],
    ["Köszönjük {név} a választ.", "Köszönjük a választ."],
    ["Köszönjük! {név}, írj ránk.", "Köszönjük! írj ránk."],
    ["Köszi! {név}!", "Köszi!!"],
    ["Szia {név} 😊", "Szia 😊"],
    ["Szia, {név} 😊", "Szia 😊"],
    ["Szia 😊 {név}, köszi", "Szia 😊 köszi"],
    ["Szia {név}😊", "Szia 😊"],
    ["Szia ({név})", "Szia ()"],
    ["Szia {név}, {név}!", "Szia!"],
    [
      "Szia {név}!\n\nKöszönjük,  {név}\nA csapat",
      "Szia!\n\nKöszönjük\nA csapat",
    ],
    ["Szia {név},\r\nköszönjük.", "Szia,\r\nköszönjük."],
    ["Első\n{név}, köszi", "Első\nköszi"],
    ["Két  szóköz\n\n\nmarad {név}.", "Két  szóköz\n\n\nmarad."],
    ["{név}", ""],
    ["Nincs benne név, csak szöveg.", "Nincs benne név, csak szöveg."],
  ])("without a name %j becomes %j", (body, expected) => {
    expect(renderReplyTemplate(body, null)).toBe(expected);
  });
});

describe("inserting into a reply draft", () => {
  it("goes to the end when the caret is not known", () => {
    expect(insertIntoDraft("", "Köszi!", null)).toEqual({
      value: "Köszi!",
      caret: 6,
    });
    expect(insertIntoDraft("Szia!", "Köszi!", null)).toEqual({
      value: "Szia! Köszi!",
      caret: 12,
    });
    expect(insertIntoDraft("Szia!\n", "Köszi!", null)?.value).toBe(
      "Szia!\nKöszi!",
    );
  });

  it("goes to the caret, clamped into the draft", () => {
    expect(insertIntoDraft("Szia! Pá!", "Köszi!", 5)).toEqual({
      value: "Szia! Köszi! Pá!",
      caret: 12,
    });
    expect(insertIntoDraft("Szia! Pá!", "Köszi!", 6)).toEqual({
      value: "Szia! Köszi! Pá!",
      caret: 12,
    });
    expect(insertIntoDraft("Szia", "Hé!", 0)?.value).toBe("Hé! Szia");
    expect(insertIntoDraft("Szia", "Hé!", 99)?.value).toBe("Szia Hé!");
    expect(insertIntoDraft("Szia", "Hé!", -5)?.value).toBe("Hé! Szia");
    expect(insertIntoDraft("Szia", "Hé!", Number.NaN)?.value).toBe("Szia Hé!");
    // Not between the two halves of an emoji.
    expect(insertIntoDraft("😊", "Hé!", 1)?.value).toBe("😊 Hé!");
  });

  it("never removes anything from the draft, wherever the caret is", () => {
    const draft = "Első sor\n\n  második 😊 sor  ";
    for (let caret = 0; caret <= draft.length; caret++) {
      const result = insertIntoDraft(draft, "[ÚJ]", caret)!;
      const at = result.value.indexOf("[ÚJ]");
      expect(result.value.slice(at, result.caret)).toBe("[ÚJ]");
      const before = result.value.slice(0, at);
      const after = result.value.slice(result.caret);
      // At most one separating space on each side was added.
      expect(
        [before, before.replace(/ $/, "")].flatMap((start) => [
          start + after,
          start + after.replace(/^ /, ""),
        ]),
      ).toContain(draft);
    }
  });

  it("refuses to go over the limit instead of cutting", () => {
    const draft = "a".repeat(REPLY_MAX_LENGTH - 4);
    expect(insertIntoDraft(draft, "abc", null)?.value).toHaveLength(
      REPLY_MAX_LENGTH,
    );
    expect(insertIntoDraft(draft, "abcd", null)).toBeNull();
    expect(
      insertIntoDraft("", "a".repeat(REPLY_MAX_LENGTH), null),
    ).not.toBeNull();
  });

  it("counts Windows line breaks the way a text field does", () => {
    expect(insertIntoDraft("", "a\r\nb", null)).toEqual({
      value: "a\nb",
      caret: 3,
    });
  });
});

type Node = { type?: unknown; props?: Record<string, unknown> };
const nodes = (node: unknown): Node[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : node && typeof node === "object"
      ? [node as Node, ...nodes((node as Node).props?.children)]
      : [];

describe("template picker", () => {
  const templates = [
    { id: "t1", name: "Köszönet", body: "Köszi, {név}!" },
    { id: "t2", name: "Nyitvatartás", body: "9–17 óra" },
  ];
  const render = (value: string, handlers = {}) => {
    const onChoose = vi.fn();
    const onInsert = vi.fn();
    const tree = ReplyTemplatePicker({
      t: (key, vars) => translate("hu", key, vars),
      templates,
      author: "Anna",
      value,
      disabled: false,
      error: "",
      onChoose,
      onInsert,
      ...handlers,
    });
    const all = nodes(tree);
    return {
      onChoose,
      onInsert,
      select: all.find((node) => node.type === "select")!.props!,
      buttons: all.filter((node) => node.type === "button"),
    };
  };

  it("inserts through a plain button, without any request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { buttons, select, onChoose, onInsert } = render("t1");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props).toMatchObject({ type: "button", disabled: false });
    (select.onChange as (event: unknown) => void)({ target: { value: "t2" } });
    expect(onChoose).toHaveBeenCalledWith("t2");
    // Choosing alone inserts nothing.
    expect(onInsert).not.toHaveBeenCalled();
    (buttons[0].props!.onClick as () => void)();
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(templates[0]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("cannot insert before a template is chosen", () => {
    for (const value of ["", "deleted"])
      expect(render(value).buttons[0].props!.disabled).toBe(true);
  });

  it("only edits the local draft in the comments panel", async () => {
    const source = await readFile(
      new URL("../apps/web/components/comments.tsx", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("function insertTemplate");
    const body = source.slice(start, source.indexOf("async function", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("thread.authorName");
    expect(body).not.toMatch(
      /authorLabel|fetch|post\(|act\(|submitReply|sync\(/,
    );
    // A held-down Ctrl+Enter never sends what was just inserted.
    expect(source).toContain("if (!event.repeat) submitReply();");
  });
});

describe("texts", () => {
  it("shows the placeholder literally in every language", () => {
    for (const locale of ["hu", "en"] as const) {
      const note = translate(locale, "sections.templates.note", { max: 100 });
      expect(note).toContain("{név}");
      expect(note).toContain("100");
      expect(
        translate(locale, "sections.templates.placeholder", { name: "x" }),
      ).toContain("{név}");
    }
  });

  it("translates every new error code", () => {
    for (const code of [
      "ASSIGNEE_NOT_ALLOWED",
      "COMMENT_ASSIGNMENT_CONFLICT",
      "COMMENT_NOT_ASSIGNABLE",
      "REPLY_TEMPLATE_EXISTS",
      "REPLY_TEMPLATE_LIMIT",
    ]) {
      const key = `errors.${code}` as MessageKey;
      expect(translate("hu", key)).not.toBe(key);
      expect(translate("hu", key)).not.toBe(translate("en", key));
    }
  });
});
