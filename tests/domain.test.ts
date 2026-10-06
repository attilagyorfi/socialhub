import { describe, it, expect } from "vitest";
import { can, aggregateStatus, validatePost } from "../packages/core/domain";
import {
  encrypt,
  decrypt,
  token,
  hashToken,
  sameOrigin,
} from "../packages/core/security";
import { MockProvider, type ReceiptStore } from "../packages/core/providers";
describe("authorization", () => {
  it("separates creation, approval and publication", () => {
    expect(can("CONTENT_CREATOR", "create")).toBe(true);
    expect(can("CONTENT_CREATOR", "publish")).toBe(false);
    expect(can("CLIENT_REVIEWER", "approve")).toBe(true);
    expect(can("CLIENT_REVIEWER", "create")).toBe(false);
    expect(can("VIEWER", "manage")).toBe(false);
  });
});
describe("content capabilities", () => {
  it("requires Instagram media and rejects unsupported links", () => {
    expect(
      validatePost("instagram", {
        caption: "Hello",
        link: "https://example.com",
        media: [],
      }),
    ).toHaveLength(2);
  });
  it("limits Instagram images to the 4:5 to 1.91:1 aspect ratio range", () => {
    const image = (width: number, height: number) => ({
      caption: "Hello",
      media: [
        {
          id: "m",
          mime_type: "image/png",
          size_bytes: 10,
          status: "READY",
          width,
          height,
        },
      ],
    });
    const ratioError =
      "Instagram images must have an aspect ratio between 4:5 (portrait) and 1.91:1 (landscape).";
    expect(validatePost("instagram", image(1080, 1350))).toEqual([]);
    expect(validatePost("instagram", image(1080, 1080))).toEqual([]);
    expect(validatePost("instagram", image(1910, 1000))).toEqual([]);
    expect(validatePost("instagram", image(1080, 1920))).toContain(ratioError);
    expect(validatePost("instagram", image(3000, 1000))).toContain(ratioError);
    expect(validatePost("facebook", image(1080, 1920))).toEqual([]);
  });
  it("requires exactly one TikTok video", () => {
    expect(validatePost("tiktok", { caption: "Hello", media: [] })).toContain(
      "TikTok requires one video.",
    );
  });
});
describe("publishing status", () => {
  it("preserves per-target outcomes", () => {
    expect(aggregateStatus(["PUBLISHED", "FAILED"])).toBe(
      "PARTIALLY_PUBLISHED",
    );
    expect(aggregateStatus(["PUBLISHED", "QUEUED"])).toBe("PUBLISHING");
    expect(aggregateStatus(["PUBLISHED", "PUBLISHED"])).toBe("PUBLISHED");
    expect(aggregateStatus(["FAILED", "FAILED"])).toBe("FAILED");
  });
});
describe("secrets", () => {
  it("binds encrypted credentials to their tenant/account", () => {
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const sealed = encrypt("sensitive-token", "org:client:account");
    expect(sealed).not.toContain("sensitive-token");
    expect(decrypt(sealed, "org:client:account")).toBe("sensitive-token");
    expect(() => decrypt(sealed, "other:client:account")).toThrow();
  });
  it("uses high entropy tokens and stores hashes", () => {
    const a = token();
    expect(a).toHaveLength(43);
    expect(token()).not.toBe(a);
    expect(hashToken(a)).toHaveLength(64);
  });
  it("blocks cross-origin mutation", () => {
    process.env.APP_URL = "https://hub.example";
    expect(() =>
      sameOrigin(
        new Request("https://hub.example/api", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toThrow();
  });
});
describe("mock provider reliability", () => {
  function adapter() {
    const stored = new Map<string, string>();
    const receipts: ReceiptStore = {
      get: async (k) => stored.get(k),
      put: async (k, v) => {
        if (!stored.has(k)) stored.set(k, v);
        return stored.get(k)!;
      },
    };
    return { provider: new MockProvider("facebook", receipts), stored };
  }
  it("retries without creating a second publication", async () => {
    const { provider, stored } = adapter();
    const content = { caption: "Hello", media: [] };
    const first = await provider.publishPost(content, "stable", 1);
    expect(await provider.publishPost(content, "stable", 2)).toEqual(first);
    expect(stored.size).toBe(1);
  });
  it("recovers from simulated rate limits", async () => {
    const { provider } = adapter();
    const content = { caption: "[mock:rate-limit]", media: [] };
    await expect(provider.publishPost(content, "key", 1)).rejects.toMatchObject(
      { status: 429 },
    );
    await expect(provider.publishPost(content, "key", 2)).rejects.toMatchObject(
      { status: 429 },
    );
    await expect(
      provider.publishPost(content, "key", 3),
    ).resolves.toHaveProperty("remoteId");
  });
  it("does not swallow permanent failures", async () => {
    const { provider, stored } = adapter();
    await expect(
      provider.publishPost({ caption: "[mock:fail]", media: [] }, "key", 1),
    ).rejects.toMatchObject({ code: "MOCK_REJECTED" });
    expect(stored.size).toBe(0);
  });
});
