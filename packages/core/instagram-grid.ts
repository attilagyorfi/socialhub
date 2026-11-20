// Instagram profile preview: the posts of one client's Instagram account in
// the order they appear on the profile, newest first. Built only from data
// the app already stores (post targets and media assets); it never calls a
// social provider, so the input is plain rows and the function is pure.

export type GridMedia = {
  id: string;
  mimeType: string;
  ready: boolean;
  // A JPEG poster frame; videos have one after processing.
  hasPreview: boolean;
};

export type GridSourceRow = {
  postId: string;
  targetId: string;
  platform: string;
  postStatus: string;
  targetStatus: string;
  scheduledAt: Date | string | null;
  publishedAt: Date | string | null;
  caption: string;
  // In publishing order; a carousel's first image is its cover.
  mediaIds: string[];
};

export type GridItem = {
  postId: string;
  targetId: string;
  state: "published" | "planned";
  at: string;
  caption: string;
  postStatus: string;
  mediaCount: number;
  // Null: the post has no usable image, the grid shows a placeholder.
  cover: { id: string; mimeType: string; preview: boolean } | null;
};

// Posts on their way to the profile. Drafts are not planned yet; failed and
// cancelled targets will not appear.
const plannedStatuses = new Set([
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "QUEUED",
  "PUBLISHING",
]);

function iso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cover(media: GridMedia | undefined): GridItem["cover"] {
  if (!media?.ready) return null;
  if (media.mimeType.startsWith("image/"))
    return { id: media.id, mimeType: media.mimeType, preview: false };
  return media.hasPreview
    ? { id: media.id, mimeType: "image/jpeg", preview: true }
    : null;
}

export function buildInstagramGrid(
  rows: GridSourceRow[],
  media: Map<string, GridMedia>,
  limits: { published?: number; planned?: number } = {},
): GridItem[] {
  const published: GridItem[] = [];
  const planned: GridItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.platform !== "instagram" || seen.has(row.targetId)) continue;
    seen.add(row.targetId);
    let state: GridItem["state"];
    let at: string | null;
    if (row.targetStatus === "PUBLISHED") {
      state = "published";
      at = iso(row.publishedAt) ?? iso(row.scheduledAt);
    } else if (
      plannedStatuses.has(row.postStatus) &&
      !["FAILED", "CANCELLED", "PUBLISHED"].includes(row.targetStatus)
    ) {
      state = "planned";
      at = iso(row.scheduledAt);
    } else continue;
    if (!at) continue;
    (state === "published" ? published : planned).push({
      postId: row.postId,
      targetId: row.targetId,
      state,
      at,
      caption: row.caption,
      postStatus: row.postStatus,
      mediaCount: row.mediaIds.length,
      cover: cover(media.get(row.mediaIds[0])),
    });
  }
  const newestFirst = (a: GridItem, b: GridItem) =>
    b.at.localeCompare(a.at) || a.targetId.localeCompare(b.targetId);
  // The newest published posts, then everything planned ahead of them.
  const kept = [
    ...published.sort(newestFirst).slice(0, limits.published ?? Infinity),
    ...planned.sort(newestFirst).slice(-(limits.planned ?? Infinity)),
  ];
  return kept.sort(newestFirst);
}
