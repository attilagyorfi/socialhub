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
    "MULTI_IMAGE",
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
  width?: number | null;
  height?: number | null;
};
export type Content = { caption: string; link?: string | null; media: Media[] };
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
  }
  for (const m of content.media)
    if (
      platform === "instagram" &&
      m.mime_type.startsWith("image/") &&
      m.width &&
      m.height &&
      (m.width / m.height < 0.8 - 0.005 || m.width / m.height > 1.91 + 0.005)
    )
      errors.push(
        "Instagram images must have an aspect ratio between 4:5 (portrait) and 1.91:1 (landscape).",
      );
  if (
    content.media.length > 1 &&
    !capabilities[platform].includes("MULTI_IMAGE")
  )
    errors.push("Multiple media attachments are not supported.");
  return errors;
}
