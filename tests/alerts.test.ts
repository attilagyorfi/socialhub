import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});

const sendMail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../packages/server/mail", () => ({ sendMail }));
const captureMessage = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", () => ({ captureMessage }));

const { runAlertChecks } = await import("../packages/server/alerts");

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec("DELETE FROM operational_alerts; DELETE FROM organizations;");
  sendMail.mockReset();
  sendMail.mockImplementation(async () => {});
  captureMessage.mockReset();
  process.env.ALERT_EMAIL = "ops@example.test";
  process.env.APP_URL = "https://hub.example.test";
});
afterEach(() => {
  delete process.env.ALERT_EMAIL;
  vi.restoreAllMocks();
});

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Acme')",
    [client, org],
  );
  return { org, client };
}

async function account(
  w: { org: string; client: string },
  tokenHealth = "EXPIRED",
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status,token_health)
     VALUES($1,$2,$3,'facebook','Page',$5,'direct','CONNECTED',$4)`,
    [id, w.org, w.client, tokenHealth, `page-${id}`],
  );
  return id;
}

async function deadPublishJob(w: { org: string; client: string }) {
  const accountId = await account(w, "HEALTHY");
  const post = crypto.randomUUID(),
    target = crypto.randomUUID(),
    job = crypto.randomUUID();
  await db.query(
    "INSERT INTO posts(id,organization_id,client_id,caption) VALUES($1,$2,$3,'secret caption')",
    [post, w.org, w.client],
  );
  await db.query(
    `INSERT INTO post_targets(id,organization_id,client_id,post_id,social_account_id,caption)
     VALUES($1,$2,$3,$4,$5,'secret caption')`,
    [target, w.org, w.client, post, accountId],
  );
  await db.query(
    `INSERT INTO publish_jobs(id,organization_id,client_id,target_id,run_at,status,last_error)
     VALUES($1,$2,$3,$4,now(),'DEAD','PROVIDER_ERROR')`,
    [job, w.org, w.client, target],
  );
  return job;
}

describe("operational alerts", () => {
  it("notifies a new problem once and does not repeat it", async () => {
    const w = await workspace();
    const accountId = await account(w);
    const first = await runAlertChecks();
    expect(first).toMatchObject({ new: 1, emailed: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [to, subject, text] = sendMail.mock.calls[0] as unknown as string[];
    expect(to).toBe("ops@example.test");
    expect(subject).toBe("[G2A Social Hub] 1 új üzemeltetési riasztás");
    expect(text).toContain("Agency / Acme");
    expect(text).toContain(accountId);
    expect(text).toContain("https://hub.example.test");
    expect(captureMessage).toHaveBeenCalledWith(
      "Operational alert: token_unhealthy",
      expect.objectContaining({
        level: "warning",
        tags: { kind: "token_unhealthy" },
      }),
    );

    const second = await runAlertChecks();
    expect(second).toMatchObject({ open: 1, new: 0, emailed: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("re-notifies a problem that reappears after it was resolved", async () => {
    const w = await workspace();
    const accountId = await account(w);
    await runAlertChecks();
    await db.query(
      "UPDATE social_accounts SET token_health='HEALTHY' WHERE id=$1",
      [accountId],
    );
    expect(await runAlertChecks()).toMatchObject({ resolved: 1, new: 0 });
    const row = await db.query<{ resolved_at: Date | null }>(
      "SELECT resolved_at FROM operational_alerts",
    );
    expect(row.rows[0].resolved_at).not.toBeNull();

    await db.query(
      "UPDATE social_accounts SET token_health='EXPIRED' WHERE id=$1",
      [accountId],
    );
    expect(await runAlertChecks()).toMatchObject({ new: 1, emailed: true });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("batches every new problem of a run into one email", async () => {
    const w = await workspace();
    await account(w);
    await account(w);
    const job = await deadPublishJob(w);
    expect(await runAlertChecks()).toMatchObject({ new: 3, emailed: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, subject, text] = sendMail.mock.calls[0] as unknown as string[];
    expect(subject).toBe("[G2A Social Hub] 3 új üzemeltetési riasztás");
    expect(text).toContain("(2 db, típus: token_unhealthy)");
    expect(text).toContain("(1 db, típus: publish_dead)");
    expect(text).toContain(job);
    expect(text).not.toContain("secret caption");
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it("logs and does not throw when ALERT_EMAIL is not set", async () => {
    delete process.env.ALERT_EMAIL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await account(await workspace());
    await expect(runAlertChecks()).resolves.toMatchObject({
      new: 1,
      emailed: false,
    });
    expect(sendMail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ALERT_EMAIL_MISSING"),
    );
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("retries the email on the next run after a delivery failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await account(await workspace());
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(runAlertChecks()).resolves.toMatchObject({
      new: 1,
      emailed: false,
    });
    const pending = await db.query<{ notified_at: Date | null }>(
      "SELECT notified_at FROM operational_alerts",
    );
    expect(pending.rows[0].notified_at).toBeNull();

    expect(await runAlertChecks()).toMatchObject({ new: 1, emailed: true });
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(await runAlertChecks()).toMatchObject({ new: 0 });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("raises one queue alert while due jobs wait longer than five minutes", async () => {
    const w = await workspace();
    const job = await deadPublishJob(w);
    await db.query(
      "UPDATE publish_jobs SET status='PENDING',run_at=now()-interval '10 minutes' WHERE id=$1",
      [job],
    );
    expect(await runAlertChecks()).toMatchObject({ new: 1 });
    const [, , text] = sendMail.mock.calls[0] as unknown as string[];
    expect(text).toContain("típus: queue_stuck");
    expect(text).toContain("10 perce vár");
  });
});
