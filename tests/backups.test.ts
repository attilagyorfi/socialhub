import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { name: string; input: any }[]);
const listed = vi.hoisted(() => ({
  items: [] as { Key: string; LastModified: Date }[],
}));

vi.mock("../packages/server/media", () => ({
  mediaBucket: () => "media-bucket",
  storageClient: () => ({
    send: async (command: { constructor: { name: string }; input: any }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListObjectsV2Command")
        return { Contents: listed.items, IsTruncated: false };
      return {};
    },
  }),
}));

// pg_dump is replaced by a stub that writes a small file to --file=…
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, out: { stdout: string }) => void,
  ) => {
    const file = args.find((arg) => arg.startsWith("--file="))!.slice(7);
    writeFileSync(file, "PGDMP-test");
    callback(null, { stdout: "" });
  },
}));

const { backupKey, expiredBackups, isBackupDue, runDueDatabaseBackup } =
  await import("../packages/server/backups");

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-14T03:00:00Z");

afterEach(() => {
  sent.length = 0;
  listed.items = [];
  delete process.env.BACKUP_ENABLED;
});

describe("backup scheduling", () => {
  it("names backups by time with an unguessable suffix", () => {
    expect(backupKey(now)).toMatch(
      /^backups\/postgres\/2026-10-14T03-00-00-000Z-[0-9a-f]{16}\.dump$/,
    );
  });

  it("runs once a day", () => {
    expect(isBackupDue([], now)).toBe(true);
    const recent = {
      key: "a",
      createdAt: new Date(now.getTime() - 2 * 3600e3),
    };
    expect(isBackupDue([recent], now)).toBe(false);
    const old = { key: "b", createdAt: new Date(now.getTime() - day) };
    expect(isBackupDue([old], now)).toBe(true);
  });

  it("expires old backups but always keeps the newest", () => {
    const backups = [3, 10, 20, 40].map((days) => ({
      key: `k${days}`,
      createdAt: new Date(now.getTime() - days * day),
    }));
    expect(expiredBackups(backups, now, 14).map((b) => b.key)).toEqual([
      "k20",
      "k40",
    ]);
    expect(expiredBackups(backups.slice(2), now, 14).map((b) => b.key)).toEqual(
      ["k40"],
    );
  });
});

describe("daily database backup", () => {
  it("does nothing unless enabled", async () => {
    await expect(runDueDatabaseBackup(now)).resolves.toEqual({
      status: "disabled",
    });
    expect(sent).toEqual([]);
  });

  it("uploads a dump and removes expired backups", async () => {
    process.env.BACKUP_ENABLED = "true";
    listed.items = [
      {
        Key: "backups/postgres/old.dump",
        LastModified: new Date(now.getTime() - 30 * day),
      },
      {
        Key: "backups/postgres/yesterday.dump",
        LastModified: new Date(now.getTime() - day),
      },
    ];
    const result = await runDueDatabaseBackup(now);
    expect(result).toMatchObject({ status: "created", bytes: 10, removed: 1 });
    const put = sent.find((call) => call.name === "PutObjectCommand")!;
    expect(put.input.Bucket).toBe("media-bucket");
    expect(put.input.Key).toMatch(/^backups\/postgres\/.+\.dump$/);
    const removed = sent.find((call) => call.name === "DeleteObjectsCommand")!;
    expect(removed.input.Delete.Objects).toEqual([
      { Key: "backups/postgres/old.dump" },
    ]);
  });

  it("skips when today's backup exists", async () => {
    process.env.BACKUP_ENABLED = "true";
    listed.items = [
      {
        Key: "backups/postgres/today.dump",
        LastModified: new Date(now.getTime() - 3600e3),
      },
    ];
    await expect(runDueDatabaseBackup(now)).resolves.toEqual({
      status: "not_due",
    });
    expect(sent.map((call) => call.name)).toEqual(["ListObjectsV2Command"]);
  });
});
