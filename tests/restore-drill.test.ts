import { describe, expect, it } from "vitest";
import {
  assertEmptyTarget,
  assertRestoreTarget,
  compareMigrations,
  drillDatabaseName,
  newestBackup,
  redactSecrets,
  restoreDrillSummary,
  withDatabase,
} from "../packages/server/restore-drill";

const production =
  "postgresql://app:secret@postgres.railway.internal:5432/railway";

describe("restore drill safety", () => {
  it("requires a restore target", () => {
    expect(() => assertRestoreTarget(undefined, production)).toThrow(
      "RESTORE_DATABASE_URL is required",
    );
  });

  it("refuses the production server, even with other credentials or database", () => {
    for (const url of [
      "postgres://other:pw@POSTGRES.railway.internal/railway",
      "postgresql://app:pw@postgres.railway.internal:5432/drill",
    ])
      expect(() => assertRestoreTarget(url, production)).toThrow(
        "same database server",
      );
  });

  it("accepts a different host or port", () => {
    for (const url of [
      "postgresql://app:pw@postgres-drill.railway.internal:5432/railway",
      "postgresql://app:pw@postgres.railway.internal:5433/railway",
    ])
      expect(assertRestoreTarget(url, production)).toBeTruthy();
    expect(
      assertRestoreTarget("postgresql://localhost/drill", undefined),
    ).toEqual({ host: "localhost", port: "5432", database: "drill" });
  });

  it("rejects an invalid URL without echoing it", () => {
    expect(() => assertRestoreTarget("not a url", production)).toThrow(
      "RESTORE_DATABASE_URL is not a valid connection URL",
    );
  });

  it("requires an empty target database", () => {
    expect(() => assertEmptyTarget([])).not.toThrow();
    expect(() => assertEmptyTarget(["organizations", "user"])).toThrow(
      "not empty (2 tables",
    );
  });

  it("never prints connection strings", () => {
    expect(redactSecrets(`could not connect: ${production} refused`)).toBe(
      "could not connect: [database-url] refused",
    );
  });
});

describe("restore drill database", () => {
  it("names a fresh database per run", () => {
    expect(drillDatabaseName(new Date("2026-10-15T09:35:49.412Z"))).toBe(
      "restore_drill_20261015093549",
    );
  });

  it("points the connection at that database only", () => {
    expect(
      withDatabase(
        "postgresql://app:p%40ss@drill.railway.internal:5432/railway?sslmode=disable",
        "restore_drill_1",
      ),
    ).toBe(
      "postgresql://app:p%40ss@drill.railway.internal:5432/restore_drill_1?sslmode=disable",
    );
  });
});

describe("restore drill backup selection", () => {
  it("picks the newest dump", () => {
    expect(newestBackup([])).toBeUndefined();
    expect(
      newestBackup([
        { key: "backups/postgres/a.dump", createdAt: new Date("2026-10-13") },
        { key: "backups/postgres/c.dump", createdAt: new Date("2026-10-15") },
        { key: "backups/postgres/note.txt", createdAt: new Date("2026-10-16") },
        { key: "backups/postgres/b.dump", createdAt: new Date("2026-10-14") },
      ])?.key,
    ).toBe("backups/postgres/c.dump");
  });
});

describe("restore drill verification", () => {
  it("reports migrations newer than the backup without failing", () => {
    expect(
      compareMigrations(
        ["001_a.sql", "002_b.sql", "003_c.sql"],
        ["001_a.sql", "002_b.sql"],
      ),
    ).toEqual({
      applied: 2,
      newerThanBackup: ["003_c.sql"],
      unknown: [],
      ok: true,
    });
  });

  it("fails when schema_migrations is empty", () => {
    expect(compareMigrations(["001_a.sql"], []).ok).toBe(false);
  });

  it("summarizes the report for humans", () => {
    const text = restoreDrillSummary({
      event: "restore_drill",
      ok: false,
      backup: {
        key: "backups/postgres/x.dump",
        createdAt: "2026-10-15T03:00:00.000Z",
        bytes: 2 * 1024 * 1024,
      },
      restoreSeconds: 4.2,
      checks: { clients_have_organization: false },
    });
    expect(text).toContain("Restore drill: FAILED");
    expect(text).toContain("2.0 MB");
    expect(text).toContain("FAIL clients_have_organization");
  });
});
