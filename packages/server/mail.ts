import nodemailer from "nodemailer";

// Railway blocks outbound SMTP, so Resend is reached over its HTTPS API.
// The API key is the SMTP password in SMTP_URL, so no extra secret is needed.
const RESEND_SMTP_HOST = "smtp.resend.com";

function resendApiKey(smtpUrl: string) {
  try {
    const url = new URL(smtpUrl);
    return url.hostname === RESEND_SMTP_HOST && url.password
      ? decodeURIComponent(url.password)
      : undefined;
  } catch {
    return undefined;
  }
}

async function sendViaResend(
  apiKey: string,
  message: { from?: string; to: string; subject: string; text: string },
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Resend API rejected the email (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
}

export async function sendMail(to: string, subject: string, text: string) {
  if (!process.env.SMTP_URL)
    throw new Error("SMTP_URL is required to send email");
  const message = { from: process.env.EMAIL_FROM, to, subject, text };
  const apiKey = resendApiKey(process.env.SMTP_URL);
  if (apiKey) return sendViaResend(apiKey, message);
  // Docker Desktop exposes the local Mailpit port on IPv4. On Windows,
  // `localhost` may resolve to IPv6 first and leave Nodemailer waiting for its
  // default socket timeout before it falls back.
  const smtpUrl = process.env.SMTP_URL.replace(
    /^smtp:\/\/localhost(?=[:/]|$)/,
    "smtp://127.0.0.1",
  );
  await nodemailer.createTransport(smtpUrl).sendMail(message);
}
