import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { backupBucket, listBackups, type StoredBackup } from "./backups";
import { storageClient } from "./media";

const run = promisify(execFile);

// Tables whose row counts are reported, so a drill can be compared with the
// production numbers at backup time.
const COUNTED_TABLES = [
  "organizations",
  "user",
  "clients",
  "posts",
  "post_targets",
  "social_accounts",
  "media_assets",
  "publish_jobs",
  "audit_logs",
] as const;

// Each query returns the number of offending rows; zero passes.
const INTEGRITY_CHECKS: Record<string, string> = {
  organizations_present:
    "SELECT CASE WHEN count(*)>0 THEN 0 ELSE 1 END AS n FROM organizations",
  clients_have_organization: `SELECT count(*) AS n FROM clients c
    LEFT JOIN organizations o ON o.id=c.organization_id WHERE o.id IS NULL`,
  posts_have_client: `SELECT count(*) AS n FROM posts p
    LEFT JOIN clients c ON c.id=p.client_id AND c.organization_id=p.organization_id
    WHERE c.id IS NULL`,
  targets_have_post: `SELECT count(*) AS n FROM post_targets t
    LEFT JOIN posts p ON p.id=t.post_id WHERE p.id IS NULL`,
  members_have_user: `SELECT count(*) AS n FROM organization_members m
    LEFT JOIN "user" u ON u.id=m.user_id WHERE u.id IS NULL`,
};

export function redactSecrets(text: string) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]");
}

export function databaseIdentity(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("RESTORE_DATABASE_URL is not a valid connection URL");
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

// The drill must never touch the production database server: it creates and
// drops its own database on the target server, so the target has to be a
// different host/port than DATABASE_URL (when set).
export function assertRestoreTarget(
  restoreUrl: string | undefined,
  productionUrl: string | undefined,
) {
  if (!restoreUrl) throw new Error("RESTORE_DATABASE_URL is required");
  const target = databaseIdentity(restoreUrl);
  if (!productionUrl) return target;
  let production: ReturnType<typeof databaseIdentity>;
  try {
    production = databaseIdentity(productionUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
  if (target.host === production.host && target.port === production.port)
    throw new Error(
      "RESTORE_DATABASE_URL points to the same database server as DATABASE_URL",
    );
  return target;
}

// Each run restores into its own fresh database on the temporary server, so
// the drill can be repeated without recreating the server.
export function drillDatabaseName(now: Date) {
  return `restore_drill_${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
}

export function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// A second guard against the wrong target: production always has tables.
export function assertEmptyTarget(publicTables: string[]) {
  if (publicTables.length)
    throw new Error(
      `The restore target is not empty (${publicTables.length} tables in public schema)`,
    );
}

export function newestBackup(backups: StoredBackup[]) {
  return backups
    .filter((backup) => backup.key.endsWith(".dump"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

// Migrations in the repository but missing from the backup were added after
// the backup was taken; that is expected, not a failure.
export function compareMigrations(expected: string[], applied: string[]) {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  return {
    applied: applied.length,
    newerThanBackup: expected.filter((name) => !appliedSet.has(name)),
    unknown: applied.filter((name) => !expectedSet.has(name)),
    ok: applied.length > 0,
  };
}

export type RestoreDrillReport = {
  event: "restore_drill";
  ok: boolean;
  backup?: { key: string; createdAt: string; bytes: number };
  database?: string;
  restoreSeconds?: number;
  migrations?: ReturnType<typeof compareMigrations>;
  rowCounts?: Record<string, number>;
  checks?: Record<string, boolean>;
  error?: string;
};

async function repositoryMigrations() {
  const directory = new URL("../db/migrations/", import.meta.url);
  return (await readdir(directory)).filter((name) => name.endsWith(".sql"));
}

export async function runRestoreDrill(): Promise<RestoreDrillReport> {
  const restoreUrl = process.env.RESTORE_DATABASE_URL;
  const report: RestoreDrillReport = { event: "restore_drill", ok: false };
  const directory = await mkdtemp(join(tmpdir(), "g2a-restore-"));
  let admin: Client | undefined;
  let client: Client | undefined;
  try {
    assertRestoreTarget(restoreUrl, process.env.DATABASE_URL);
    admin = new Client({ connectionString: restoreUrl });
    await admin.connect();
    report.database = drillDatabaseName(new Date());
    await admin.query(`CREATE DATABASE "${report.database}"`);
    const drillUrl = withDatabase(restoreUrl!, report.database);
    client = new Client({ connectionString: drillUrl });
    await client.connect();
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    assertEmptyTarget(tables.rows.map((row) => row.tablename as string));

    const backup = newestBackup(await listBackups());
    if (!backup) throw new Error("No backup found under backups/postgres/");
    const file = join(directory, "database.dump");
    const object = await storageClient().send(
      new GetObjectCommand({ Bucket: backupBucket(), Key: backup.key }),
    );
    if (!object.Body) throw new Error("The backup object has no body");
    await pipeline(object.Body as Readable, createWriteStream(file));
    report.backup = {
      key: backup.key,
      createdAt: backup.createdAt.toISOString(),
      bytes: (await stat(file)).size,
    };

    const started = performance.now();
    try {
      await run(
        process.env.PG_RESTORE_PATH || "pg_restore",
        [
          "--no-owner",
          "--no-acl",
          "--exit-on-error",
          `--dbname=${drillUrl}`,
          file,
        ],
        { timeout: 60 * 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new Error(`pg_restore failed: ${stderr.trim().slice(0, 2000)}`);
    }
    report.restoreSeconds =
      Math.round((performance.now() - started) / 100) / 10;

    const applied = await client.query(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    report.migrations = compareMigrations(
      await repositoryMigrations(),
      applied.rows.map((row) => row.name as string),
    );
    report.rowCounts = {};
    for (const table of COUNTED_TABLES)
      report.rowCounts[table] = Number(
        (await client.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n,
      );
    report.checks = { schema_migrations_present: report.migrations.ok };
    for (const [name, sql] of Object.entries(INTEGRITY_CHECKS))
      report.checks[name] = Number((await client.query(sql)).rows[0].n) === 0;
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (error) {
    report.error = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await client?.end().catch(() => {});
    // The restored copy holds production data; it never outlives the run.
    if (admin && report.database)
      await admin
        .query(`DROP DATABASE IF EXISTS "${report.database}" WITH (FORCE)`)
        .catch(() => {});
    await admin?.end().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
  return report;
}

export function restoreDrillSummary(report: RestoreDrillReport) {
  const lines = [`Restore drill: ${report.ok ? "PASSED" : "FAILED"}`];
  if (report.backup)
    lines.push(
      `Backup: ${report.backup.key} (${report.backup.createdAt}, ${(report.backup.bytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  if (report.restoreSeconds !== undefined)
    lines.push(`Restore duration: ${report.restoreSeconds} s`);
  if (report.migrations)
    lines.push(
      `Migrations in backup: ${report.migrations.applied}` +
        (report.migrations.newerThanBackup.length
          ? `; newer than backup: ${report.migrations.newerThanBackup.join(", ")}`
          : ""),
    );
  if (report.rowCounts)
    lines.push(
      `Rows: ${Object.entries(report.rowCounts)
        .map(([table, count]) => `${table}=${count}`)
        .join(", ")}`,
    );
  if (report.checks)
    for (const [name, ok] of Object.entries(report.checks))
      lines.push(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (report.error) lines.push(`Error: ${report.error}`);
  return lines.join("\n");
}
