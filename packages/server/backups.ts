import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { mediaBucket, storageClient } from "./media";

const run = promisify(execFile);
export const BACKUP_PREFIX = "backups/postgres/";
const INTERVAL_HOURS = 24;

export type StoredBackup = { key: string; createdAt: Date };

export const backupsEnabled = () => process.env.BACKUP_ENABLED === "true";
export const backupBucket = () => process.env.BACKUP_BUCKET || mediaBucket();
const retentionDays = () =>
  Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 14);

// The random suffix keeps backup names unguessable even if the bucket were
// ever exposed publicly.
export function backupKey(now: Date) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${BACKUP_PREFIX}${stamp}-${randomBytes(8).toString("hex")}.dump`;
}

export function isBackupDue(backups: StoredBackup[], now: Date) {
  const latest = Math.max(0, ...backups.map((b) => b.createdAt.getTime()));
  return now.getTime() - latest >= (INTERVAL_HOURS - 1) * 60 * 60 * 1000;
}

// Old backups are removed, but the newest one is always kept.
export function expiredBackups(
  backups: StoredBackup[],
  now: Date,
  days: number,
) {
  const newest = [...backups].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return backups.filter((b) => b !== newest && b.createdAt.getTime() < cutoff);
}

export async function listBackups(): Promise<StoredBackup[]> {
  const backups: StoredBackup[] = [];
  let token: string | undefined;
  do {
    const page = await storageClient().send(
      new ListObjectsV2Command({
        Bucket: backupBucket(),
        Prefix: BACKUP_PREFIX,
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents ?? [])
      if (item.Key && item.LastModified)
        backups.push({ key: item.Key, createdAt: item.LastModified });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return backups;
}

// Daily logical backup of the whole database (pg_dump custom format) to
// object storage. Restore steps are in OPERATIONS.md.
export async function runDueDatabaseBackup(now = new Date()) {
  if (!backupsEnabled()) return { status: "disabled" as const };
  const existing = await listBackups();
  if (!isBackupDue(existing, now)) return { status: "not_due" as const };
  const directory = await mkdtemp(join(tmpdir(), "g2a-backup-"));
  const file = join(directory, "database.dump");
  try {
    await run(
      process.env.PG_DUMP_PATH || "pg_dump",
      [
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-privileges",
        `--file=${file}`,
        process.env.DATABASE_URL!,
      ],
      { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 },
    );
    const body = await readFile(file);
    const key = backupKey(now);
    await storageClient().send(
      new PutObjectCommand({
        Bucket: backupBucket(),
        Key: key,
        Body: body,
        ContentType: "application/octet-stream",
      }),
    );
    const expired = expiredBackups(
      [...existing, { key, createdAt: now }],
      now,
      retentionDays(),
    );
    if (expired.length)
      await storageClient().send(
        new DeleteObjectsCommand({
          Bucket: backupBucket(),
          Delete: { Objects: expired.map((b) => ({ Key: b.key })) },
        }),
      );
    return {
      status: "created" as const,
      key,
      bytes: body.length,
      removed: expired.length,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
