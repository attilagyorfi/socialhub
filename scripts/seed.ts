import { auth } from "../packages/server/auth";
import { pool } from "../packages/db";
import { redis } from "../packages/server/queue";
import { createClient, connectMock } from "../packages/server/clients";
import { createPost, schedulePost } from "../packages/server/posts";
import { requestApproval, decideApproval } from "../packages/server/approvals";
import { ensureBucket } from "../packages/server/media";
import { executePublish, syncAnalytics } from "../packages/server/publishing";
import type { Context } from "../packages/server/context";
if (
  process.env.NODE_ENV === "production" ||
  process.env.SOCIAL_PROVIDER_MODE !== "mock"
)
  throw new Error("Seed is only allowed in local mock mode.");
const email = process.env.DEMO_EMAIL;
const password = process.env.DEMO_PASSWORD;
if (!email || !password)
  throw new Error("Set DEMO_EMAIL and DEMO_PASSWORD in .env.");
try {
  await ensureBucket();
  let owner = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
  ).rows[0];
  if (!owner) {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "Alex Morgan" },
    });
    owner = result.user;
  }
  if (
    (
      await pool.query("SELECT 1 FROM organization_members WHERE user_id=$1", [
        owner.id,
      ])
    ).rowCount
  ) {
    console.log(
      "Demo user already has an organization. Seed skipped to preserve existing data.",
    );
  } else {
    for (const name of ["Terra Studio", "Northline Coffee", "G2A Marketing"]) {
      const client = await createClient(owner.id, name);
      const c: Context = {
        userId: owner.id,
        clientId: client.id,
        organizationId: client.organization_id,
        role: "OWNER",
      };
      const facebook = await connectMock(c, "facebook", name);
      const linkedin = await connectMock(c, "linkedin", name);
      await connectMock(c, "instagram", name);
      await pool.query(
        "UPDATE brand_profiles SET profile=$1 WHERE client_id=$2",
        [
          JSON.stringify({
            brandName: name,
            description:
              name === "Terra Studio"
                ? "A fictional independent home and lifestyle brand."
                : "A fictional client for demonstration.",
            toneOfVoice: "Warm, considered, confident",
            targetAudience: "People who value thoughtfully made products",
            preferredCTA: "Discover the collection",
            languages: "English, Hungarian",
            hashtags: "#ThoughtfullyMade #EverydayInspiration",
          }),
          client.id,
        ],
      );
      const captions = [
        "A little more intention. A little less noise. Discover the stories behind our new collection.",
        "Made for the everyday moments that matter. Here’s a closer look at what’s coming next.",
        "Meet the people behind the process. Our latest studio notes are ready to share.",
        "Good things take a little care. A new chapter starts this week.",
        "A fresh perspective on familiar favorites. Tell us which one speaks to you.",
        "[mock:fail] Demo campaign — this post demonstrates a rejected publishing attempt.",
      ];
      for (let i = 0; i < captions.length; i++) {
        const post = await createPost(c, {
          clientId: client.id,
          caption: captions[i],
          targets: [facebook, linkedin].map((a) => ({
            accountId: a.id,
            caption: captions[i],
            mediaIds: [],
          })),
        });
        if (i === 2) continue;
        const approval = await requestApproval(c, post.id);
        if (i === 3) continue;
        await decideApproval(approval.url!.split("/").at(-1)!, "approve", "");
        if (i === 4) {
          const jobs = await schedulePost(
            c,
            post.id,
            new Date(Date.now() + 1000).toISOString(),
          );
          await pool.query(
            "UPDATE publish_jobs SET run_at=now() WHERE target_id IN (SELECT id FROM post_targets WHERE post_id=$1)",
            [jobs.id],
          );
          for (const j of (
            await pool.query(
              "SELECT id FROM publish_jobs WHERE target_id IN (SELECT id FROM post_targets WHERE post_id=$1)",
              [post.id],
            )
          ).rows)
            await executePublish(j.id);
        } else if (i === 5) {
          await schedulePost(
            c,
            post.id,
            new Date(Date.now() + 1000).toISOString(),
          );
          await pool.query(
            "UPDATE publish_jobs SET run_at=now() WHERE target_id IN (SELECT id FROM post_targets WHERE post_id=$1)",
            [post.id],
          );
          for (const j of (
            await pool.query(
              "SELECT id FROM publish_jobs WHERE target_id IN (SELECT id FROM post_targets WHERE post_id=$1)",
              [post.id],
            )
          ).rows)
            await executePublish(j.id);
        } else
          await schedulePost(
            c,
            post.id,
            new Date(Date.now() + (i + 1) * 86400000).toISOString(),
          );
      }
      for (const a of [facebook, linkedin])
        for (let i = 1; i <= 14; i++) {
          const day = new Date(Date.now() - i * 86400000)
            .toISOString()
            .slice(0, 10);
          const n = 14 - i;
          const metrics = {
            followers: 2400 + n * 17,
            reach: 1200 + n * 53 + (i % 3) * 70,
            impressions: 1700 + n * 87,
            engagement: 94 + n * 8,
          };
          await pool.query(
            "INSERT INTO analytics_daily(organization_id,client_id,social_account_id,day,provider,raw,normalized) VALUES($1,$2,$3,$4,$5,$6,$6)",
            [
              c.organizationId,
              c.clientId,
              a.id,
              day,
              `mock:${a.platform}`,
              JSON.stringify(metrics),
            ],
          );
        }
    }
    await syncAnalytics();
    console.log(
      "Demo created: 3 client workspaces, mock accounts, posts, approvals, analytics and audit history. Sign in using DEMO_EMAIL and DEMO_PASSWORD from .env.",
    );
  }
} finally {
  await pool.end();
  await redis().quit();
}
