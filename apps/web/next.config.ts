import type { NextConfig } from "next";
const config: NextConfig = {
  // Vercel's build adapter packages the server itself; standalone output
  // conflicts with it (missing next-server.js.nft.json under Turbopack).
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
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
