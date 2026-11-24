"use client";
import { useState } from "react";
import type { HubData, Mutate, ReplyTemplate } from "./types";
import { useT } from "../i18n";
import {
  REPLY_MAX_LENGTH,
  REPLY_TEMPLATE_LIMIT,
  REPLY_TEMPLATE_NAME_MAX,
} from "../../../packages/core/reply-templates";

// Reply templates of the active client, inserted into comment reply drafts.
export function ReplyTemplateSettings({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const { t } = useT();
  const templates = data.replyTemplates ?? [];
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const full = !editing && templates.length >= REPLY_TEMPLATE_LIMIT;
  const reset = () => {
    setEditing(null);
    setName("");
    setBody("");
  };
  return (
    <div className="reply-templates">
      <h3>{t("sections.templates.title")}</h3>
      <p className="panel-note">
        {t("sections.templates.note", { max: REPLY_TEMPLATE_LIMIT })}
      </p>
      {!templates.length && (
        <p className="muted">{t("sections.templates.empty")}</p>
      )}
      <ul className="hashtag-set-list">
        {templates.map((template) => (
          <li key={template.id}>
            <strong>{template.name}</strong>
            <button
              type="button"
              className="text-button"
              aria-label={t("sections.templates.edit.label", {
                name: template.name,
              })}
              onClick={() => {
                setEditing(template);
                setName(template.name);
                setBody(template.body);
              }}
            >
              {t("sections.templates.edit")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              aria-label={t("sections.templates.delete.label", {
                name: template.name,
              })}
              onClick={() =>
                mutate("templates.delete", { id: template.id })
                  .then(() => editing?.id === template.id && reset())
                  .catch(() => {})
              }
            >
              {t("sections.templates.delete")}
            </button>
            <span className="muted reply-template-body">{template.body}</span>
          </li>
        ))}
      </ul>
      <form
        className="brand-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutate("templates.save", { id: editing?.id, name, body })
            .then(reset)
            .catch(() => {});
        }}
      >
        <label>
          {t("sections.templates.name")}
          <input
            value={name}
            maxLength={REPLY_TEMPLATE_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("sections.templates.body")}
          <textarea
            rows={3}
            maxLength={REPLY_MAX_LENGTH}
            placeholder={t("sections.templates.placeholder")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {full && <p className="muted">{t("sections.templates.limit")}</p>}
        <div>
          <button
            className="primary"
            disabled={busy || full || !name.trim() || !body.trim()}
          >
            {editing
              ? t("sections.templates.update")
              : t("sections.templates.add")}
          </button>
          {editing && (
            <button type="button" className="text-button" onClick={reset}>
              {t("sections.templates.cancel")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
