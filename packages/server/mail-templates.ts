import { pool } from "../db";

export type MailLocale = "hu" | "en";
type Mail = { subject: string; text: string };

const intl = (locale: MailLocale) => (locale === "hu" ? "hu-HU" : "en-GB");
const when = (value: string | Date, locale: MailLocale, timeZone: string) =>
  new Date(value).toLocaleString(intl(locale), { timeZone });
const excerpt = (caption: unknown) => String(caption).slice(0, 240);

// Recipients without a saved preference get Hungarian, the product default.
export async function userLocale(
  where: { id: string } | { email: string },
): Promise<MailLocale> {
  const result =
    "id" in where
      ? await pool.query(`SELECT locale FROM "user" WHERE id=$1`, [where.id])
      : await pool.query(
          `SELECT locale FROM "user" WHERE lower(email)=lower($1)`,
          [where.email],
        );
  return result.rows[0]?.locale === "en" ? "en" : "hu";
}

export function reviewReminderMail(
  locale: MailLocale,
  input: {
    reviewerName?: string | null;
    clientName: string;
    caption: unknown;
    expiresAt: string | Date;
    timeZone: string;
    automatic: boolean;
  },
): Mail {
  const expires = when(input.expiresAt, locale, input.timeZone);
  const caption = excerpt(input.caption);
  if (locale === "hu")
    return {
      subject: `${input.automatic ? "Emlékeztető: jóváhagyásra vár" : "Jóváhagyást kérünk"} · ${input.clientName}`,
      text: `Szia${input.reviewerName ? ` ${input.reviewerName}` : ""}!

Egy poszt a belső jóváhagyásodra vár (${input.clientName}):
„${caption}”

Jelentkezz be a G2A Social Hubba, és nyisd meg a Jóváhagyások oldalt:
${process.env.APP_URL}

A jóváhagyás lejár: ${expires}.`,
    };
  return input.automatic
    ? {
        subject: `Review reminder · ${input.clientName}`,
        text: `Hello ${input.reviewerName ?? "reviewer"},\n\nA post is still waiting for your internal review in ${input.clientName}:\n"${caption}"\n\nOpen Approvals in the G2A Social Hub:\n${process.env.APP_URL}\n\nThis review expires on ${expires}.`,
      }
    : {
        subject: `Review requested · ${input.clientName}`,
        text: `Hello ${input.reviewerName},

A post is waiting for your internal review in ${input.clientName}:
"${caption}"

Sign in to the G2A Social Hub and open Approvals:
${process.env.APP_URL}

This review expires on ${expires}.`,
      };
}

export function escalationMail(
  locale: MailLocale,
  input: { stepKind: string; clientName: string; caption: unknown },
): Mail {
  const caption = excerpt(input.caption);
  if (locale === "hu")
    return {
      subject: `Lejárt jóváhagyás · ${input.clientName}`,
      text: `Egy ${input.stepKind === "INTERNAL" ? "belső" : "ügyféloldali"} jóváhagyás határideje lejárt (${input.clientName}):
„${caption}”

Nyisd meg a Jóváhagyások oldalt a G2A Social Hubban:
${process.env.APP_URL}`,
    };
  return {
    subject: `Overdue approval · ${input.clientName}`,
    text: `An ${input.stepKind.toLowerCase()} approval in ${input.clientName} is overdue:\n"${caption}"\n\nOpen Approvals in the G2A Social Hub:\n${process.env.APP_URL}`,
  };
}

const roleNames: Record<MailLocale, Record<string, string>> = {
  hu: {
    OWNER: "tulajdonos",
    ADMIN: "adminisztrátor",
    SOCIAL_MANAGER: "social media menedzser",
    CONTENT_CREATOR: "tartalomkészítő",
    CLIENT_REVIEWER: "ügyféloldali jóváhagyó",
    VIEWER: "megtekintő",
  },
  en: {},
};

export function invitationMail(
  locale: MailLocale,
  input: { role: string; url: string },
): Mail {
  if (locale === "hu")
    return {
      subject: "Meghívó a G2A Social Hubba",
      text: `Meghívtak a G2A Social Hubba (szerepkör: ${roleNames.hu[input.role] ?? input.role}).

Hét napon belül fogadd el a meghívót:
${input.url}

Ha nem számítottál erre a meghívóra, nyugodtan hagyd figyelmen kívül ezt az üzenetet.`,
    };
  return {
    subject: "Join the G2A Social Hub",
    text: `You have been invited to the G2A Social Hub as ${input.role.toLowerCase().replaceAll("_", " ")}.

Accept your invitation within seven days:
${input.url}

If you did not expect this invitation, you can ignore this message.`,
  };
}

export function authMail(
  locale: MailLocale,
  kind: "reset" | "verify" | "magic",
  url: string,
): Mail {
  const subjects = {
    hu: {
      reset: "Jelszó visszaállítása",
      verify: "Erősítsd meg az e-mail-címed",
      magic: "Bejelentkezés a G2A Social Hubba",
    },
    en: {
      reset: "Reset your password",
      verify: "Verify your email",
      magic: "Sign in to G2A Social Hub",
    },
  };
  return { subject: subjects[locale][kind], text: url };
}
