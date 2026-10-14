import { describe, expect, it } from "vitest";
import { scrubEvent, scrubUrl } from "../packages/core/telemetry";

const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

describe("error report scrubbing", () => {
  it("removes bearer tokens from links", () => {
    expect(scrubUrl(`https://hub.example/invite/${token}`)).toBe(
      "https://hub.example/invite/[Filtered]",
    );
    expect(scrubUrl(`https://hub.example/approve/${token}?x=1`)).toBe(
      "https://hub.example/approve/[Filtered]?x=1",
    );
    expect(
      scrubUrl(`https://hub.example/reset-password?token=${token}&lang=hu`),
    ).toBe("https://hub.example/reset-password?token=[Filtered]&lang=hu");
    expect(
      scrubUrl(
        "https://hub.example/api/oauth/meta/callback?code=abc&state=def",
      ),
    ).toBe(
      "https://hub.example/api/oauth/meta/callback?code=[Filtered]&state=[Filtered]",
    );
    expect(scrubUrl("https://hub.example/meta/deletion/abc123def456")).toBe(
      "https://hub.example/meta/deletion/[Filtered]",
    );
  });

  it("drops cookies, auth headers, bodies and personal user data", () => {
    const event = scrubEvent({
      request: {
        url: `https://hub.example/invite/${token}`,
        query_string: "token=x",
        cookies: { session: "secret" },
        headers: {
          Cookie: "session=secret",
          Authorization: "Bearer secret",
          "User-Agent": "test",
        },
        data: { password: "secret" },
      },
      user: { id: "u1", email: "person@example.test", ip_address: "1.2.3.4" },
      breadcrumbs: [
        { message: `fetch /api/invitation/${token}` },
        { data: { url: `/approve/${token}` } },
      ],
    });
    expect(event.request).toEqual({
      url: "https://hub.example/invite/[Filtered]",
      headers: { "User-Agent": "test" },
    });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.breadcrumbs).toEqual([
      { message: "fetch /api/invitation/[Filtered]" },
      { data: { url: "/approve/[Filtered]" } },
    ]);
  });
});
