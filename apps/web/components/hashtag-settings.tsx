"use client";
import { useState } from "react";
import type { HashtagSet, HubData, Mutate } from "./types";
import { useT } from "../i18n";
import {
  HASHTAG_SET_LIMIT,
  normalizeHashtags,
} from "../../../packages/core/domain";

// Named hashtag sets of the active client, inserted in the composer.
export function HashtagSettings({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const { t } = useT();
  const sets = data.hashtagSets ?? [];
  const [editing, setEditing] = useState<HashtagSet | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const preview = normalizeHashtags([tags]);
  const reset = () => {
    setEditing(null);
    setName("");
    setTags("");
  };
  return (
    <div className="hashtag-sets">
      <h3>{t("sections.hashtags.title")}</h3>
      <p className="panel-note">
        {t("sections.hashtags.note", { max: HASHTAG_SET_LIMIT })}
      </p>
      {!sets.length && <p className="muted">{t("sections.hashtags.empty")}</p>}
      <ul className="hashtag-set-list">
        {sets.map((set) => (
          <li key={set.id}>
            <strong>{set.name}</strong>
            <span className="muted">{set.hashtags.join(" ")}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setEditing(set);
                setName(set.name);
                setTags(set.hashtags.join(" "));
              }}
            >
              {t("sections.hashtags.edit")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                mutate("hashtags.delete", { id: set.id })
                  .then(() => editing?.id === set.id && reset())
                  .catch(() => {})
              }
            >
              {t("sections.hashtags.delete")}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="brand-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutate("hashtags.save", {
            id: editing?.id,
            name,
            hashtags: [tags],
          })
            .then(reset)
            .catch(() => {});
        }}
      >
        <label>
          {t("sections.hashtags.name")}
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("sections.hashtags.tags")}
          <textarea
            rows={2}
            placeholder="#marketing #budapest"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        {!!preview.length && (
          <p className="muted">
            {t("sections.hashtags.count", {
              count: preview.length,
              max: HASHTAG_SET_LIMIT,
            })}
          </p>
        )}
        <div>
          <button
            className="primary"
            disabled={busy || !name.trim() || !preview.length}
          >
            {editing
              ? t("sections.hashtags.update")
              : t("sections.hashtags.add")}
          </button>
          {editing && (
            <button type="button" className="text-button" onClick={reset}>
              {t("sections.hashtags.cancel")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
