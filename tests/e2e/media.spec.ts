import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

test.skip(
  process.env.MEDIA_E2E !== "1",
  "Requires the FFmpeg worker (docker compose --profile worker up -d worker).",
);

test("direct video upload validates, extracts metadata and removes invalid input", async ({
  page,
}) => {
  const unique = Date.now();
  const clientName = `Video Studio ${unique}`;
  await page.goto("/login");
  await page.getByLabel("Email address").fill(process.env.DEMO_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.DEMO_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Let’s make good things happen/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await page.getByLabel("Client name", { exact: true }).fill(clientName);
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await page.getByLabel("Active client").selectOption({ label: clientName });
  await page.getByRole("button", { name: "Media", exact: true }).click();

  const videoName = `campaign-${unique}.mp4`;
  await page.locator("input[type=file]").setInputFiles({
    name: videoName,
    mimeType: "video/mp4",
    buffer: readFileSync("tests/fixtures/campaign.mp4"),
  });
  const videoCard = page.locator(".media-card").filter({ hasText: videoName });
  await expect(videoCard.getByText("ready", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const valid = (
    await db.query(
      "SELECT a.*,j.status AS job_status FROM media_assets a JOIN media_processing_jobs j ON j.media_asset_id=a.id WHERE a.name=$1",
      [videoName],
    )
  ).rows[0];
  expect(valid.status).toBe("READY");
  expect(valid.job_status).toBe("DONE");
  expect(valid.width).toBe(640);
  expect(valid.height).toBe(360);
  expect(Number(valid.duration_seconds)).toBeGreaterThan(1.9);
  expect(valid.preview_object_key).toContain("/previews/");
  expect(valid.object_key).toContain("/ready/");

  const invalidName = `invalid-${unique}.mp4`;
  const invalidBytes = Buffer.alloc(128);
  invalidBytes.write("ftyp", 4, "ascii");
  await page.locator("input[type=file]").setInputFiles({
    name: invalidName,
    mimeType: "video/mp4",
    buffer: invalidBytes,
  });
  await expect(page.locator(".alert")).toContainText(
    "The file could not be processed.",
    { timeout: 30_000 },
  );
  const invalid = (
    await db.query(
      "SELECT a.*,j.status AS job_status FROM media_assets a JOIN media_processing_jobs j ON j.media_asset_id=a.id WHERE a.name=$1",
      [invalidName],
    )
  ).rows[0];
  expect(invalid.status).toBe("FAILED");
  expect(invalid.processing_error).toBe("INVALID_VIDEO");
  expect(invalid.job_status).toBe("DEAD");

  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
  await expect(
    s3.send(
      new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: invalid.object_key,
      }),
    ),
  ).rejects.toThrow();
  s3.destroy();
  await db.end();
});
