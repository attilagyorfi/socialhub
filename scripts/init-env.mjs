import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
let env = await readFile(".env.example", "utf8");
env = env
  .replace(
    "BETTER_AUTH_SECRET=",
    "BETTER_AUTH_SECRET=" + randomBytes(48).toString("base64url"),
  )
  .replace(
    "ENCRYPTION_KEY=",
    "ENCRYPTION_KEY=" + randomBytes(32).toString("hex"),
  )
  .replace(
    "DEMO_PASSWORD=",
    "DEMO_PASSWORD=" + randomBytes(18).toString("base64url"),
  );
await writeFile(".env", env, { flag: "wx" });
await writeFile("apps/web/.env.local", env, { flag: "wx" });
console.log(
  "Local environment created. Demo password is in .env. Secrets were not printed.",
);
