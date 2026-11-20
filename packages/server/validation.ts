import { z } from "zod";
import {
  FIRST_COMMENT_LIMIT,
  HASHTAG_MAX_LENGTH,
  HASHTAG_SET_LIMIT,
  MEDIA_ERRORS,
  mediaErrorText,
  MULTI_IMAGE_LIMIT,
  normalizeHashtags,
  platforms,
} from "../core/domain";
import { canonicalTimeZone, validTimeZone } from "../core/timezones";
export const uuid = z.string().uuid();
export const localeInput = z.enum(["hu", "en"]);
export const timeZoneInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(validTimeZone, "Enter a valid IANA timezone.")
  .transform((value) => canonicalTimeZone(value)!);
export const memberRole = z.enum([
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
]);
export const postInput = z.object({
  clientId: uuid,
  caption: z.string().max(63206),
  link: z
    .string()
    .refine((value) => {
      if (value === "") return true;
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, "Enter a valid HTTP or HTTPS link.")
    .optional(),
  targets: z
    .array(
      z.object({
        accountId: uuid,
        caption: z.string().max(63206),
        mediaIds: z
          .array(uuid)
          .max(MULTI_IMAGE_LIMIT, mediaErrorText(MEDIA_ERRORS.tooMany)),
        // Posted as the first comment after publishing (Facebook, Instagram).
        firstComment: z
          .string()
          .max(
            FIRST_COMMENT_LIMIT,
            `The first comment can be at most ${FIRST_COMMENT_LIMIT} characters.`,
          )
          .optional(),
      }),
    )
    .min(1)
    .max(15),
});
export const hashtagSetInput = z.object({
  name: z.string().trim().min(1).max(80),
  hashtags: z
    .array(z.string().max(HASHTAG_MAX_LENGTH))
    .max(HASHTAG_SET_LIMIT * 2)
    .transform(normalizeHashtags)
    .pipe(
      z
        .array(z.string().max(HASHTAG_MAX_LENGTH + 1))
        .min(1, "Add at least one hashtag.")
        .max(
          HASHTAG_SET_LIMIT,
          `A set can have at most ${HASHTAG_SET_LIMIT} hashtags.`,
        ),
    ),
});
export const connectInput = z.object({
  clientId: uuid,
  platform: z.enum(platforms),
  name: z.string().trim().min(1).max(120),
});
// Local brand profile (brand_profiles.profile). synced* keys are dropped: the
// synced profile is owned by the Growth Engine and lives in its own columns.
export const brandInput = z
  .record(
    z.string(),
    z.union([z.string().max(10000), z.array(z.string().max(500)).max(100)]),
  )
  .transform((brand) =>
    Object.fromEntries(
      Object.entries(brand).filter(([key]) => !/^synced/i.test(key)),
    ),
  );
export const calendarQueryInput = z.object({
  clientId: uuid,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  platform: z.enum(platforms).optional(),
  status: z
    .enum([
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "SCHEDULED",
      "QUEUED",
      "PUBLISHING",
      "PUBLISHED",
      "PARTIALLY_PUBLISHED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
  authorId: uuid.optional(),
});
export const postListQueryInput = z.object({
  clientId: uuid,
  id: uuid.optional(),
  query: z.string().trim().max(200).optional(),
  status: z
    .enum([
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "SCHEDULED",
      "QUEUED",
      "PUBLISHING",
      "PUBLISHED",
      "PARTIALLY_PUBLISHED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
  platform: z.enum(platforms).optional(),
  authorId: uuid.optional(),
  approvalOnly: z.boolean().default(false),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const analyticsQueryInput = z.object({
  clientId: uuid,
  from: z.iso.date(),
  to: z.iso.date(),
  platform: z.enum(platforms).optional(),
});
