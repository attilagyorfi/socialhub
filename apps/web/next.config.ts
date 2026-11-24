import type { NextConfig } from "next";
const config: NextConfig = {
  // Vercel's build adapter packages the server itself; standalone output
  // conflicts with it (missing next-server.js.nft.json under Turbopack).
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
  // The calendar PDF reads its embedded font from disk. Tracing copies it
  // into the standalone output (Docker image) and the Vercel function alike;
  // tests/calendar-pdf.test.ts checks that this glob finds the files.
  outputFileTracingIncludes: {
    "/api/calendar/export": ["../../packages/server/fonts/*"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
