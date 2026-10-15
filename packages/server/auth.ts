import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { pool } from "../db";
import { canCreateAccount } from "./access-requests";
import { redis } from "./queue";
import { sendMail } from "./mail";
import { authMail, userLocale } from "./mail-templates";

async function sendAuthMail(
  email: string,
  kind: "reset" | "verify" | "magic",
  url: string,
) {
  const mail = authMail(await userLocale({ email }), kind, url);
  await sendMail(email, mail.subject, mail.text);
}
export const auth = betterAuth({
  database: pool,
  baseURL: process.env.APP_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  advanced: { database: { generateId: "uuid" } },
  // Every way of creating a user (password, magic link, Google) passes here.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!(await canCreateAccount(user.email)))
            throw APIError.from("FORBIDDEN", {
              code: "SIGN_UP_REQUIRES_INVITATION",
              message:
                "Accounts are created by invitation only. Request access on the sign-in page.",
            });
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    requireEmailVerification: process.env.NODE_ENV === "production",
    // A reset signs out every device, so a leaked password stops working.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) =>
      sendAuthMail(user.email, "reset", url),
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) =>
      sendAuthMail(user.email, "verify", url),
    sendOnSignUp: process.env.NODE_ENV === "production",
    // The confirmation link signs the person in and returns them to the
    // page they signed up from (e.g. a pending invitation).
    autoSignInAfterVerification: true,
  },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) =>
        sendAuthMail(email, "magic", url),
    }),
  ],
  secondaryStorage: {
    get: async (key) => redis().get(`auth:${key}`),
    getAndDelete: async (key) => redis().getdel(`auth:${key}`),
    increment: async (key, ttl) =>
      Number(
        await redis().eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
          1,
          `auth:${key}`,
          ttl,
        ),
      ),
    set: async (key, value, ttl) => {
      await redis().set(`auth:${key}`, value, "EX", ttl ?? 3600);
    },
    delete: async (key) => {
      await redis().del(`auth:${key}`);
    },
  },
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    window: 60,
    max: 60,
    customRules:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            "/sign-in/*": { window: 10, max: 30 },
            "/sign-up/*": { window: 10, max: 30 },
            "/change-password": { window: 10, max: 30 },
          },
  },
});
