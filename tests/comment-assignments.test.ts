import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = new PGlite();
// Statements of the code under test, and a hook that runs before each one.
const log: string[] = [];
let before: ((sql: string) => Promise<void>) | null = null;

vi.mock("../packages/db", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { sql } = await import("drizzle-orm");
  const query = async (text: string, params?: unknown[]) => {
    log.push(text);
    await before?.(text);
    const result = await db.query(text, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
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
        return id ? { user: { id, name: "Test", email: "t@x.test" } } : null;
      },
    },
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: async () => true,
}));
// No network is ever called: the comment functions of Meta are stand-ins.
const meta = vi.hoisted(() => ({
  replyMetaComment: vi.fn(),
  hideMetaComment: vi.fn(),
  fetchMetaComments: vi.fn(),
  fetchMetaRecentContent: vi.fn(),
  subscribeMetaWebhooks: vi.fn(),
}));
vi.mock("../packages/server/meta", async (original) => ({
  ...(await original<typeof import("../packages/server/meta")>()),
  ...meta,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { listComments, openCommentCount } = await import(
  "../packages/server/comments"
);
const { assignableRoles } = await import(
  "../packages/server/comment-assignments"
);
const { saveReplyTemplate, deleteReplyTemplate, listReplyTemplates } =
  await import("../packages/server/reply-templates");
const { exportUserData, processErasureRequests } = await import(
  "../packages/server/privacy"
);
const { sendMail } = await import("../packages/server/mail");
const { replyTemplateInput } = await import("../packages/server/validation");
const { REPLY_TEMPLATE_LIMIT } = await import(
  "../packages/core/reply-templates"
);
const commentsRoute = await import("../apps/web/app/api/comments/route");
const hubRoute = await import("../apps/web/app/api/hub/route");

const origin = new URL(process.env.APP_URL ?? "http://localhost:3010").origin;
const roles = [
  "OWNER",
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
] as const;
type Role = (typeof roles)[number];

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 60000);
afterAll(() => db.close());
afterEach(() => {
  before = null;
  expect(meta.replyMetaComment).not.toHaveBeenCalled();
  expect(sendMail).not.toHaveBeenCalled();
});

async function insertClient(org: string) {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
    [id, org],
  );
  return id;
}
async function insertUser(name: string) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)`, [
    id,
    name,
    `${id}@secret.test`,
  ]);
  return id;
}
async function join(org: string, client: string, user: string, role: Role) {
  await db.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
    [org, user, role],
  );
  if (role !== "OWNER" && role !== "ADMIN")
    await db.query(
      "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,$4)",
      [org, client, user, role],
    );
}

// One member per role, named after the role.
async function workspace() {
  const org = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  const client = await insertClient(org);
  const users = {} as Record<Role, string>;
  for (const role of roles) {
    users[role] = await insertUser(role);
    await join(org, client, users[role], role);
  }
  const account = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode,status)
     VALUES($1,$2,$3,'facebook','Page',$4,'mock','CONNECTED')`,
    [account, org, client, account],
  );
  const c = (role: Role) => ({
    organizationId: org,
    clientId: client,
    userId: users[role],
    role,
  });
  return { org, client, users, account, c };
}
type W = Awaited<ReturnType<typeof workspace>>;

let minute = 0;
async function comment(
  w: W,
  fields: {
    parent?: string;
    fromPage?: boolean;
    deleted?: boolean;
    status?: "OPEN" | "DONE";
    platform?: "facebook" | "instagram";
  } = {},
) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO social_comments(id,organization_id,client_id,social_account_id,platform,
       remote_id,parent_remote_id,object_remote_id,author_name,message,from_page,deleted,
       status,remote_created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'post','Anna','Titkos szöveg',$8,$9,$10,$11)`,
    [
      id,
      w.org,
      w.client,
      w.account,
      fields.platform ?? "facebook",
      `r-${id}`,
      fields.parent ? `r-${fields.parent}` : null,
      fields.fromPage ?? false,
      fields.deleted ?? false,
      fields.status ?? "OPEN",
      new Date(Date.UTC(2026, 10, 1) + ++minute * 60_000),
    ],
  );
  return id;
}

async function request(
  route: {
    GET(r: Request): Promise<Response>;
    POST(r: Request): Promise<Response>;
  },
  user: string,
  path: string,
  body?: unknown,
) {
  const response = await (body === undefined ? route.GET : route.POST)(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "x-test-user": user },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}
const assign = (
  w: W,
  by: Role,
  id: string,
  assigneeId: unknown,
  expectedAssigneeId?: unknown,
) =>
  request(commentsRoute, w.users[by], "/api/comments", {
    action: "assign",
    clientId: w.client,
    id,
    assigneeId,
    expectedAssigneeId,
  });
const list = (w: W, as: Role, query = "") =>
  request(
    commentsRoute,
    w.users[as],
    `/api/comments?clientId=${w.client}&status=ALL${query}`,
  );
const hub = (w: W, as: Role, body: Record<string, unknown>) =>
  request(hubRoute, w.users[as], "/api/hub", { clientId: w.client, ...body });
const stored = async (id: string) =>
  (
    await db.query<{ user_id: string }>(
      "SELECT user_id FROM comment_assignments WHERE comment_id=$1",
      [id],
    )
  ).rows[0]?.user_id ?? null;
const audits = async (w: W, prefix: string) =>
  (
    await db.query<{ action: string; metadata: Record<string, string> }>(
      "SELECT action,metadata FROM audit_logs WHERE organization_id=$1 AND action LIKE $2 ORDER BY created_at",
      [w.org, `${prefix}%`],
    )
  ).rows;
const ids = (result: { body: { threads: { id: string }[] } }) =>
  result.body.threads.map((thread) => thread.id);

describe("migration 031", () => {
  it("only creates two tables and their own indexes", async () => {
    const sql = (
      await readFile(
        new URL(
          "../packages/db/migrations/031_comment_templates_assignments.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).replace(/--.*$/gm, "");
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(
      statements.map((statement) =>
        statement
          .match(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX \w+\s+ON) (\w+)/)
          ?.at(1),
      ),
    ).toEqual([
      "client_reply_templates",
      "client_reply_templates",
      "comment_assignments",
      "comment_assignments",
      "comment_assignments",
    ]);
    const runner = await readFile(
      new URL("../scripts/migrate.ts", import.meta.url),
      "utf8",
    );
    expect(
      runner.match(/031_comment_templates_assignments\.sql/g),
    ).toHaveLength(1);
  });
});

describe("reply templates", () => {
  it("lets only managers change templates and records each change", async () => {
    const w = await workspace();
    for (const role of roles) {
      const manager = role === "OWNER" || role === "ADMIN";
      const created = await hub(w, role, {
        action: "templates.save",
        name: `Sablon ${role}`,
        body: "Szia {név}!",
      });
      expect(created.status).toBe(manager ? 200 : 403);
      const id = manager ? created.body.id : crypto.randomUUID();
      const updated = await hub(w, role, {
        action: "templates.save",
        id,
        name: `sablon ${role}`,
        body: "Új szöveg",
      });
      expect(updated.status).toBe(manager ? 200 : 403);
      const deleted = await hub(w, role, { action: "templates.delete", id });
      expect(deleted.status).toBe(manager ? 200 : 403);
    }
    expect(
      (await audits(w, "reply_template.")).map((row) => row.action),
    ).toEqual(
      ["OWNER", "ADMIN"].flatMap(() => [
        "reply_template.created",
        "reply_template.updated",
        "reply_template.deleted",
      ]),
    );
    expect(await listReplyTemplates(w.c("OWNER"))).toEqual([]);
  });

  it("validates the lengths", async () => {
    const w = await workspace();
    const save = (name: string, body: string) =>
      hub(w, "OWNER", { action: "templates.save", name, body });
    expect((await save("n".repeat(80), "b".repeat(2000))).status).toBe(200);
    for (const [name, body] of [
      ["n".repeat(81), "b"],
      ["n", "b".repeat(2001)],
      ["  ", "b"],
      ["n", " \n "],
      ["n", "a\0b"],
    ])
      expect((await save(name, body)).status).toBe(422);
    expect(replyTemplateInput.parse({ name: " a ", body: " b " })).toEqual({
      name: "a",
      body: "b",
    });
  });

  it("answers 409 for a taken name, also when a rival save gets in between", async () => {
    const w = await workspace();
    const c = w.c("OWNER");
    const first = await saveReplyTemplate(c, { name: "Köszönet", body: "a" });
    const taken = { status: 409, code: "REPLY_TEMPLATE_EXISTS" };
    await expect(
      saveReplyTemplate(c, { name: "kÖSZÖNET", body: "b" }),
    ).rejects.toMatchObject(taken);
    await saveReplyTemplate(c, { name: "Nyitva", body: "b" });
    // Renaming to itself in another case is fine, to another one is not.
    await saveReplyTemplate(c, { name: "köszönet", body: "c" }, first.id);
    await expect(
      saveReplyTemplate(c, { name: "NYITVA", body: "c" }, first.id),
    ).rejects.toMatchObject(taken);
    // Another client may use the same name.
    const other = { ...c, clientId: await insertClient(w.org) };
    await saveReplyTemplate(other, { name: "Köszönet", body: "a" });

    log.length = 0;
    before = async (sql) => {
      if (!sql.startsWith("INSERT INTO client_reply_templates")) return;
      before = null;
      await db.query(
        "INSERT INTO client_reply_templates(organization_id,client_id,name,body) VALUES($1,$2,'VERSENY','x')",
        [w.org, w.client],
      );
    };
    const rival = await hub(w, "OWNER", {
      action: "templates.save",
      name: "verseny",
      body: "y",
    });
    expect(rival).toMatchObject({
      status: 409,
      body: { code: "REPLY_TEMPLATE_EXISTS" },
    });
    const begin = log.indexOf("BEGIN");
    expect(log[begin + 1]).toMatch(/FROM clients .* FOR UPDATE$/);
  });

  it("stops at the limit but still edits there", async () => {
    const w = await workspace();
    const c = w.c("ADMIN");
    await db.query(
      `INSERT INTO client_reply_templates(organization_id,client_id,name,body)
       SELECT $1,$2,'Sablon '||n,'x' FROM generate_series(1,$3::int) n`,
      [w.org, w.client, REPLY_TEMPLATE_LIMIT],
    );
    await expect(
      saveReplyTemplate(c, { name: "Még egy", body: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "REPLY_TEMPLATE_LIMIT" });
    const [template] = await listReplyTemplates(c);
    await saveReplyTemplate(c, { name: "Átnevezve", body: "y" }, template.id);
    await deleteReplyTemplate(c, template.id);
    await saveReplyTemplate(c, { name: "Még egy", body: "x" });
    expect(await listReplyTemplates(c)).toHaveLength(REPLY_TEMPLATE_LIMIT);
  });

  it("answers 404 for another organization, client or template", async () => {
    const w = await workspace();
    const stranger = await workspace();
    const foreign = await saveReplyTemplate(stranger.c("OWNER"), {
      name: "Idegen",
      body: "x",
    });
    const sibling = await saveReplyTemplate(
      { ...w.c("OWNER"), clientId: await insertClient(w.org) },
      { name: "Másik ügyfél", body: "x" },
    );
    for (const id of [foreign.id, sibling.id, crypto.randomUUID()]) {
      const fields = { id, name: "Átírva", body: "x" };
      expect(
        (await hub(w, "OWNER", { action: "templates.save", ...fields })).status,
      ).toBe(404);
      expect(
        (await hub(w, "OWNER", { action: "templates.delete", id })).status,
      ).toBe(404);
    }
    const create = { action: "templates.save", name: "a", body: "b" };
    expect(
      (await hub(w, "OWNER", { ...create, clientId: stranger.client })).status,
    ).toBe(404);
    // A context mixing two organizations finds no client either.
    await expect(
      saveReplyTemplate(
        { ...w.c("OWNER"), clientId: stranger.client },
        { name: "a", body: "b" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await listReplyTemplates(stranger.c("OWNER"))).toEqual([foreign]);
  });

  it("is part of the hub data and goes away with the client", async () => {
    const w = await workspace();
    const saved = await saveReplyTemplate(w.c("OWNER"), {
      name: "Köszönet",
      body: "Köszi, {név}!",
    });
    const data = await request(
      hubRoute,
      w.users.SOCIAL_MANAGER,
      `/api/hub?clientId=${w.client}`,
    );
    expect(data.status).toBe(200);
    expect(data.body.replyTemplates).toEqual([saved]);
    const nobody = await request(
      hubRoute,
      await insertUser("Nobody"),
      "/api/hub",
    );
    expect(nobody.body.replyTemplates).toEqual([]);
    await db.query("DELETE FROM clients WHERE id=$1", [w.client]);
    expect(await listReplyTemplates(w.c("OWNER"))).toEqual([]);
  });
});

describe("assigning comments", () => {
  it("assigns, moves and removes with create rights only", async () => {
    const w = await workspace();
    for (const role of roles) {
      const id = await comment(w);
      const allowed = role !== "CLIENT_REVIEWER" && role !== "VIEWER";
      const owner = w.users.OWNER;
      const manager = w.users.SOCIAL_MANAGER;
      const assigned = await assign(w, role, id, owner, null);
      if (!allowed) {
        expect(assigned.status).toBe(403);
        expect(await stored(id)).toBeNull();
        continue;
      }
      expect(assigned).toEqual({
        status: 200,
        body: { assignee: { id: owner, name: "OWNER" } },
      });
      expect((await assign(w, role, id, manager, owner)).status).toBe(200);
      expect(await stored(id)).toBe(manager);
      expect((await assign(w, role, id, null, manager)).body).toEqual({
        assignee: null,
      });
      expect(await stored(id)).toBeNull();
      const rows = (await audits(w, "comment.")).slice(-3);
      expect(rows).toEqual([
        { action: "comment.assigned", metadata: { assignedTo: owner } },
        {
          action: "comment.assigned",
          metadata: { assignedTo: manager, previousAssignee: owner },
        },
        {
          action: "comment.unassigned",
          metadata: { previousAssignee: manager },
        },
      ]);
    }
    expect(JSON.stringify(await audits(w, "comment."))).not.toContain("@");
  });

  it("does not record a request that changes nothing", async () => {
    const w = await workspace();
    const id = await comment(w);
    const owner = w.users.OWNER;
    await assign(w, "OWNER", id, null, null);
    await assign(w, "OWNER", id, owner, null);
    const again = await assign(w, "OWNER", id, owner, owner.toUpperCase());
    expect(again.status).toBe(200);
    expect(await audits(w, "comment.")).toHaveLength(1);
  });

  it("accepts only members who may work on this client now", async () => {
    expect(assignableRoles).toEqual([
      "OWNER",
      "ADMIN",
      "SOCIAL_MANAGER",
      "CONTENT_CREATOR",
    ]);
    const w = await workspace();
    for (const role of assignableRoles)
      expect(
        (await assign(w, "OWNER", await comment(w), w.users[role], null))
          .status,
      ).toBe(200);
    // Member of another client only; organization member without any client.
    const elsewhere = await insertUser("Elsewhere");
    await join(w.org, await insertClient(w.org), elsewhere, "SOCIAL_MANAGER");
    const loose = await insertUser("Loose");
    await db.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'SOCIAL_MANAGER')",
      [w.org, loose],
    );
    const foreign = (await workspace()).users.OWNER;
    const id = await comment(w);
    const answers = [];
    for (const user of [
      w.users.CLIENT_REVIEWER,
      w.users.VIEWER,
      elsewhere,
      loose,
      foreign,
      crypto.randomUUID(),
    ])
      answers.push(await assign(w, "OWNER", id, user, null));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({
      status: 422,
      body: { code: "ASSIGNEE_NOT_ALLOWED" },
    });
    expect(await stored(id)).toBeNull();
  });

  it("finds only the client's own, existing threads", async () => {
    const w = await workspace();
    const stranger = await workspace();
    const root = await comment(w);
    const siblingClient = { ...w, client: await insertClient(w.org) };
    for (const [scope, id] of [
      [w, await comment(stranger)],
      [w, await comment(w, { deleted: true })],
      [w, crypto.randomUUID()],
      [siblingClient, root],
    ] as const)
      expect(
        (await assign(scope, "OWNER", id, w.users.OWNER, null)).status,
      ).toBe(404);
    expect(
      (
        await assign(
          { ...w, client: stranger.client },
          "OWNER",
          root,
          null,
          null,
        )
      ).status,
    ).toBe(404);
    for (const id of [
      await comment(w, { parent: root }),
      await comment(w, { fromPage: true }),
    ]) {
      expect(await assign(w, "OWNER", id, w.users.OWNER, null)).toMatchObject({
        status: 422,
        body: { code: "COMMENT_NOT_ASSIGNABLE" },
      });
      expect(await stored(id)).toBeNull();
    }
  });

  it("requires the expected value and never overwrites someone else's change", async () => {
    const w = await workspace();
    const id = await comment(w);
    const { OWNER, ADMIN, SOCIAL_MANAGER } = w.users;
    for (const missing of [undefined, "", 5])
      expect((await assign(w, "OWNER", id, OWNER, missing)).status).toBe(422);
    expect((await assign(w, "OWNER", id, undefined, null)).status).toBe(422);
    expect(await stored(id)).toBeNull();

    log.length = 0;
    expect((await assign(w, "OWNER", id, OWNER, null)).status).toBe(200);
    // Serialized on the comment itself, before anything else is read.
    expect(log[log.indexOf("BEGIN") + 1]).toMatch(
      /FROM social_comments[\s\S]*FOR UPDATE$/,
    );
    // Both saw nobody assigned; the second one loses.
    for (const [assignee, expected] of [
      [ADMIN, null],
      [null, null],
      [OWNER, null],
      [ADMIN, SOCIAL_MANAGER],
      [null, SOCIAL_MANAGER],
    ]) {
      expect(await assign(w, "ADMIN", id, assignee, expected)).toMatchObject({
        status: 409,
        body: { code: "COMMENT_ASSIGNMENT_CONFLICT" },
      });
      expect(await stored(id)).toBe(OWNER);
    }
    expect(await audits(w, "comment.")).toHaveLength(1);
    // Removed meanwhile: the stale value does not bring it back.
    await assign(w, "OWNER", id, null, OWNER);
    expect((await assign(w, "ADMIN", id, ADMIN, OWNER)).status).toBe(409);
    expect(await stored(id)).toBeNull();
  });

  it("treats removed and demoted members as nobody", async () => {
    const w = await workspace();
    const kept = await comment(w);
    const lost: string[] = [];
    await assign(w, "OWNER", kept, w.users.ADMIN, null);
    const revoke = [
      (user: string) =>
        db.query("DELETE FROM organization_members WHERE user_id=$1", [user]),
      (user: string) =>
        db.query("DELETE FROM client_members WHERE user_id=$1", [user]),
      (user: string) =>
        db.query("UPDATE client_members SET role='VIEWER' WHERE user_id=$1", [
          user,
        ]),
      (user: string) =>
        db.query(
          "UPDATE client_members SET role='CLIENT_REVIEWER' WHERE user_id=$1",
          [user],
        ),
    ];
    for (const step of revoke) {
      const user = await insertUser("Leaver");
      await join(w.org, w.client, user, "SOCIAL_MANAGER");
      const id = await comment(w);
      expect((await assign(w, "OWNER", id, user, null)).status).toBe(200);
      const mine = await listComments(
        { ...w.c("SOCIAL_MANAGER"), userId: user },
        { status: "ALL", assignee: "me" },
      );
      expect(mine.threads.map((thread) => thread.id)).toEqual([id]);
      await step(user);
      expect(await stored(id)).toBe(user);
      lost.push(id);
    }
    lost.reverse();
    const all = await list(w, "OWNER");
    expect(ids(all)).toEqual([...lost, kept]);
    expect(
      all.body.threads.map((thread: { assignee: unknown }) => thread.assignee),
    ).toEqual([...lost.map(() => null), { id: w.users.ADMIN, name: "ADMIN" }]);
    const none = await list(w, "OWNER", "&assignee=none");
    expect(ids(none)).toEqual(lost);
    expect(none.body.filteredOpenCount).toBe(lost.length);
    for (const role of ["OWNER", "SOCIAL_MANAGER"] as const)
      expect(ids(await list(w, role, "&assignee=me"))).toEqual([]);
    // Reassigned from "nobody"; taking it off clears the leftover row.
    expect(
      (await assign(w, "OWNER", lost[0], w.users.OWNER, null)).status,
    ).toBe(200);
    expect(await stored(lost[0])).toBe(w.users.OWNER);
    const recorded = (await audits(w, "comment.")).length;
    expect((await assign(w, "OWNER", lost[1], null, null)).status).toBe(200);
    expect(await stored(lost[1])).toBeNull();
    expect(await audits(w, "comment.")).toHaveLength(recorded);
  });
});

describe("assignee filter", () => {
  it("pages completely and counts what the filter shows", async () => {
    const w = await workspace();
    const me = w.users.SOCIAL_MANAGER;
    const mine: string[] = [];
    const free: string[] = [];
    for (let index = 0; index < 60; index++) {
      const id = await comment(w, {
        status: index % 10 === 0 ? "DONE" : "OPEN",
        platform: index % 4 === 0 ? "instagram" : "facebook",
      });
      if (index % 2) {
        await assign(w, "OWNER", id, me, null);
        mine.unshift(id);
      } else free.unshift(id);
    }
    const open = await openCommentCount(w.c("OWNER"));
    expect(open).toBe(54);
    for (const [query, expected, openExpected] of [
      ["&assignee=me", mine, 30],
      ["&assignee=none", free, 24],
      ["&assignee=all", null, 54],
      ["", null, 54],
    ] as const) {
      const seen: string[] = [];
      let cursor = "";
      let pages = 0;
      do {
        const page = await list(w, "SOCIAL_MANAGER", `${query}${cursor}`);
        expect(page.status).toBe(200);
        expect(page.body.openCount).toBe(open);
        expect(page.body.filteredOpenCount).toBe(openExpected);
        seen.push(...ids(page));
        cursor = page.body.nextBefore
          ? `&before=${encodeURIComponent(page.body.nextBefore)}`
          : "";
        pages++;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      if (expected) expect(seen).toEqual(expected);
      else expect(seen).toHaveLength(60);
      expect(pages).toBe(expected ? 2 : 3);
    }
    // The network filter narrows the same count; the badge stays.
    const network = await list(
      w,
      "SOCIAL_MANAGER",
      "&assignee=none&platform=instagram",
    );
    expect(network.body.filteredOpenCount).toBe(12);
    expect(network.body.openCount).toBe(open);
    const openOnly = await listComments(w.c("SOCIAL_MANAGER"), {
      status: "OPEN",
      platform: "instagram",
      assignee: "none",
    });
    expect(openOnly.threads).toHaveLength(12);
    const badge = await request(hubRoute, me, `/api/hub?clientId=${w.client}`);
    expect(badge.body.commentsOpen).toBe(open);
  }, 60000);

  it("rejects an unknown filter instead of showing everything", async () => {
    const w = await workspace();
    for (const value of ["", "mine", "ME", w.users.OWNER])
      expect((await list(w, "OWNER", `&assignee=${value}`)).status).toBe(422);
  });
});

describe("who learns about assignments", () => {
  it("keeps members and assignees from reviewers and viewers", async () => {
    const w = await workspace();
    const id = await comment(w);
    await assign(w, "OWNER", id, w.users.ADMIN, null);
    await assign(w, "OWNER", id, w.users.SOCIAL_MANAGER, w.users.ADMIN);
    await assign(w, "OWNER", id, null, w.users.SOCIAL_MANAGER);
    await assign(w, "OWNER", id, w.users.SOCIAL_MANAGER, null);
    for (const role of roles) {
      const result = await list(w, role);
      const text = JSON.stringify(result.body);
      expect(result.status).toBe(200);
      expect(text).not.toContain("secret.test");
      expect(text).not.toContain("email");
      const data = await request(
        hubRoute,
        w.users[role === "OWNER" || role === "ADMIN" ? "SOCIAL_MANAGER" : role],
        `/api/hub?clientId=${w.client}`,
      );
      const entries = data.body.audit.filter((row: { action: string }) =>
        /^comment\.(un)?assigned$/.test(row.action),
      );
      expect(entries).toHaveLength(4);
      if (role === "CLIENT_REVIEWER" || role === "VIEWER") {
        expect(result.body).not.toHaveProperty("assignableMembers");
        expect(result.body.threads[0]).not.toHaveProperty("assignee");
        expect(text).not.toContain("SOCIAL_MANAGER");
        expect(text).not.toContain(w.users.SOCIAL_MANAGER);
        for (const filter of ["me", "none"])
          expect((await list(w, role, `&assignee=${filter}`)).status).toBe(403);
        expect((await list(w, role, "&assignee=all")).status).toBe(200);
        for (const entry of entries) expect(entry.metadata).toEqual({});
      } else {
        expect(result.body.assignableMembers).toEqual(
          [...assignableRoles]
            .sort()
            .map((name) => ({ id: w.users[name], name })),
        );
        expect(result.body.threads[0].assignee).toEqual({
          id: w.users.SOCIAL_MANAGER,
          name: "SOCIAL_MANAGER",
        });
        expect(JSON.stringify(entries)).toContain(w.users.SOCIAL_MANAGER);
      }
      expect(result.body.canReply).toBe(
        ["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(role),
      );
    }
  });

  it("still sends replies only with publish rights", async () => {
    const w = await workspace();
    const id = await comment(w);
    for (const role of [
      "CONTENT_CREATOR",
      "CLIENT_REVIEWER",
      "VIEWER",
    ] as const)
      expect(
        (
          await request(commentsRoute, w.users[role], "/api/comments", {
            action: "reply",
            clientId: w.client,
            id,
            message: "Köszi!",
          })
        ).status,
      ).toBe(403);
  });
});

describe("stored assignments", () => {
  it("disappear with the comment, client, organization or user", async () => {
    for (const [table, key] of [
      ["social_comments", "comment"],
      ["clients", "client"],
      ["organizations", "org"],
      [`"user"`, "user"],
    ] as const) {
      const w = await workspace();
      const id = await comment(w);
      await assign(w, "OWNER", id, w.users.SOCIAL_MANAGER, null);
      await db.query(`DELETE FROM ${table} WHERE id=$1`, [
        {
          comment: id,
          client: w.client,
          org: w.org,
          user: w.users.SOCIAL_MANAGER,
        }[key],
      ]);
      expect(await stored(id)).toBeNull();
      if (key === "user") expect(ids(await list(w, "OWNER"))).toEqual([id]);
    }
    // The person who assigned it may go; the assignment stays.
    const w = await workspace();
    const id = await comment(w);
    await assign(w, "ADMIN", id, w.users.OWNER, null);
    await db.query(`DELETE FROM "user" WHERE id=$1`, [w.users.ADMIN]);
    expect(await stored(id)).toBe(w.users.OWNER);
  });

  it("cannot mix the organization, client and comment", async () => {
    const w = await workspace();
    const stranger = await workspace();
    const id = await comment(w);
    const sibling = await insertClient(w.org);
    for (const [org, client] of [
      [w.org, sibling],
      [w.org, stranger.client],
      [stranger.org, stranger.client],
    ])
      await expect(
        db.query(
          "INSERT INTO comment_assignments(comment_id,organization_id,client_id,user_id) VALUES($1,$2,$3,$4)",
          [id, org, client, w.users.OWNER],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.query(
        "INSERT INTO client_reply_templates(organization_id,client_id,name,body) VALUES($1,$2,'a','b')",
        [w.org, stranger.client],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("privacy", () => {
  it("exports my assigned comments without their content", async () => {
    const w = await workspace();
    const id = await comment(w);
    await assign(w, "OWNER", id, w.users.ADMIN, null);
    const data = await exportUserData(w.users.ADMIN);
    expect(data.assignedComments).toEqual([
      {
        organization_id: w.org,
        client_id: w.client,
        comment_id: id,
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/Titkos szöveg|Anna/);
    expect((await exportUserData(w.users.OWNER)).assignedComments).toEqual([]);
  });

  it("removes an erased user from audit entries written by others", async () => {
    const w = await workspace();
    const { ADMIN } = w.users;
    const gone = w.users.SOCIAL_MANAGER;
    const id = await comment(w);
    await assign(w, "OWNER", id, gone, null);
    await assign(w, "OWNER", id, ADMIN, gone);
    await assign(w, "OWNER", id, gone, ADMIN);
    await assign(w, "OWNER", id, null, gone);
    await db.query(
      `INSERT INTO privacy_requests(request_type,subject_user_id,requester_id,execute_after)
       VALUES('USER_ERASURE',$1,$1,now()-interval '1 minute')`,
      [gone],
    );
    expect(await processErasureRequests()).toEqual({ completed: 1, failed: 0 });
    const rows = await audits(w, "comment.");
    expect(JSON.stringify(rows)).not.toContain(gone);
    // Other people's values and the entries themselves stay.
    expect(rows).toEqual([
      { action: "comment.assigned", metadata: {} },
      { action: "comment.assigned", metadata: { assignedTo: ADMIN } },
      { action: "comment.assigned", metadata: { previousAssignee: ADMIN } },
      { action: "comment.unassigned", metadata: {} },
    ]);
    expect(await stored(id)).toBeNull();
    expect(ids(await list(w, "OWNER"))).toEqual([id]);
  });
});
