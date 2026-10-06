import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";

// In-memory S3 stand-in: commands stay real, only the client is replaced.
const objects = vi.hoisted(
  () => new Map<string, { body: Buffer; type?: string }>(),
);
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    async send(command: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer; ContentType?: string };
    }) {
      const { Key, Body, ContentType } = command.input;
      const stored = objects.get(Key);
      switch (command.constructor.name) {
        case "PutObjectCommand":
          objects.set(Key, { body: Body!, type: ContentType });
          return {};
        case "HeadObjectCommand":
        case "GetObjectCommand":
          if (!stored)
            throw Object.assign(new Error("missing"), { name: "NotFound" });
          return {
            ContentType: stored.type,
            Body: { transformToByteArray: async () => stored.body },
          };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    }
  }
  return { ...actual, S3Client };
});
vi.mock("../packages/db", () => ({ pool: { query: vi.fn() } }));

import {
  assertStoredObject,
  derivedObjectKeys,
  instagramImageObjectKey,
} from "../packages/server/media";

const media = {
  id: "asset-1",
  organization_id: "org-1",
  client_id: "client-1",
  object_key: "org-1/client-1/ready/asset-1",
  mime_type: "image/png",
  width: 1080,
  height: 1080,
};

describe("Instagram image renditions", () => {
  beforeEach(() => {
    objects.clear();
    process.env.S3_BUCKET = "test-bucket";
    objects.set(media.object_key, {
      body: readFileSync("tests/fixtures/campaign.png"),
      type: "image/png",
    });
  });

  it("converts a PNG to a cached JPEG rendition", async () => {
    const key = await instagramImageObjectKey(media);
    expect(key).toBe(derivedObjectKeys(media)[0]);
    const rendition = objects.get(key)!;
    expect(rendition.type).toBe("image/jpeg");
    expect(await sharp(rendition.body).metadata()).toMatchObject({
      format: "jpeg",
      width: 1080,
    });
    objects.delete(media.object_key);
    // Cached: the original is no longer needed for a second publication.
    expect(await instagramImageObjectKey(media)).toBe(key);
  });

  it("scales wide images down to 1440 px", async () => {
    const wide = await sharp({
      create: { width: 2880, height: 1800, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    objects.set(media.object_key, { body: wide, type: "image/png" });
    const key = await instagramImageObjectKey({ ...media, width: 2880 });
    expect(await sharp(objects.get(key)!.body).metadata()).toMatchObject({
      format: "jpeg",
      width: 1440,
      height: 900,
    });
  });

  it("rejects a missing object permanently before any provider call", async () => {
    await expect(assertStoredObject(media.object_key)).resolves.toBeUndefined();
    await expect(assertStoredObject("missing/object")).rejects.toMatchObject({
      status: 422,
      code: "MEDIA_MISSING",
    });
  });

  it("frames portrait photos to 4:5 instead of cropping them", async () => {
    const portrait = await sharp({
      create: { width: 3000, height: 4000, channels: 3, background: "#cc3300" },
    })
      .jpeg()
      .toBuffer();
    objects.set(media.object_key, { body: portrait, type: "image/jpeg" });
    const key = await instagramImageObjectKey({
      ...media,
      mime_type: "image/jpeg",
      width: 3000,
      height: 4000,
    });
    expect(key).toBe(derivedObjectKeys(media)[0]);
    const { width, height, format } = await sharp(
      objects.get(key)!.body,
    ).metadata();
    expect(format).toBe("jpeg");
    expect(height).toBe(1800);
    expect(width).toBe(1440);
  });

  it("frames very wide images to 1.91:1", async () => {
    const wide = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#0033cc" },
    })
      .png()
      .toBuffer();
    objects.set(media.object_key, { body: wide, type: "image/png" });
    const key = await instagramImageObjectKey({
      ...media,
      width: 3000,
      height: 1000,
    });
    const { width, height } = await sharp(objects.get(key)!.body).metadata();
    expect(width).toBe(1440);
    expect(height).toBe(Math.round(1440 / 1.91));
  });

  it("publishes a suitable JPEG as-is", async () => {
    expect(
      await instagramImageObjectKey({ ...media, mime_type: "image/jpeg" }),
    ).toBe(media.object_key);
    expect(objects.size).toBe(1);
  });
});
