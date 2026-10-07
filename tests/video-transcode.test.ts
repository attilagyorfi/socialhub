import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  inspectVideo,
  needsTranscode,
} from "../packages/server/media-processing";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH;

async function sample(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "g2a-sample-"));
  const file = join(directory, "sample.mp4");
  try {
    await run(ffmpeg!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=4:size=1080x1920:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      ...args,
      "-shortest",
      "-y",
      file,
    ]);
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("video transcoding decision", () => {
  const h264 = {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        pix_fmt: "yuv420p",
        width: 1080,
        height: 1920,
      },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };
  it("keeps web-ready H.264/AAC MP4 as uploaded", () => {
    expect(needsTranscode(h264)).toBe(false);
  });
  it("converts HEVC, 10-bit, oversized or non-AAC uploads", () => {
    const video = h264.streams[0];
    const audio = h264.streams[1];
    for (const changed of [
      { ...video, codec_name: "hevc" },
      { ...video, pix_fmt: "yuv420p10le" },
      { ...video, width: 2160, height: 3840 },
    ])
      expect(needsTranscode({ ...h264, streams: [changed, audio] })).toBe(true);
    expect(
      needsTranscode({
        ...h264,
        streams: [video, { ...audio, codec_name: "opus" }],
      }),
    ).toBe(true);
  });
});

describe.skipIf(!ffmpeg || !process.env.FFPROBE_PATH)(
  "video transcoding with ffmpeg",
  () => {
    it("converts a 10-bit HEVC phone video to H.264 MP4", async () => {
      const input = await sample([
        "-c:v",
        "libx265",
        "-pix_fmt",
        "yuv420p10le",
        "-tag:v",
        "hvc1",
        "-c:a",
        "aac",
      ]);
      const result = await inspectVideo(input);
      expect(result.transcoded).toBe(true);
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.duration).toBeGreaterThan(3);
      expect(result.preview.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const directory = await mkdtemp(join(tmpdir(), "g2a-check-"));
      try {
        const file = join(directory, "out.mp4");
        await writeFile(file, result.data);
        const { stdout } = await run(process.env.FFPROBE_PATH!, [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          file,
        ]);
        const streams = JSON.parse(stdout).streams;
        expect(streams[0]).toMatchObject({
          codec_name: "h264",
          pix_fmt: "yuv420p",
        });
        expect(streams[1]).toMatchObject({ codec_name: "aac" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);

    it("always rewrites a MOV upload as MP4", async () => {
      const input = await sample([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-f",
        "mov",
      ]);
      expect(input.toString("ascii", 8, 12)).toBe("qt  ");
      const result = await inspectVideo(input, true);
      expect(result.transcoded).toBe(true);
      expect(result.data.toString("ascii", 4, 8)).toBe("ftyp");
      expect(result.data.toString("ascii", 8, 12)).not.toBe("qt  ");
    }, 60_000);

    it("keeps an H.264 upload untouched", async () => {
      const input = await sample([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
      ]);
      const result = await inspectVideo(input);
      expect(result.transcoded).toBe(false);
      expect(result.data).toBe(input);
    }, 60_000);
  },
);
