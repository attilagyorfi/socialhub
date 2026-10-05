import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { pool } from "../db";
import { AppError } from "../core/security";
import { inspectImage } from "./upload-validation";
import { MAX_MEDIA_BYTES, mediaBucket, storageClient } from "./media";
import { transaction } from "./transaction";

const run = promisify(execFile);
const MAX_VIDEO_SECONDS = 600;

type Probe = {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
};

function detectedMime(data: Buffer) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (data.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
}

async function download(key: string) {
  const result = await storageClient().send(
    new GetObjectCommand({ Bucket: mediaBucket(), Key: key }),
  );
  if (!result.Body) throw new Error("Object body is empty");
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES)
    throw new AppError(422, "FILE_SIZE", "The uploaded file size is invalid.");
  return bytes;
}

async function inspectVideo(data: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "g2a-media-"));
  const input = join(directory, "input.mp4");
  const poster = join(directory, "poster.jpg");
  try {
    await writeFile(input, data);
    let parsed: Probe;
    try {
      const { stdout } = await run(
        process.env.FFPROBE_PATH || "ffprobe",
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          input,
        ],
        { maxBuffer: 1024 * 1024 },
      );
      parsed = JSON.parse(stdout) as Probe;
    } catch {
      throw new AppError(
        422,
        "INVALID_VIDEO",
        "The video is damaged or unsupported.",
      );
    }
    const video = parsed.streams?.find(
      (stream) => stream.codec_type === "video",
    );
    const width = Number(video?.width ?? 0);
    const height = Number(video?.height ?? 0);
    const duration = Number(video?.duration ?? parsed.format?.duration ?? 0);
    if (
      !parsed.format?.format_name?.split(",").some((name) => name === "mp4") ||
      video?.codec_name !== "h264" ||
      !width ||
      !height ||
      width > 4096 ||
      height > 4096 ||
      width * height > 25_000_000 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MAX_VIDEO_SECONDS
    )
      throw new AppError(
        422,
        "INVALID_VIDEO",
        "Use an H.264 MP4 up to 10 minutes and 4096 pixels per side.",
      );
    try {
      await run(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=min(1280\\,iw):-2",
          "-q:v",
          "3",
          "-y",
          poster,
        ],
        { maxBuffer: 1024 * 1024 },
      );
    } catch {
      throw new AppError(
        422,
        "INVALID_VIDEO",
        "The video preview could not be decoded.",
      );
    }
    return {
      width,
      height,
      duration,
      preview: await readFile(poster),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function markFailure(
  job: { id: string; media_asset_id: string; attempts: number },
  error: unknown,
) {
  const failure =
    error instanceof AppError
      ? error
      : new AppError(503, "MEDIA_PROCESSING_UNAVAILABLE", "Processing failed.");
  const retry =
    (failure.status === 429 || failure.status >= 500) && job.attempts < 3;
  await transaction(async (tx) => {
    await tx.query(
      "UPDATE media_processing_jobs SET status=$1,last_error=$2,run_at=now()+($3 * interval '1 second'),updated_at=now() WHERE id=$4",
      [
        retry ? "RETRY" : "DEAD",
        failure.code,
        Math.min(300, 5 * 2 ** (job.attempts - 1)),
        job.id,
      ],
    );
    if (!retry) {
      await tx.query(
        "UPDATE media_assets SET status='FAILED',processing_error=$1,updated_at=now() WHERE id=$2",
        [failure.code, job.media_asset_id],
      );
      await tx.query(
        "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata) SELECT organization_id,client_id,'media.processing_failed',id,$1 FROM media_assets WHERE id=$2",
        [JSON.stringify({ errorCode: failure.code }), job.media_asset_id],
      );
    }
  });
  return { status: retry ? "RETRY" : "FAILED", code: failure.code };
}

export async function processMedia(jobId: string) {
  const job = (
    await pool.query(
      "UPDATE media_processing_jobs SET status='RUNNING',attempts=attempts+1,updated_at=now() WHERE id=$1 AND status IN ('PENDING','RETRY') AND run_at<=now() RETURNING *",
      [jobId],
    )
  ).rows[0];
  if (!job) return;
  const asset = (
    await pool.query("SELECT * FROM media_assets WHERE id=$1", [
      job.media_asset_id,
    ])
  ).rows[0];
  if (!asset || asset.deleted_at || asset.status !== "PROCESSING") {
    await pool.query(
      "UPDATE media_processing_jobs SET status='DONE',updated_at=now() WHERE id=$1",
      [job.id],
    );
    return;
  }

  let data: Buffer | undefined;
  const finalKey = `${asset.organization_id}/${asset.client_id}/ready/${asset.id}`;
  const previewKey = `${asset.organization_id}/${asset.client_id}/previews/${asset.id}.jpg`;
  try {
    data = await download(asset.object_key);
    if (data.length !== Number(asset.size_bytes))
      throw new AppError(422, "FILE_SIZE", "The uploaded file size changed.");
    if (detectedMime(data) !== asset.mime_type)
      throw new AppError(
        422,
        "FILE_TYPE",
        "The file contents do not match its content type.",
      );

    let metadata: {
      width: number;
      height: number;
      duration: number | null;
      preview: Buffer;
    };
    if (asset.mime_type.startsWith("image/")) {
      const dimensions = await inspectImage(data);
      metadata = {
        ...dimensions,
        duration: null,
        preview: await sharp(data)
          .rotate()
          .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer(),
      };
    } else {
      const video = await inspectVideo(data);
      metadata = { ...video };
    }

    await storageClient().send(
      new PutObjectCommand({
        Bucket: mediaBucket(),
        Key: finalKey,
        Body: data,
        ContentType: asset.mime_type,
      }),
    );
    await storageClient().send(
      new PutObjectCommand({
        Bucket: mediaBucket(),
        Key: previewKey,
        Body: metadata.preview,
        ContentType: "image/jpeg",
      }),
    );
    await transaction(async (tx) => {
      await tx.query(
        "UPDATE media_assets SET object_key=$1,preview_object_key=$2,width=$3,height=$4,duration_seconds=$5,status='READY',processing_error=NULL,updated_at=now() WHERE id=$6 AND status='PROCESSING'",
        [
          finalKey,
          previewKey,
          metadata.width,
          metadata.height,
          metadata.duration,
          asset.id,
        ],
      );
      await tx.query(
        "UPDATE media_processing_jobs SET status='DONE',last_error=NULL,updated_at=now() WHERE id=$1",
        [job.id],
      );
      await tx.query(
        "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata) VALUES($1,$2,'media.ready',$3,$4)",
        [
          asset.organization_id,
          asset.client_id,
          asset.id,
          JSON.stringify({
            mimeType: asset.mime_type,
            width: metadata.width,
            height: metadata.height,
            durationSeconds: metadata.duration,
          }),
        ],
      );
    });
    await storageClient()
      .send(
        new DeleteObjectCommand({
          Bucket: mediaBucket(),
          Key: asset.object_key,
        }),
      )
      .catch(() => {});
    return { status: "READY", mediaId: asset.id };
  } catch (error) {
    const result = await markFailure(job, error);
    if (result.status === "FAILED")
      await Promise.all(
        [asset.object_key, finalKey, previewKey].map((Key) =>
          storageClient()
            .send(new DeleteObjectCommand({ Bucket: mediaBucket(), Key }))
            .catch(() => {}),
        ),
      );
    return result;
  }
}

export async function recoverMediaJobs() {
  await pool.query(
    "UPDATE media_processing_jobs SET status='RETRY',last_error='WORKER_INTERRUPTED',run_at=now(),updated_at=now() WHERE status='RUNNING' AND updated_at<now()-interval '15 minutes'",
  );
}

export async function cleanupAbandonedUploads() {
  const assets = (
    await pool.query(
      "UPDATE media_assets SET status='FAILED',processing_error='ABANDONED_UPLOAD',updated_at=now() WHERE status='UPLOADING' AND deleted_at IS NULL AND created_at<now()-interval '1 hour' RETURNING id,organization_id,client_id,object_key",
    )
  ).rows;
  for (const asset of assets) {
    await storageClient()
      .send(
        new DeleteObjectCommand({
          Bucket: mediaBucket(),
          Key: asset.object_key,
        }),
      )
      .catch(() => {});
    await pool.query(
      "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata) VALUES($1,$2,'media.upload_abandoned',$3,$4)",
      [
        asset.organization_id,
        asset.client_id,
        asset.id,
        JSON.stringify({ errorCode: "ABANDONED_UPLOAD" }),
      ],
    );
  }
  return assets.length;
}
