import nodemailer from "nodemailer";

export async function sendMail(to: string, subject: string, text: string) {
  if (!process.env.SMTP_URL)
    throw new Error("SMTP_URL is required to send email");
  // Docker Desktop exposes the local Mailpit port on IPv4. On Windows,
  // `localhost` may resolve to IPv6 first and leave Nodemailer waiting for its
  // default socket timeout before it falls back.
  const smtpUrl = process.env.SMTP_URL.replace(
    /^smtp:\/\/localhost(?=[:/]|$)/,
    "smtp://127.0.0.1",
  );
  await nodemailer
    .createTransport(smtpUrl)
    .sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
}
