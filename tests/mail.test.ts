import { afterEach, describe, expect, it, vi } from "vitest";

const sendMailSmtp = vi.fn(async () => ({}));
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailSmtp })) },
}));

const { sendMail } = await import("../packages/server/mail");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sendMailSmtp.mockClear();
});

describe("sendMail", () => {
  it("sends Resend mail over the HTTPS API instead of SMTP", async () => {
    vi.stubEnv("SMTP_URL", "smtps://resend:re_test%2Bkey@smtp.resend.com:465");
    vi.stubEnv("EMAIL_FROM", "Hub <hub@example.com>");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendMail("a@example.com", "Subject", "Body");

    expect(sendMailSmtp).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test+key",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Hub <hub@example.com>",
      to: "a@example.com",
      subject: "Subject",
      text: "Body",
    });
  });

  it("reports a rejected Resend request", async () => {
    vi.stubEnv("SMTP_URL", "smtps://resend:key@smtp.resend.com:465");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("domain not verified", { status: 403 })),
    );
    await expect(sendMail("a@example.com", "S", "B")).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it("keeps SMTP for other providers", async () => {
    vi.stubEnv("SMTP_URL", "smtp://localhost:1025");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendMail("a@example.com", "S", "B");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMailSmtp).toHaveBeenCalledOnce();
  });
});
