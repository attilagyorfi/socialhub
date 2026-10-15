import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = new PGlite();

// Server code talks to `pool`; route it to an in-memory PGlite database and
// report affected rows the way node-postgres does.
vi.mock("../packages/db", () => {
  const query = async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows };
  };
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async () => {}) }));
vi.mock("../packages/server/mail", () => mail);

const {
  approveAccessRequest,
  canCreateAccount,
  clientIp,
  isPlatformAdmin,
  listAccessRequests,
  rejectAccessRequest,
  shouldSendMagicLink,
  submitAccessRequest,
} = await import("../packages/server/access-requests");

const operatorEmail = "operator@example.test";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const mailsTo = (to: string) =>
  mail.sendMail.mock.calls.filter((call) => (call as unknown[])[0] === to);

beforeAll(async () => {
  Object.assign(process.env, {
    APP_URL: "https://hub.example",
    ACCESS_REQUEST_EMAIL: "access@example.test",
    PLATFORM_ADMIN_EMAILS: `Someone@example.test, ${operatorEmail.toUpperCase()}`,
  });
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(() => {
  mail.sendMail.mockClear();
  delete process.env.SIGNUP_MODE;
});

let operatorId: string | undefined;
async function workspace(email = operatorEmail, role = "OWNER") {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID();
  let user = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'client')",
    [client, org],
  );
  if (email === operatorEmail && operatorId) user = operatorId;
  else
    await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Op',$2)`, [
      user,
      email === operatorEmail ? email : `${user}-${email}`,
    ]);
  if (email === operatorEmail) operatorId = user;
  await db.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
    [org, user, role],
  );
  return {
    organizationId: org,
    clientId: client,
    userId: user,
    role: role as "OWNER" | "ADMIN",
  };
}

const unique = (prefix: string) =>
  `${prefix}-${crypto.randomUUID()}@example.test`;

async function requestRow(email: string) {
  return (
    await db.query<{ id: string; status: string; invitation_id: string }>(
      "SELECT * FROM access_requests WHERE email=$1",
      [email],
    )
  ).rows;
}

describe("access requests", () => {
  it("stores a request and notifies the operator once", async () => {
    const email = unique("Visitor").toUpperCase();
    expect(
      await submitAccessRequest({
        name: "Visitor",
        email: ` ${email} `,
        company: "Acme",
        message: "Szeretnénk kipróbálni.",
        locale: "en",
      }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    const [to, subject, text] = mail.sendMail.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(to).toBe("access@example.test");
    expect(subject).toContain("Visitor");
    expect(text).toContain(email.toLowerCase());
    expect(text).toContain("Acme");
    expect(text).toContain("https://hub.example");
    expect(await requestRow(email.toLowerCase())).toHaveLength(1);

    // A repeated request looks the same but sends nothing new.
    expect(
      await submitAccessRequest({
        name: "Visitor again",
        email,
        locale: "en",
      }),
    ).toEqual({ ok: true });
    await settle();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(await requestRow(email.toLowerCase())).toHaveLength(1);
  });

  it("answers identically for existing accounts without storing anything", async () => {
    const email = unique("member");
    await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'M',$2)`, [
      crypto.randomUUID(),
      email,
    ]);
    expect(
      await submitAccessRequest({ name: "M", email, locale: "hu" }),
    ).toEqual({ ok: true });
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await requestRow(email)).toHaveLength(0);
  });

  it("lets an operator approve a request with an invitation", async () => {
    const c = await workspace();
    const email = unique("approve");
    await submitAccessRequest({ name: "New", email, locale: "hu" });
    const pending = await listAccessRequests(c);
    const request = pending.find((row) => row.email === email);
    expect(request).toMatchObject({ name: "New", email });

    const invitation = await approveAccessRequest(
      c,
      request.id,
      "CONTENT_CREATOR",
      [c.clientId],
    );
    expect(invitation).toMatchObject({ email, role: "CONTENT_CREATOR" });
    expect(mailsTo(email)).toHaveLength(1);
    expect((await requestRow(email))[0]).toMatchObject({
      status: "APPROVED",
      invitation_id: invitation.id,
    });
    expect(
      (await listAccessRequests(c)).some((row) => row.id === request.id),
    ).toBe(false);
    await expect(
      approveAccessRequest(c, request.id, "CONTENT_CREATOR", [c.clientId]),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_HANDLED" });
    await expect(rejectAccessRequest(c, request.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("keeps the request pending when the invitation fails", async () => {
    const c = await workspace();
    const email = unique("invalid");
    await submitAccessRequest({ name: "X", email, locale: "hu" });
    const id = (await requestRow(email))[0].id;
    await expect(
      approveAccessRequest(c, id, "CONTENT_CREATOR", []),
    ).rejects.toMatchObject({ code: "CLIENT_REQUIRED" });
    expect((await requestRow(email))[0].status).toBe("PENDING");
  });

  it("rejects a request", async () => {
    const c = await workspace();
    const email = unique("reject");
    await submitAccessRequest({ name: "R", email, locale: "hu" });
    const id = (await requestRow(email))[0].id;
    expect(await rejectAccessRequest(c, id)).toEqual({ ok: true });
    expect((await requestRow(email))[0].status).toBe("REJECTED");
    await expect(rejectAccessRequest(c, id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("hides requests from everyone but platform operators", async () => {
    const email = unique("hidden");
    await submitAccessRequest({ name: "H", email, locale: "hu" });
    const id = (await requestRow(email))[0].id;
    const outsider = await workspace("owner@example.test");
    const member = { ...(await workspace()), role: "SOCIAL_MANAGER" as const };
    for (const c of [outsider, member]) {
      await expect(listAccessRequests(c)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        approveAccessRequest(c, id, "ADMIN", []),
      ).rejects.toMatchObject({ status: 403 });
      await expect(rejectAccessRequest(c, id)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect((await requestRow(email))[0].status).toBe("PENDING");
  });
});

describe("sign-up gate", () => {
  it("recognises platform administrators case-insensitively", () => {
    expect(isPlatformAdmin(" OPERATOR@example.test")).toBe(true);
    expect(isPlatformAdmin("someone@example.test")).toBe(true);
    expect(isPlatformAdmin("access@example.test")).toBe(false);
    const admins = process.env.PLATFORM_ADMIN_EMAILS;
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin("access@example.test")).toBe(true);
    process.env.PLATFORM_ADMIN_EMAILS = admins;
  });

  it("allows only invitees and administrators in invite mode", async () => {
    process.env.SIGNUP_MODE = "invite";
    const c = await workspace();
    const invited = unique("invited");
    await db.query(
      `INSERT INTO member_invitations(organization_id,email,role,token_hash,invited_by,expires_at)
       VALUES($1,$2,'VIEWER',$3,$4,now()+interval '1 day')`,
      [c.organizationId, invited, crypto.randomUUID(), c.userId],
    );
    const expired = unique("expired");
    await db.query(
      `INSERT INTO member_invitations(organization_id,email,role,token_hash,invited_by,expires_at)
       VALUES($1,$2,'VIEWER',$3,$4,now()-interval '1 day')`,
      [c.organizationId, expired, crypto.randomUUID(), c.userId],
    );
    expect(await canCreateAccount(invited.toUpperCase())).toBe(true);
    expect(await canCreateAccount(operatorEmail)).toBe(true);
    expect(await canCreateAccount(expired)).toBe(false);
    expect(await canCreateAccount(unique("stranger"))).toBe(false);

    process.env.SIGNUP_MODE = "open";
    expect(await canCreateAccount(unique("stranger"))).toBe(true);
  });

  it("sends magic links only to accounts and possible sign-ups", async () => {
    process.env.SIGNUP_MODE = "invite";
    const existing = unique("existing");
    await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'E',$2)`, [
      crypto.randomUUID(),
      existing,
    ]);
    expect(await shouldSendMagicLink(existing.toUpperCase())).toBe(true);
    expect(await shouldSendMagicLink(operatorEmail)).toBe(true);
    expect(await shouldSendMagicLink(unique("stranger"))).toBe(false);
    process.env.SIGNUP_MODE = "open";
    expect(await shouldSendMagicLink(unique("stranger"))).toBe(true);
  });
});

describe("client IP", () => {
  const ip = (headers: Record<string, string>) =>
    clientIp(new Request("https://hub.example", { headers }));
  it("trusts the edge's x-real-ip over forwarded addresses", () => {
    expect(
      ip({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1" }),
    ).toBe("203.0.113.7");
  });
  it("falls back to the proxy-appended last forwarded address", () => {
    expect(ip({ "x-forwarded-for": "1.1.1.1, 198.51.100.4 " })).toBe(
      "198.51.100.4",
    );
    expect(ip({})).toBe("unknown");
  });
});
