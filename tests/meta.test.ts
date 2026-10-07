import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMetaAuthorizationUrl,
  MetaGraphClient,
  metaConfig,
  matchMetaPublishedContent,
  normalizeMetaPostMetrics,
  normalizeMetaProfileMetrics,
  verifyMetaWebhookSignature,
  type MetaConfig,
} from "../packages/server/meta";

const config: MetaConfig = {
  appId: "app-123",
  appSecret: "secret-456",
  graphVersion: "v99.0",
  redirectUri: "https://hub.example/api/oauth/meta/callback",
  webhookVerifyToken: "verify-me",
};

function fakeFetch(
  handler: (url: URL, init: RequestInit) => unknown | Promise<unknown>,
) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const value = await handler(new URL(String(input)), init ?? {});
    if (value instanceof Response) return value;
    return Response.json(value);
  }) as typeof fetch;
}

afterEach(() => {
  delete process.env.META_INTEGRATION_ENABLED;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_GRAPH_VERSION;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  delete process.env.META_LOGIN_CONFIG_ID;
});

describe("Meta OAuth configuration", () => {
  it("stays fail-closed until explicitly enabled and version-pinned", () => {
    expect(() => metaConfig()).toThrowError(
      expect.objectContaining({ code: "META_DISABLED" }),
    );
    process.env.META_INTEGRATION_ENABLED = "true";
    process.env.META_APP_ID = "app";
    process.env.META_APP_SECRET = "secret";
    process.env.META_GRAPH_VERSION = "latest";
    expect(() => metaConfig()).toThrowError(
      expect.objectContaining({ code: "META_VERSION_INVALID" }),
    );
  });

  it("builds an authorization URL with state and required publishing scopes", () => {
    const url = new URL(buildMetaAuthorizationUrl(config, "opaque-state"));
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v99.0/dialog/oauth");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toContain("pages_manage_posts");
    expect(url.searchParams.get("scope")).toContain(
      "instagram_content_publish",
    );
    expect(url.searchParams.get("scope")).toContain("read_insights");
    expect(url.searchParams.get("scope")).toContain(
      "instagram_manage_insights",
    );
  });
});

describe("Meta Login for Business", () => {
  it("sends the saved configuration instead of a scope list", () => {
    const url = new URL(
      buildMetaAuthorizationUrl(
        { ...config, loginConfigId: "123456789" },
        "opaque-state",
      ),
    );
    expect(url.searchParams.get("config_id")).toBe("123456789");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("rejects a malformed configuration ID", () => {
    process.env.META_INTEGRATION_ENABLED = "true";
    process.env.META_APP_ID = "app";
    process.env.META_APP_SECRET = "secret";
    process.env.META_GRAPH_VERSION = "v26.0";
    process.env.META_LOGIN_CONFIG_ID = "not-a-number";
    expect(() => metaConfig()).toThrowError(
      expect.objectContaining({ code: "META_LOGIN_CONFIG_INVALID" }),
    );
  });
});

describe("Meta webhook authentication", () => {
  it("accepts only the matching raw-body HMAC", () => {
    const raw = new TextEncoder().encode('{"entry":[]}');
    const signature = `sha256=${createHmac("sha256", config.appSecret)
      .update(raw)
      .digest("hex")}`;
    expect(verifyMetaWebhookSignature(raw, signature, config.appSecret)).toBe(
      true,
    );
    expect(
      verifyMetaWebhookSignature(
        new TextEncoder().encode('{"entry":[1]}'),
        signature,
        config.appSecret,
      ),
    ).toBe(false);
    expect(verifyMetaWebhookSignature(raw, null, config.appSecret)).toBe(false);
  });
});

describe("Meta Graph publishing", () => {
  it("publishes Facebook text without putting its token in the URL", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return { id: "page_post_1" };
      }),
    );
    await expect(
      graph.publishFacebook("page-1", "page-secret-token", {
        caption: "Hello",
        link: "https://example.com",
        media: [],
      }),
    ).resolves.toEqual({ id: "page_post_1" });
    expect(calls[0].url.pathname).toBe("/v99.0/page-1/feed");
    expect(calls[0].url.toString()).not.toContain("page-secret-token");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer page-secret-token",
    });
  });

  it("creates, waits for and publishes an Instagram Reel", async () => {
    const paths: string[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith("/media")) return { id: "container-1" };
        if (url.pathname.endsWith("/container-1"))
          return { status_code: "FINISHED" };
        return { id: "reel-1" };
      }),
      async () => {},
    );
    await expect(
      graph.publishInstagram(
        "ig-1",
        "page-token",
        {
          caption: "Campaign",
          media: [
            {
              id: "asset-1",
              mime_type: "video/mp4",
              size_bytes: 123,
              status: "READY",
              object_key: "ready/asset-1",
            },
          ],
        },
        "https://media.example/reel.mp4",
      ),
    ).resolves.toEqual({ id: "reel-1" });
    expect(paths).toEqual([
      "/v99.0/ig-1/media",
      "/v99.0/container-1",
      "/v99.0/ig-1/media_publish",
    ]);
  });

  it("marks a network failure during publication as uncertain", async () => {
    const graph = new MetaGraphClient(config, (async () => {
      throw new Error("socket closed");
    }) as typeof fetch);
    await expect(
      graph.publishFacebook("page-1", "token", {
        caption: "Hello",
        media: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "META_DELIVERY_UNCERTAIN",
    });
  });

  it("records the feed post id for Facebook photo publications", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) => {
        expect(url.pathname).toBe("/v99.0/page-1/photos");
        return { id: "photo-1", post_id: "page-1_post-1" };
      }),
    );
    await expect(
      graph.publishFacebook(
        "page-1",
        "token",
        {
          caption: "Hello",
          media: [
            {
              id: "m",
              mime_type: "image/jpeg",
              size_bytes: 10,
              status: "READY",
              object_key: "ready/m",
            },
          ],
        },
        "https://media.example/photo.jpg",
      ),
    ).resolves.toEqual({ id: "page-1_post-1" });
  });

  const videoContent = {
    caption: "Clip",
    media: [
      {
        id: "v",
        mime_type: "video/mp4",
        size_bytes: 10,
        status: "READY" as const,
        object_key: "ready/v",
      },
    ],
  };

  it("waits for a Facebook video to become a feed post and records the post id", async () => {
    const paths: string[] = [];
    let checks = 0;
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith("/page-1/videos")) return { id: "video-1" };
        expect(url.searchParams.get("fields")).toBe("status,post_id");
        return ++checks < 3
          ? { status: { video_status: "processing" } }
          : { post_id: "post-9", status: { video_status: "ready" } };
      }),
      async () => {},
    );
    await expect(
      graph.publishFacebook(
        "page-1",
        "token",
        videoContent,
        "https://media.example/clip.mp4",
      ),
    ).resolves.toEqual({ id: "page-1_post-9" });
    expect(paths).toEqual([
      "/v99.0/page-1/videos",
      "/v99.0/video-1",
      "/v99.0/video-1",
      "/v99.0/video-1",
    ]);
  });

  it("keeps the video id when Facebook is still processing so delivery is not repeated", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) =>
        url.pathname.endsWith("/videos")
          ? { id: "video-1" }
          : { status: { video_status: "processing" } },
      ),
      async () => {},
    );
    await expect(
      graph.publishFacebook(
        "page-1",
        "token",
        videoContent,
        "https://media.example/clip.mp4",
      ),
    ).resolves.toEqual({ id: "video-1" });
  });

  it("does not repeat a Facebook video upload when the status read fails", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) =>
        url.pathname.endsWith("/videos")
          ? { id: "video-1" }
          : Response.json({ error: { message: "down" } }, { status: 500 }),
      ),
      async () => {},
    );
    await expect(
      graph.publishFacebook(
        "page-1",
        "token",
        videoContent,
        "https://media.example/clip.mp4",
      ),
    ).resolves.toEqual({ id: "video-1" });
  });

  it("rejects a Facebook video that fails processing", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) =>
        url.pathname.endsWith("/videos")
          ? { id: "video-1" }
          : { status: { video_status: "error" } },
      ),
      async () => {},
    );
    await expect(
      graph.publishFacebook(
        "page-1",
        "token",
        videoContent,
        "https://media.example/clip.mp4",
      ),
    ).rejects.toMatchObject({ status: 422, code: "META_MEDIA_REJECTED" });
  });

  it("resolves an already full post id from the video node as is", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch(() => ({ post_id: "page-1_post-9" })),
      async () => {},
    );
    await expect(
      graph.facebookVideoPostId("page-1", "token", "video-1", 1),
    ).resolves.toBe("page-1_post-9");
  });

  it("retries a Reel that is still processing instead of marking it uncertain", async () => {
    const waits: number[] = [];
    const paths: string[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith("/media")) return { id: "container-1" };
        return { status_code: "IN_PROGRESS" };
      }),
      async (ms) => {
        waits.push(ms);
      },
    );
    await expect(
      graph.publishInstagram(
        "ig-1",
        "token",
        videoContent,
        "https://media.example/clip.mp4",
      ),
    ).rejects.toMatchObject({ status: 503, code: "META_MEDIA_PROCESSING" });
    expect(waits.length).toBe(59);
    expect(waits.every((ms) => ms === 5000)).toBe(true);
    expect(paths).not.toContain("/v99.0/ig-1/media_publish");
  });

  it("marks a server error during publication as uncertain instead of retryable", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch(() =>
        Response.json(
          { error: { message: "Service unavailable", is_transient: true } },
          { status: 503 },
        ),
      ),
    );
    await expect(
      graph.publishFacebook("page-1", "token", {
        caption: "Hello",
        media: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "META_DELIVERY_UNCERTAIN",
    });
  });

  it("keeps rate limits on publication retryable", async () => {
    const graph = new MetaGraphClient(
      config,
      fakeFetch(() => Response.json({ error: { code: 4 } }, { status: 400 })),
    );
    await expect(
      graph.publishFacebook("page-1", "token", {
        caption: "Hello",
        media: [],
      }),
    ).rejects.toMatchObject({ status: 429, code: "META_RATE_LIMIT" });
  });

  it("reads recent Facebook and Instagram publications without exposing tokens", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return {
          data: url.pathname.endsWith("/published_posts")
            ? [
                {
                  id: "page_post_1",
                  message: "Campaign",
                  created_time: "2026-09-30T10:00:00Z",
                  permalink_url: "https://facebook.example/post-1",
                },
              ]
            : [
                {
                  id: "ig_media_1",
                  caption: "Campaign",
                  timestamp: "2026-09-30T10:00:00Z",
                  permalink: "https://instagram.example/media-1",
                },
              ],
        };
      }),
    );
    await expect(
      graph.getPublishedContent("facebook", "page-1", "secret-token"),
    ).resolves.toEqual([
      {
        id: "page_post_1",
        caption: "Campaign",
        createdAt: "2026-09-30T10:00:00Z",
        permalink: "https://facebook.example/post-1",
      },
    ]);
    await expect(
      graph.getPublishedContent("instagram", "ig-1", "secret-token"),
    ).resolves.toHaveLength(1);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v99.0/page-1/published_posts",
      "/v99.0/ig-1/media",
    ]);
    expect(
      calls.every((call) => !call.url.toString().includes("secret-token")),
    ).toBe(true);
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("reads granted permissions through the authorization header", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return {
          data: [
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "ads_management", status: "declined" },
            { permission: 7, status: "granted" },
          ],
        };
      }),
    );
    await expect(graph.getPermissions("secret-token")).resolves.toEqual([
      { permission: "pages_manage_posts", status: "granted" },
      { permission: "ads_management", status: "declined" },
    ]);
    expect(calls[0].url.pathname).toBe("/v99.0/me/permissions");
    expect(calls[0].url.toString()).not.toContain("secret-token");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("reconciles only one exact caption in the delivery time window", () => {
    const input = {
      caption: "Campaign\r\n#launch",
      startedAt: "2026-09-30T10:00:00Z",
      finishedAt: "2026-09-30T10:00:30Z",
    };
    expect(
      matchMetaPublishedContent(
        [
          {
            id: "match",
            caption: "Campaign\n#launch",
            createdAt: "2026-09-30T10:01:00Z",
          },
          {
            id: "wrong-caption",
            caption: "Another campaign",
            createdAt: "2026-09-30T10:01:00Z",
          },
          {
            id: "too-late",
            caption: "Campaign\n#launch",
            createdAt: "2026-09-30T10:06:00Z",
          },
        ],
        input,
      ),
    ).toEqual([
      {
        id: "match",
        caption: "Campaign\n#launch",
        createdAt: "2026-09-30T10:01:00Z",
      },
    ]);
  });
});

describe("Meta analytics mapping", () => {
  it("maps current Facebook media-view metrics to the normalized model", () => {
    expect(
      normalizeMetaProfileMetrics(
        "facebook",
        { followers_count: 900 },
        {
          data: [
            { name: "page_follows", values: [{ value: 1234 }] },
            { name: "page_media_view", values: [{ value: 8000 }] },
            {
              name: "page_total_media_view_unique",
              values: [{ value: 5100 }],
            },
            { name: "page_post_engagements", values: [{ value: 320 }] },
          ],
        },
      ),
    ).toEqual({
      followers: 1234,
      reach: 5100,
      impressions: 8000,
      engagement: 320,
    });
  });

  it("maps Instagram totals and nested post counters", () => {
    expect(
      normalizeMetaProfileMetrics(
        "instagram",
        { followers_count: "700" },
        {
          data: [
            { name: "reach", total_value: { value: 1200 } },
            { name: "views", total_value: { value: 2400 } },
            { name: "total_interactions", total_value: { value: 180 } },
          ],
        },
      ),
    ).toEqual({
      followers: 700,
      reach: 1200,
      impressions: 2400,
      engagement: 180,
    });
    expect(
      normalizeMetaPostMetrics(
        "facebook",
        {
          likes: { summary: { total_count: 11 } },
          comments: { summary: { total_count: 4 } },
          shares: { count: 3 },
        },
        {
          data: [
            { name: "post_media_view", values: [{ value: 600 }] },
            {
              name: "post_total_media_view_unique",
              values: [{ value: 450 }],
            },
          ],
        },
      ),
    ).toEqual({
      likes: 11,
      comments: 4,
      shares: 3,
      views: 600,
      reach: 450,
      impressions: 600,
      saves: 0,
    });
  });

  it("sends insight tokens in headers instead of URLs", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return { data: [] };
      }),
    );
    await graph.getInsights("page-1", "analytics-secret", ["page_media_view"]);
    expect(calls[0].url.pathname).toBe("/v99.0/page-1/insights");
    expect(calls[0].url.searchParams.get("metric")).toBe("page_media_view");
    expect(calls[0].url.toString()).not.toContain("analytics-secret");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer analytics-secret",
    });
  });
});
