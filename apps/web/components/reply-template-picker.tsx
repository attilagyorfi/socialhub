import type { ReplyTemplate } from "./types";
import type { MessageKey, Vars } from "../i18n/core";

// Chooses a template and hands it over for insertion into the local draft.
// Choosing alone changes nothing, and nothing here talks to the server.
export function ReplyTemplatePicker({
  t,
  templates,
  author,
  value,
  disabled,
  error,
  onChoose,
  onInsert,
}: {
  t: (key: MessageKey, vars?: Vars) => string;
  templates: ReplyTemplate[];
  author: string;
  value: string;
  disabled: boolean;
  error: string;
  onChoose: (id: string) => void;
  onInsert: (template: ReplyTemplate) => void;
}) {
  const chosen = templates.find((template) => template.id === value);
  return (
    <div className="comment-tool">
      <select
        aria-label={t("comments.template.label", { author })}
        value={chosen?.id ?? ""}
        disabled={disabled}
        onChange={(event) => onChoose(event.target.value)}
      >
        <option value="">{t("comments.template.choose")}</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled || !chosen}
        aria-label={t("comments.template.insert.label", { author })}
        onClick={() => chosen && onInsert(chosen)}
      >
        {t("comments.template.insert")}
      </button>
      {error && (
        <span role="alert" className="comment-hint">
          {error}
        </span>
      )}
    </div>
  );
}
