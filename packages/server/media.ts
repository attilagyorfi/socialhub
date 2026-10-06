import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pool } from "../db";
import type { Context } from "./context";
import { AppError } from "../core/security";
import { transaction, audit } from "./transaction";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MEDIA_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
] as const;

export function storageClient(publicEndpoint = false) {
  return new S3Client({
    endpoint:
      (publicEndpoint ? process.env.S3_PUBLIC_ENDPOINT : undefined) ??
      process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    },
  });
}

export function mediaBucket() {
  if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required");
  return process.env.S3_BUCKET;
}

let bucketSetup: Promise<void> | undefined;
export function ensureBucket() {
  const manageBucket =
    process.env.S3_MANAGE_BUCKET ??
    (process.env.NODE_ENV === "production" ? "false" : "true");
  if (manageBucket !== "true") return Promise.resolve();
  return (bucketSetup ??= (async () => {
    try {
      await storageClient().send(
        new CreateBucketCommand({ Bucket: mediaBucket() }),
      );
    } catch (e) {
      if (
        !["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(
          (e as Error).name,
        )
      )
        throw e;
    }
    const origin = new URL(process.env.APP_URL ?? "http://localhost:3010")
      .origin;
    try {
      await storageClient().send(
        new PutBucketCorsCommand({
          Bucket: mediaBucket(),
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [origin],
                AllowedMethods: ["PUT", "GET", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 300,
              },
            ],
          },
        }),
      );
    } catch (error) {
      // MinIO configures API CORS at the service level and may not implement
      // the S3 bucket CORS operation. Hosted S3/R2 providers use this branch.
      if ((error as Error).name !== "NotImplemented") throw error;
    }
  })().catch((error) => {
    bucketSetup = undefined;
    throw error;
  }));
}

function validateUpload(name: string, mimeType: string, sizeBytes: number) {
  if (!name.trim() || name.length > 200)
    throw new AppError(
      422,
      "FILE_NAME",
      "Use a file name up to 200 characters.",
    );
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_MEDIA_BYTES
  )
    throw new AppError(
      422,
      "FILE_SIZE",
      "Choose a file between 1 byte and 20 MB.",
    );
  if (!(MEDIA_MIME_TYPES as readonly string[]).includes(mimeType))
    throw new AppError(
      422,
      "FILE_TYPE",
      "Upload a PNG, JPEG, WebP image or MP4 video.",
    );
}

export async function prepareMediaUpload(
  c: Context,
  input: { name: string; mimeType: string; sizeBytes: number },
) {
  validateUpload(input.name, input.mimeType, input.sizeBytes);
  await ensureBucket();
  const id = crypto.randomUUID();
  const objectKey = `${c.organizationId}/${c.clientId}/incoming/${id}`;
  const uploadUrl = await getSignedUrl(
    storageClient(true),
    new PutObjectCommand({
      Bucket: mediaBucket(),
      Key: objectKey,
      ContentType: input.mimeType,
    }),
    { expiresIn: 300 },
  );
  await transaction(async (tx) => {
    await tx.query(
      "INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status) VALUES($1,$2,$3,$4,$5,$6,$7,'UPLOADING')",
      [
        id,
        c.organizationId,
        c.clientId,
        input.name.trim(),
        objectKey,
        input.mimeType,
        input.sizeBytes,
      ],
    );
    await audit(tx, c, "media.upload_prepared", id);
  });
  return {
    id,
    uploadUrl,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

export async function completeMediaUpload(c: Context, id: string) {
  const asset = (
    await pool.query(
      "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL",
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!asset) throw new AppError(404, "NOT_FOUND", "Media not found.");
  if (["PROCESSING", "READY"].includes(asset.status)) return asset;
  if (asset.status !== "UPLOADING")
    throw new AppError(409, "UPLOAD_STATE", "This upload cannot be completed.");

  let head;
  try {
    head = await storageClient().send(
      new HeadObjectCommand({ Bucket: mediaBucket(), Key: asset.object_key }),
    );
  } catch (error) {
    if (["NotFound", "NoSuchKey"].includes((error as Error).name))
      throw new AppError(
        409,
        "UPLOAD_INCOMPLETE",
        "The file has not finished uploading.",
      );
    throw error;
  }
  const actualSize = Number(head.ContentLength ?? 0);
  if (
    actualSize !== Number(asset.size_bytes) ||
    actualSize < 1 ||
    actualSize > MAX_MEDIA_BYTES
  )
    throw new AppError(422, "FILE_SIZE", "The uploaded file size is invalid.");
  if (head.ContentType !== asset.mime_type)
    throw new AppError(422, "FILE_TYPE", "The uploaded content type changed.");

  return transaction(async (tx) => {
    const current = (
      await tx.query(
        "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!current) throw new AppError(404, "NOT_FOUND", "Media not found.");
    if (["PROCESSING", "READY"].includes(current.status)) return current;
    if (current.status !== "UPLOADING")
      throw new AppError(
        409,
        "UPLOAD_STATE",
        "This upload cannot be completed.",
      );
    const result = (
      await tx.query(
        "UPDATE media_assets SET status='PROCESSING',processing_error=NULL,updated_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO media_processing_jobs(organization_id,client_id,media_asset_id) VALUES($1,$2,$3) ON CONFLICT(media_asset_id) DO NOTHING",
      [c.organizationId, c.clientId, id],
    );
    await audit(tx, c, "media.upload_completed", id);
    return result;
  });
}

// Kept for local tools and older clients. The browser uses the direct flow.
export async function uploadMedia(c: Context, file: File) {
  const prepared = await prepareMediaUpload(c, {
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  });
  const asset = (
    await pool.query("SELECT object_key FROM media_assets WHERE id=$1", [
      prepared.id,
    ])
  ).rows[0];
  try {
    await storageClient().send(
      new PutObjectCommand({
        Bucket: mediaBucket(),
        Key: asset.object_key,
        Body: Buffer.from(await file.arrayBuffer()),
        ContentType: file.type,
      }),
    );
    return await completeMediaUpload(c, prepared.id);
  } catch (error) {
    await pool.query(
      "UPDATE media_assets SET status='FAILED',processing_error='UPLOAD_FAILED',updated_at=now() WHERE id=$1",
      [prepared.id],
    );
    throw error;
  }
}

type StoredMedia = {
  id: string;
  organization_id: string;
  client_id: string;
  object_key: string;
  mime_type: string;
  width?: number | null;
};

// Fails permanently before a provider is handed a URL to a missing object,
// which it could not download and might report ambiguously.
export async function assertStoredObject(key: string) {
  try {
    await storageClient().send(
      new HeadObjectCommand({ Bucket: mediaBucket(), Key: key }),
    );
  } catch (error) {
    if (["NotFound", "NoSuchKey"].includes((error as Error).name))
      throw new AppError(
        422,
        "MEDIA_MISSING",
        "The attachment is missing from storage. Upload it again.",
      );
    throw error;
  }
}

// Renditions derived from an asset; storage cleanup must remove them too.
export function derivedObjectKeys(media: {
  id: string;
  organization_id: string;
  client_id: string;
}) {
  return [
    `${media.organization_id}/${media.client_id}/publish/${media.id}-instagram.jpg`,
  ];
}

const INSTAGRAM_MAX_WIDTH = 1440;
const INSTAGRAM_MAX_BYTES = 8 * 1024 * 1024;

// Instagram accepts only JPEG images up to 8 MB and 1440 px wide. Other
// images get a cached JPEG rendition, created on first publication.
export async function instagramImageObjectKey(media: StoredMedia) {
  if (
    media.mime_type === "image/jpeg" &&
    media.width &&
    media.width <= INSTAGRAM_MAX_WIDTH
  )
    return media.object_key;
  const [key] = derivedObjectKeys(media);
  try {
    await storageClient().send(
      new HeadObjectCommand({ Bucket: mediaBucket(), Key: key }),
    );
    return key;
  } catch (error) {
    if (!["NotFound", "NoSuchKey"].includes((error as Error).name)) throw error;
  }
  const original = await storageClient().send(
    new GetObjectCommand({ Bucket: mediaBucket(), Key: media.object_key }),
  );
  if (!original.Body)
    throw new AppError(422, "INVALID_MEDIA", "Attachment missing");
  const source = Buffer.from(await original.Body.transformToByteArray());
  // Loaded lazily: the native module is only needed for this rare conversion.
  const { default: sharp } = await import("sharp");
  let rendition: Buffer | undefined;
  for (const quality of [90, 80, 70]) {
    rendition = await sharp(source)
      .rotate()
      .resize({ width: INSTAGRAM_MAX_WIDTH, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality })
      .toBuffer();
    if (rendition.length <= INSTAGRAM_MAX_BYTES) break;
  }
  if (!rendition || rendition.length > INSTAGRAM_MAX_BYTES)
    throw new AppError(
      422,
      "META_MEDIA_TOO_LARGE",
      "The image cannot be reduced below Instagram's 8 MB limit.",
    );
  await storageClient().send(
    new PutObjectCommand({
      Bucket: mediaBucket(),
      Key: key,
      Body: rendition,
      ContentType: "image/jpeg",
    }),
  );
  return key;
}

export async function signedObjectUrl(objectKey: string, expiresIn = 300) {
  return getSignedUrl(
    storageClient(true),
    new GetObjectCommand({ Bucket: mediaBucket(), Key: objectKey }),
    { expiresIn },
  );
}

export async function mediaUrl(c: Context, id: string) {
  const media = (
    await pool.query(
      "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='READY' AND deleted_at IS NULL",
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!media) throw new AppError(404, "NOT_FOUND", "Ready media not found.");
  return signedObjectUrl(media.object_key);
}

export async function mediaPreviewUrl(c: Context, id: string) {
  const media = (
    await pool.query(
      "SELECT preview_object_key FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='READY' AND deleted_at IS NULL",
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  return media?.preview_object_key
    ? signedObjectUrl(media.preview_object_key)
    : undefined;
}

export async function deleteMedia(c: Context, id: string) {
  return transaction(async (tx) => {
    const media = (
      await tx.query(
        "SELECT * FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!media) throw new AppError(404, "NOT_FOUND", "Media not found.");
    if (
      (
        await tx.query(
          "SELECT 1 FROM post_targets WHERE organization_id=$1 AND client_id=$2 AND $3=ANY(media_ids) AND status NOT IN ('CANCELLED','FAILED') LIMIT 1",
          [c.organizationId, c.clientId, id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        "MEDIA_IN_USE",
        "This file is attached to a post.",
      );
    await Promise.all(
      [media.object_key, media.preview_object_key, ...derivedObjectKeys(media)]
        .filter(Boolean)
        .map((Key) =>
          storageClient().send(
            new DeleteObjectCommand({ Bucket: mediaBucket(), Key }),
          ),
        ),
    );
    await tx.query(
      "UPDATE media_assets SET status='FAILED',deleted_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    await audit(tx, c, "media.deleted", id);
  });
}
