import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildInstagramGrid,
  type GridMedia,
  type GridSourceRow,
} from "../packages/core/instagram-grid";

const db = new PGlite();

vi.mock("../packages/db", () => {
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) },
  };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../packages/server/queue", async (original) => ({
  ...(await original<typeof import("../packages/server/queue")>()),
  rateLimit: async () => true,
}));
// Storage is faked: the proxy must read only the key the server resolved.
const stored = vi.fn(async (key: string) => key);
vi.mock("../packages/server/media", async (original) => ({
  ...(await original<typeof import("../packages/server/media")>()),
  mediaBucket: () => "bucket",
  storageClient: () => ({
    send: async (command: { input: { Key: string } }) => {
      const body = await stored(command.input.Key);
      return {
        Body: { transformToWebStream: () => new Blob([body]).stream() },
      };
    },
  }),
}));

process.env.APP_URL = "http://localhost:3010";

const { bundleView, createApprovalBundle, revokeApprovalBundle } = await import(
  "../packages/server/approval-bundles"
);
const gridRoute = await import(
  "../apps/web/app/api/approval-bundle/[token]/grid/[n]/route"
);
const { instagramGrid } = await import("../packages/server/instagram-grid");

const uuidPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

beforeAll(async () => {
  const directory = new URL("../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
}, 30000);
afterAll(() => db.close());

function row(overrides: Partial<GridSourceRow>): GridSourceRow {
  return {
    postId: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
    platform: "instagram",
    postStatus: "SCHEDULED",
    targetStatus: "SCHEDULED",
    scheduledAt: null,
    publishedAt: null,
    caption: "",
    mediaIds: [],
    ...overrides,
  };
}

describe("buildInstagramGrid", () => {
  it("orders published and planned posts newest first and marks the planned ones", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rows = [
      row({
        caption: "old published",
        postStatus: "PUBLISHED",
        targetStatus: "PUBLISHED",
        scheduledAt: "2026-12-30T10:00:00Z", // ignored: published_at counts
        publishedAt: "2026-11-01T10:00:00Z",
      }),
      row({
        caption: "waiting",
        postStatus: "PENDING_APPROVAL",
        targetStatus: "DRAFT",
        scheduledAt: "2026-12-05T10:00:00Z",
      }),
      row({ caption: "scheduled", scheduledAt: "2026-12-20T10:00:00Z" }),
      row({
        caption: "new published",
        postStatus: "PUBLISHED",
        targetStatus: "PUBLISHED",
        publishedAt: "2026-11-15T10:00:00Z",
      }),
      row({
        caption: "facebook",
        platform: "facebook",
        scheduledAt: "2026-12-25T10:00:00Z",
      }),
      row({
        caption: "draft",
        postStatus: "DRAFT",
        targetStatus: "DRAFT",
        scheduledAt: "2026-12-26T10:00:00Z",
      }),
      row({
        caption: "failed",
        postStatus: "FAILED",
        targetStatus: "FAILED",
        scheduledAt: "2026-12-27T10:00:00Z",
      }),
      row({
        caption: "cancelled",
        postStatus: "SCHEDULED",
        targetStatus: "CANCELLED",
        scheduledAt: "2026-12-28T10:00:00Z",
      }),
    ];
    const grid = buildInstagramGrid(rows, new Map());
    expect(grid.map((item) => [item.caption, item.state])).toEqual([
      ["scheduled", "planned"],
      ["waiting", "planned"],
      ["new published", "published"],
      ["old published", "published"],
    ]);
    expect(grid[3].at).toBe("2026-11-01T10:00:00.000Z");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses a carousel's first image as cover and a placeholder without image", () => {
    const media = new Map<string, GridMedia>([
      [
        "first",
        { id: "first", mimeType: "image/jpeg", ready: true, hasPreview: false },
      ],
      [
        "second",
        { id: "second", mimeType: "image/png", ready: true, hasPreview: false },
      ],
      [
        "video",
        { id: "video", mimeType: "video/mp4", ready: true, hasPreview: false },
      ],
      [
        "clip",
        { id: "clip", mimeType: "video/mp4", ready: true, hasPreview: true },
      ],
      [
        "busy",
        { id: "busy", mimeType: "image/jpeg", ready: false, hasPreview: false },
      ],
    ]);
    const at = (day: number) =>
      `2026-12-${String(day).padStart(2, "0")}T10:00:00Z`;
    const grid = buildInstagramGrid(
      [
        row({
          caption: "carousel",
          mediaIds: ["first", "second"],
          scheduledAt: at(9),
        }),
        row({ caption: "text only", scheduledAt: at(8) }),
        row({ caption: "video", mediaIds: ["video"], scheduledAt: at(7) }),
        row({ caption: "clip", mediaIds: ["clip"], scheduledAt: at(6) }),
        row({ caption: "processing", mediaIds: ["busy"], scheduledAt: at(5) }),
      ],
      media,
    );
    expect(
      grid.map((item) => [item.caption, item.cover, item.mediaCount]),
    ).toEqual([
      ["carousel", { id: "first", mimeType: "image/jpeg", preview: false }, 2],
      ["text only", null, 0],
      ["video", null, 1],
      ["clip", { id: "clip", mimeType: "image/jpeg", preview: true }, 1],
      ["processing", null, 1],
    ]);
  });

  it("keeps the newest published and the soonest planned posts within limits", () => {
    const published = [1, 2, 3].map((day) =>
      row({
        caption: `p${day}`,
        postStatus: "PUBLISHED",
        targetStatus: "PUBLISHED",
        publishedAt: `2026-11-0${day}T10:00:00Z`,
      }),
    );
    const planned = [1, 2, 3].map((day) =>
      row({ caption: `s${day}`, scheduledAt: `2026-12-0${day}T10:00:00Z` }),
    );
    expect(
      buildInstagramGrid([...published, ...planned], new Map(), {
        published: 2,
        planned: 2,
      }).map((item) => item.caption),
    ).toEqual(["s2", "s1", "p3", "p2"]);
  });
});

async function workspace() {
  const org = crypto.randomUUID(),
    client = crypto.randomUUID(),
    user = crypto.randomUUID(),
    instagram = crypto.randomUUID(),
    facebook = crypto.randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'agency')", [
    org,
  ]);
  await db.query(
    "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'Client A')",
    [client, org],
  );
  await db.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Admin',$2)`, [
    user,
    `${user}@example.test`,
  ]);
  await db.query(
    `INSERT INTO social_accounts(id,organization_id,client_id,platform,name,remote_id,mode)
     VALUES($1,$3,$4,'instagram','Client IG','ig-1','mock'),($2,$3,$4,'facebook','Client FB','fb-1','mock')`,
    [instagram, facebook, org, client],
  );
  return {
    org,
    client,
    instagram,
    facebook,
    c: {
      organizationId: org,
      clientId: client,
      userId: user,
      role: "OWNER" as const,
    },
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function image(w: Workspace, mime = "image/jpeg") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO media_assets(id,organization_id,client_id,name,object_key,mime_type,size_bytes,status)
     VALUES($1,$2,$3,'photo',$4,$5,10,'READY')`,
    [id, w.org, w.client, `${w.org}/${w.client}/${id}`, mime],
  );
  return id;
}

async function post(
  w: Workspace,
  options: {
    caption: string;
    status: string;
    at: string;
    account?: string;
    targetStatus?: string;
    publishedAt?: string;
    review?: boolean;
    mediaIds?: string[];
  },
) {
  const id = crypto.randomUUID();
  const account = options.account ?? w.instagram;
  await db.query(
    `INSERT INTO posts(id,organization_id,client_id,caption,status,scheduled_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, w.org, w.client, options.caption, options.status, options.at],
  );
  await db.query(
    `INSERT INTO post_targets(organization_id,client_id,post_id,social_account_id,caption,media_ids,status,published_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      w.org,
      w.client,
      id,
      account,
      options.caption,
      options.mediaIds ?? [],
      options.targetStatus ?? "DRAFT",
      options.publishedAt ?? null,
    ],
  );
  await db.query(
    `INSERT INTO post_versions(organization_id,client_id,post_id,revision,snapshot) VALUES($1,$2,$3,1,$4)`,
    [
      w.org,
      w.client,
      id,
      JSON.stringify({
        targets: [
          {
            accountId: account,
            caption: options.caption,
            mediaIds: options.mediaIds ?? [],
          },
        ],
      }),
    ],
  );
  if (options.review)
    await db.query(
      `INSERT INTO approval_requests(organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind)
       VALUES($1,$2,$3,1,$4,now()+interval '7 days','EXTERNAL')`,
      [w.org, w.client, id, crypto.randomUUID()],
    );
  return id;
}

function gridImage(secret: string, n: string | number) {
  return gridRoute.GET(
    new Request(
      `http://localhost:3010/api/approval-bundle/${secret}/grid/${n}`,
    ),
    {
      params: Promise.resolve({ token: secret, n: String(n) }),
    },
  );
}

describe("Instagram grid from stored data", () => {
  it("shows an empty state flag for clients without Instagram", async () => {
    const w = await workspace();
    await db.query("UPDATE social_accounts SET deleted_at=now() WHERE id=$1", [
      w.instagram,
    ]);
    expect(await instagramGrid(w.c)).toEqual({
      hasInstagram: false,
      items: [],
    });
  });

  it("lists the agency grid with media references and no provider call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await workspace();
    const first = await image(w);
    const second = await image(w);
    await post(w, {
      caption: "Published",
      status: "PUBLISHED",
      targetStatus: "PUBLISHED",
      at: "2026-11-01T10:00:00Z",
      publishedAt: "2026-11-01T10:05:00Z",
    });
    await post(w, {
      caption: "Carousel",
      status: "SCHEDULED",
      targetStatus: "SCHEDULED",
      at: "2099-01-02T10:00:00Z",
      mediaIds: [first, second],
    });
    await post(w, {
      caption: "Facebook only",
      status: "SCHEDULED",
      at: "2099-01-03T10:00:00Z",
      account: w.facebook,
    });
    const grid = await instagramGrid(w.c);
    expect(
      grid.items.map((item) => [
        item.caption,
        item.state,
        item.cover?.id ?? null,
      ]),
    ).toEqual([
      ["Carousel", "planned", first],
      ["Published", "published", null],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Instagram grid on the public bundle page", () => {
  async function scenario() {
    const w = await workspace();
    const other = await workspace();
    const cover = await image(w);
    const second = await image(w);
    const published = await image(w);
    const webp = await image(w, "image/webp");
    await post(w, {
      caption: "Old post",
      status: "PUBLISHED",
      targetStatus: "PUBLISHED",
      at: "2026-11-01T10:00:00Z",
      publishedAt: "2026-11-01T10:00:00Z",
      mediaIds: [published],
    });
    await post(w, {
      caption: "Bundle carousel",
      status: "PENDING_APPROVAL",
      at: "2026-12-10T10:00:00Z",
      review: true,
      mediaIds: [cover, second],
    });
    await post(w, {
      caption: "Bundle text",
      status: "PENDING_APPROVAL",
      at: "2026-12-12T10:00:00Z",
      review: true,
    });
    await post(w, {
      caption: "Bundle webp",
      status: "PENDING_APPROVAL",
      at: "2026-12-14T10:00:00Z",
      review: true,
      mediaIds: [webp],
    });
    // Not part of the grid: another client's post, a draft, a scheduled post
    // outside the bundle, a failed post and a Facebook-only bundle item.
    await post(other, {
      caption: "Other client",
      status: "PUBLISHED",
      targetStatus: "PUBLISHED",
      at: "2026-11-20T10:00:00Z",
      publishedAt: "2026-11-20T10:00:00Z",
      mediaIds: [await image(other)],
    });
    await post(w, {
      caption: "Secret draft",
      status: "DRAFT",
      at: "2026-12-11T10:00:00Z",
    });
    await post(w, {
      caption: "Not in bundle",
      status: "SCHEDULED",
      targetStatus: "SCHEDULED",
      at: "2027-01-05T10:00:00Z",
    });
    await post(w, {
      caption: "Broken",
      status: "FAILED",
      targetStatus: "FAILED",
      at: "2026-11-05T10:00:00Z",
    });
    await post(w, {
      caption: "Facebook item",
      status: "PENDING_APPROVAL",
      at: "2026-12-13T10:00:00Z",
      review: true,
      account: w.facebook,
    });
    const bundle = await createApprovalBundle(w.c, {
      periodStart: "2026-12-01T00:00:00Z",
      periodEnd: "2027-01-01T00:00:00Z",
    });
    return {
      w,
      other,
      bundle,
      secret: bundle.url.split("/").at(-1)!,
      cover,
      published,
    };
  }

  it("contains only published posts and the bundle's own Instagram items, without internal data", async () => {
    const { w, secret } = await scenario();
    const view = await bundleView(secret);
    expect(view.grid.has_instagram).toBe(true);
    expect(view.grid.items).toEqual([
      {
        n: 1,
        state: "planned",
        at: "2026-12-14T10:00:00.000Z",
        carousel: false,
        item: 4,
        image: `/api/approval-bundle/${secret}/grid/1`,
      },
      {
        n: 2,
        state: "planned",
        at: "2026-12-12T10:00:00.000Z",
        carousel: false,
        item: 2,
        image: null,
      },
      {
        n: 3,
        state: "planned",
        at: "2026-12-10T10:00:00.000Z",
        carousel: true,
        item: 1,
        image: `/api/approval-bundle/${secret}/grid/3`,
      },
      {
        n: 4,
        state: "published",
        at: "2026-11-01T10:00:00.000Z",
        carousel: false,
        item: null,
        image: `/api/approval-bundle/${secret}/grid/4`,
      },
    ]);
    const json = JSON.stringify(view.grid);
    expect(json).not.toMatch(uuidPattern);
    expect(json).not.toContain(w.org);
    expect(json).not.toMatch(
      /post_id|client_id|organization|object_key|https?:/,
    );
    expect(json).not.toMatch(
      /Secret draft|Not in bundle|Broken|Other client|Old post/,
    );
  });

  it("drops items sent back for changes", async () => {
    const { secret } = await scenario();
    const { decideBundle } = await import(
      "../packages/server/approval-bundles"
    );
    await decideBundle(secret, { action: "changes", item: 1, comment: "No" });
    const view = await bundleView(secret);
    expect(view.grid.items.map((item) => item.item)).toEqual([4, 2, null]);
  });

  it("serves grid covers only for the bundle client and valid numbers", async () => {
    const { w, bundle, secret, cover, published } = await scenario();
    stored.mockClear();
    const carousel = await gridImage(secret, 3);
    expect(carousel.status).toBe(200);
    expect(carousel.headers.get("Content-Type")).toBe("image/jpeg");
    expect(carousel.headers.get("Cache-Control")).toBe("no-store");
    expect(carousel.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await carousel.text()).toBe(`${w.org}/${w.client}/${cover}`);
    expect(await (await gridImage(secret, 4)).text()).toBe(
      `${w.org}/${w.client}/${published}`,
    );
    // WebP cover is served as an image (browsers show it); text-only entry
    // and numbers past the end have nothing.
    for (const n of [2, 5, 0, 201, "x"])
      expect((await gridImage(secret, n)).status).toBe(404);
    expect(stored).toHaveBeenCalledTimes(2);
    await revokeApprovalBundle(w.c, bundle.id);
    expect((await gridImage(secret, 3)).status).toBe(404);
    await expect(bundleView(secret)).rejects.toMatchObject({ status: 404 });
    expect((await gridImage("A".repeat(43), 1)).status).toBe(404);
  });

  it("answers expired links without grid data or images", async () => {
    const { bundle, secret } = await scenario();
    await db.query(
      "UPDATE approval_bundles SET created_at=now()-interval '2 days',expires_at=now()-interval '1 minute' WHERE id=$1",
      [bundle.id],
    );
    await expect(bundleView(secret)).rejects.toMatchObject({ status: 404 });
    expect((await gridImage(secret, 1)).status).toBe(404);
  });
});
