export const platforms = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "google",
] as const;
export type Platform = (typeof platforms)[number];
export type Role =
  | "OWNER"
  | "ADMIN"
  | "SOCIAL_MANAGER"
  | "CONTENT_CREATOR"
  | "CLIENT_REVIEWER"
  | "VIEWER";
export type Action = "read" | "create" | "publish" | "approve" | "manage";
export const permissions: Record<Role, readonly Action[]> = {
  OWNER: ["read", "create", "publish", "approve", "manage"],
  ADMIN: ["read", "create", "publish", "approve", "manage"],
  SOCIAL_MANAGER: ["read", "create", "publish", "approve"],
  CONTENT_CREATOR: ["read", "create"],
  CLIENT_REVIEWER: ["read", "approve"],
  VIEWER: ["read"],
};
export const can = (role: Role, action: Action) =>
  permissions[role]?.includes(action) ?? false;
export type Status =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "SCHEDULED"
  | "QUEUED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "PARTIALLY_PUBLISHED"
  | "FAILED"
  | "CANCELLED";
export function aggregateStatus(targets: Status[]): Status {
  if (!targets.length) return "DRAFT";
  if (targets.every((s) => s === "PUBLISHED")) return "PUBLISHED";
  if (targets.some((s) => ["SCHEDULED", "QUEUED", "PUBLISHING"].includes(s)))
    return "PUBLISHING";
  if (targets.some((s) => s === "PUBLISHED")) return "PARTIALLY_PUBLISHED";
  if (targets.every((s) => s === "CANCELLED")) return "CANCELLED";
  return "FAILED";
}
export type Capability =
  | "TEXT_POST"
  | "IMAGE_POST"
  | "MULTI_IMAGE"
  | "VIDEO"
  | "SHORT_VIDEO"
  | "LINK_POST"
  | "HASHTAGS"
  | "SCHEDULING"
  | "ANALYTICS";
export const capabilities: Record<Platform, Capability[]> = {
  facebook: [
    "TEXT_POST",
    "IMAGE_POST",
    "MULTI_IMAGE",
    "VIDEO",
    "LINK_POST",
    "HASHTAGS",
    "SCHEDULING",
    "ANALYTICS",
  ],
  instagram: [
    "IMAGE_POST",
    "MULTI_IMAGE",
    "VIDEO",
    "SHORT_VIDEO",
    "HASHTAGS",
    "SCHEDULING",
    "ANALYTICS",
  ],
  linkedin: [
    "TEXT_POST",
    "IMAGE_POST",
    "VIDEO",
    "LINK_POST",
    "HASHTAGS",
    "SCHEDULING",
    "ANALYTICS",
  ],
  tiktok: ["VIDEO", "SHORT_VIDEO", "HASHTAGS", "SCHEDULING", "ANALYTICS"],
  google: ["TEXT_POST", "IMAGE_POST", "LINK_POST", "SCHEDULING", "ANALYTICS"],
};
export type Media = {
  id: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  duration_seconds?: number | null;
};
export type Content = { caption: string; link?: string | null; media: Media[] };

// Posts with several attachments (Instagram carousel, Facebook multi-photo
// post). Only images, in the order of the target's media_ids. Every other
// network takes one attachment. Shared by saving, scheduling and the worker.
export const MULTI_IMAGE_LIMIT = 10;
// Stable error codes; the UI translates them (composer.validation.*).
export const MEDIA_ERRORS = {
  duplicate: "media.duplicate",
  tooMany: "media.too_many",
  imagesOnly: "media.images_only",
  single: "media.single",
} as const;
export type MediaErrorCode = (typeof MEDIA_ERRORS)[keyof typeof MEDIA_ERRORS];
// English text for server responses, in the style of the other messages.
export const MEDIA_ERROR_TEXT: Record<MediaErrorCode, string> = {
  "media.duplicate": "Add each image to a post only once.",
  "media.too_many": `A post can have at most ${MULTI_IMAGE_LIMIT} images.`,
  "media.images_only":
    "A post with several attachments can only contain images. Publish the video in a separate post.",
  "media.single":
    "This network takes one image or video per post. Remove attachments or deselect this account.",
};
export const mediaErrorText = (error: string) =>
  MEDIA_ERROR_TEXT[error as MediaErrorCode] ?? error;

// First comment: posted after a confirmed publication where the provider
// adapter supports it (Facebook Page posts and Instagram media).
export const FIRST_COMMENT_LIMIT = 2200;
export const FIRST_COMMENT_PLATFORMS: readonly Platform[] = [
  "facebook",
  "instagram",
];
export const supportsFirstComment = (platform: string) =>
  FIRST_COMMENT_PLATFORMS.includes(platform as Platform);

// Hashtag sets per client: "#tag" form, no whitespace, no duplicates.
export const HASHTAG_SET_LIMIT = 30;
export const HASHTAG_MAX_LENGTH = 100;
export function normalizeHashtags(values: readonly string[]) {
  const tags: string[] = [];
  for (const value of values.flatMap((v) => v.split(/[\s,]+/))) {
    const tag = value.replace(/^#+/, "");
    if (!tag) continue;
    const normalized = `#${tag}`;
    if (!tags.some((t) => t.toLowerCase() === normalized.toLowerCase()))
      tags.push(normalized);
  }
  return tags;
}
// Appends a set to a text, separated by a blank line or a space.
export function appendHashtags(text: string, hashtags: readonly string[]) {
  const tags = hashtags.join(" ");
  if (!tags) return text;
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${tags}` : tags;
}
export function mediaSetErrors(
  platform: Platform,
  media: Pick<Media, "id" | "mime_type">[],
) {
  const errors: string[] = [];
  if (new Set(media.map((m) => m.id)).size !== media.length)
    errors.push(MEDIA_ERRORS.duplicate);
  if (media.length < 2) return errors;
  if (!capabilities[platform].includes("MULTI_IMAGE"))
    return [...errors, MEDIA_ERRORS.single];
  if (media.length > MULTI_IMAGE_LIMIT) errors.push(MEDIA_ERRORS.tooMany);
  if (media.some((m) => !m.mime_type.startsWith("image/")))
    errors.push(MEDIA_ERRORS.imagesOnly);
  return errors;
}

// Database reads by id=ANY(...) return rows in any order; attachments must
// follow media_ids. Missing ids are dropped, so callers can compare lengths.
export function inMediaOrder<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[],
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

// The composer's up/down buttons; out-of-range moves leave the list as is.
export function moveMedia(ids: readonly string[], index: number, by: -1 | 1) {
  const to = index + by;
  if (index < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function validatePost(platform: Platform, content: Content) {
  const errors: string[] = [];
  const limit = {
    facebook: 63206,
    instagram: 2200,
    linkedin: 3000,
    tiktok: 2200,
    google: 1500,
  }[platform];
  if (!content.caption.trim() && !content.media.length)
    errors.push("Add a caption or media.");
  if (content.caption.length > limit)
    errors.push(`Caption exceeds ${limit} characters.`);
  if (platform === "instagram" && !content.media.length)
    errors.push("Instagram requires an image or video.");
  if (
    platform === "tiktok" &&
    (content.media.length !== 1 ||
      !content.media[0]?.mime_type.startsWith("video/"))
  )
    errors.push("TikTok requires one video.");
  if (content.link && !capabilities[platform].includes("LINK_POST"))
    errors.push(
      "This network does not support a link post. Remove the link or deselect this account.",
    );
  for (const m of content.media) {
    if (m.status !== "READY") errors.push("Media is not ready.");
    if (m.size_bytes > 100 * 1024 * 1024)
      errors.push("Media exceeds the MVP 100 MB upload limit.");
    if (
      m.mime_type.startsWith("video/") &&
      !capabilities[platform].includes("VIDEO")
    )
      errors.push("Video is not supported on this network.");
    // Instagram publishes videos as Reels, which Meta rejects under 3 s.
    if (
      platform === "instagram" &&
      m.mime_type.startsWith("video/") &&
      m.duration_seconds != null &&
      m.duration_seconds < 3
    )
      errors.push("Instagram Reels must be at least 3 seconds long.");
  }
  errors.push(...mediaSetErrors(platform, content.media));
  return errors;
}
