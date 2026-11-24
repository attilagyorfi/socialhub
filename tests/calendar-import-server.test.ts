import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PGlite();

vi.mock("../packages/db", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { sql } = await import("drizzle-orm");
  const query = (text: string, params?: unknown[]) => db.query(text, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
    db: drizzle({ client: db }),
    sql,
  };
});
// The session is the user ID in a test header.
vi.mock("../packages/server/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-user");
        return id ? { user: { id } } : null;
      },
    },
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("ioredis", async () => ({
  Redis: (await import("./fixtures/redis")).FakeRedis,
}));

const { sampleCsv, sampleJson } = await import(
  "../packages/core/calendar-import"
);
const { validateImportFile } = await import(
  "../packages/server/calendar-import"
);
const { POST } = await import("../apps/web/app/api/calendar/import/route");

const origin = new URL(process.env.APP_URL ?? "http://localhost:3010").origin;
const encode = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

async function member(org: string, role: string, client?: string) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)`, [
    id,
    role,
    `${id}@example.test`,
  ]);
  await db.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
    [org, id, client ? "VIEWER" : role],
  );
  if (client)
    await db.query(
      "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,$4)",
      [org, client, id, role],
    );
  return id;
}

async function account(org: string, client: string, status = "CONNECTED") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status)
     VALUES($1,$2,$3,'facebook','Account',$5,'mock',$4)`,
    [id, org, client, status, id],
  );
  return id;
}

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    sibling = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$3,'Client A'),($2,$3,'Client B')",
    [client, sibling, org],
  );
  return {
    org,
    client,
    owner: await member(org, "OWNER"),
    editor: await member(org, "CONTENT_CREATOR", client),
    reviewer: await member(org, "CLIENT_REVIEWER", client),
    viewer: await member(org, "VIEWER", client),
    facebook: await account(org, client),
    linkedin: await account(org, client),
    disconnected: await account(org, client, "DISCONNECTED"),
    siblingAccount: await account(org, sibling),
  };
}

function send(
  user: string,
  clientId: string,
  mode: "preview" | "import",
  content: string | Uint8Array,
  name = "december.csv",
) {
  const form = new FormData();
  form.set("clientId", clientId);
  form.set("mode", mode);
  form.set("file", new File([content as BlobPart], name));
  return POST(
    new Request(`${origin}/api/calendar/import`, {
      method: "POST",
      headers: { origin, "x-test-user": user },
      body: form,
    }),
  );
}

async function count(table: string, org: string, extra = "") {
  return (
    await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE organization_id=$1 ${extra}`,
      [org],
    )
  ).rows[0].count;
}

const counts = async (org: string) => ({
  posts: await count("posts", org),
  targets: await count("post_targets", org),
  audit: await count("audit_logs", org),
  jobs: await count("publish_jobs", org),
  webhooks: await count("webhook_deliveries", org),
});

const csv = (...rows: string[]) =>
  ["suggested_at;text;targets;media_urls;pillar", ...rows].join("\r\n");

describe("import validation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const errorsOf = (text: string, name = "x.csv") =>
    validateImportFile(encode(text), name).preview.rows.map((r) => [
      r.line,
      r.errors,
    ]);

  it("reports bad dates, duplicate targets and bad fields by file line", () => {
    expect(
      errorsOf(
        csv(
          `2026-12-01 09:00;Hello;${id};;`,
          `2026-12-02T09:00:00+01:00;"Két\nsor";${id}|${id};;`,
          `2026-12-03T09:00:00+01:00;   ;${id};http://example.com/a.jpg;`,
          `2026-12-04T09:00:00Z;Jó;${id};;`,
        ),
      ),
    ).toEqual([
      [
        2,
        [
          "Hibás dátum (suggested_at). Időzónával add meg, például: 2026-12-01T09:00:00+01:00.",
        ],
      ],
      [3, ["Egy célfiók egy soron belül csak egyszer szerepelhet."]],
      [
        5,
        [
          "A szöveg (text) kötelező.",
          "A média-URL-nek https:// kezdetű linknek kell lennie (media_urls).",
        ],
      ],
      [6, []],
    ]);
  });

  it("rejects a source field in JSON rows instead of dropping it", () => {
    const rows = validateImportFile(
      encode(
        JSON.stringify({
          drafts: [
            { text: "a", targets: [{ social_account_id: id }] },
            { text: "b", targets: [{ social_account_id: id }], source: "ge" },
            { text: "c", targets: [{ social_account_id: "nope" }], extra: 1 },
          ],
        }),
      ),
      "x.json",
    ).preview.rows;
    expect(rows.map((r) => [r.line, r.errors])).toEqual([
      [1, []],
      [
        2,
        ["Importnál a forrást a rendszer tölti ki, hagyd ki a source mezőt."],
      ],
      [
        3,
        [
          "A célfiók azonosítója (targets) nem érvényes azonosító.",
          "Ismeretlen mező: extra.",
        ],
      ],
    ]);
  });

  it("accepts the static sample files", () => {
    for (const [text, name] of [
      [sampleCsv([]), "minta.csv"],
      [sampleJson([]), "minta.json"],
    ]) {
      const { preview } = validateImportFile(encode(text), name);
      expect(preview.errors).toEqual([]);
      expect(preview.rows.every((r) => !r.errors.length)).toBe(true);
    }
  });

  it("enforces size, row count, format and encoding before anything else", () => {
    const big = new Uint8Array(1024 * 1024 + 1).fill(32);
    expect(() => validateImportFile(big, "x.csv")).toThrow(/1 MB/);
    const rows = Array.from({ length: 201 }, () => `;a;${id};;`);
    expect(() => validateImportFile(encode(csv(...rows)), "x.csv")).toThrow(
      /legfeljebb 200 sort/,
    );
    expect(() => validateImportFile(encode("a"), "x.xlsx")).toThrow(
      /\.csv vagy \.json/,
    );
    expect(() =>
      validateImportFile(new Uint8Array([0xc3, 0x28]), "x.csv"),
    ).toThrow(/UTF-8/);
  });
});

describe("calendar import endpoint", () => {
  it("previews account problems per row and writes nothing", async () => {
    const w = await workspace();
    const before = await counts(w.org);
    const response = await send(
      w.editor,
      w.client,
      "preview",
      csv(
        `;Rendben;${w.facebook}|${w.linkedin};;`,
        `;Idegen;${w.siblingAccount};;`,
        `;Leválasztott;${w.disconnected}|${crypto.randomUUID()};;`,
      ),
    );
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.ok).toBe(false);
    expect(preview.rows.map((r: { line: number }) => r.line)).toEqual([
      2, 3, 4,
    ]);
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[1].errors).toEqual([
      `Nincs ilyen célfiók ennél az ügyfélnél: ${w.siblingAccount}.`,
    ]);
    expect(preview.rows[2].errors).toHaveLength(2);
    expect(preview.rows[2].errors[0]).toMatch(/nincs csatlakoztatva/);
    expect(await counts(w.org)).toEqual(before);
  });

  it("imports nothing when any row fails, even after a clean preview", async () => {
    const w = await workspace();
    const before = await counts(w.org);
    const response = await send(
      w.editor,
      w.client,
      "import",
      csv(`;Jó;${w.facebook};;`, `;Rossz;${w.disconnected};;`),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("IMPORT_INVALID");
    expect(body.preview.rows[1].line).toBe(3);
    expect(await counts(w.org)).toEqual(before);
  });

  it("creates every row as an import DRAFT in one go, with audit events", async () => {
    const w = await workspace();
    // A subscribed endpoint: any webhook event would land in the outbox.
    await db.query(
      `INSERT INTO webhook_endpoints(organization_id,url,secret_ciphertext,secret_prefix,events)
       VALUES($1,'https://hooks.example.test/x','secret','whsec',
         ARRAY['post.approved','post.changes_requested','post.published','post.failed'])`,
      [w.org],
    );
    const before = await counts(w.org);
    const response = await send(
      w.editor,
      w.client,
      "import",
      sampleJson([w.facebook, w.linkedin]),
      "C:\\Users\\me\\Decem\u0007ber naptár.json",
    );
    expect(response.status).toBe(201);
    const { created, ids } = await response.json();
    expect(created).toBe(2);
    const posts = (
      await db.query<{
        status: string;
        source: string;
        author_id: string;
        scheduled_at: string | null;
        suggested_at: string | null;
      }>(
        "SELECT status,source,author_id,scheduled_at,suggested_at FROM posts WHERE id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post).toMatchObject({
        status: "DRAFT",
        source: "import",
        author_id: w.editor,
        scheduled_at: null,
      });
      expect(post.suggested_at).not.toBeNull();
    }
    const after = await counts(w.org);
    expect(after).toEqual({
      posts: before.posts + 2,
      targets: before.targets + 3,
      audit: before.audit + 3,
      jobs: before.jobs,
      webhooks: before.webhooks,
    });
    const events = (
      await db.query<{ action: string; actor_id: string; metadata: object }>(
        "SELECT action,actor_id,metadata FROM audit_logs WHERE organization_id=$1 ORDER BY action",
        [w.org],
      )
    ).rows;
    expect(events).toEqual([
      {
        action: "calendar.imported",
        actor_id: w.editor,
        metadata: {
          file_name: "December naptár.json",
          format: "json",
          rows: 2,
        },
      },
      ...[0, 1].map(() => ({
        action: "post.created",
        actor_id: w.editor,
        metadata: { source: "import", file_name: "December naptár.json" },
      })),
    ]);
  });

  it("imports the generated sample CSV", async () => {
    const w = await workspace();
    const response = await send(
      w.owner,
      w.client,
      "import",
      sampleCsv([w.facebook]),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).created).toBe(2);
  });

  it("rejects oversized files and writes nothing", async () => {
    const w = await workspace();
    const before = await counts(w.org);
    const response = await send(
      w.editor,
      w.client,
      "import",
      new Uint8Array(1024 * 1024 + 1).fill(32),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe(
      "A fájl túl nagy: legfeljebb 1 MB lehet.",
    );
    expect(await counts(w.org)).toEqual(before);
  });

  it("allows only roles that create posts, inside their organization", async () => {
    const w = await workspace();
    const other = await workspace();
    const file = csv(`;Jó;${w.facebook};;`);
    for (const user of [w.reviewer, w.viewer])
      for (const mode of ["preview", "import"] as const)
        expect((await send(user, w.client, mode, file)).status).toBe(403);
    for (const mode of ["preview", "import"] as const)
      expect((await send(other.owner, w.client, mode, file)).status).toBe(404);
    const forged = await POST(
      new Request(`${origin}/api/calendar/import`, {
        method: "POST",
        headers: { origin: "https://evil.example", "x-test-user": w.owner },
        body: new FormData(),
      }),
    );
    expect(forged.status).toBe(403);
    expect(await count("posts", w.org)).toBe(0);
  });
});
