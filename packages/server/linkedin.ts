import { pool } from "../db";
import { AppError, decrypt, encrypt, hashToken, token } from "../core/security";
import { validatePost, type Content } from "../core/domain";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";
import { readStoredObject } from "./media";

// Personal profile publishing only. Company pages need the Community
// Management API and a separate LinkedIn product approval.
export const LINKEDIN_SCOPES = [
  "openid",
  "profile",
  "w_member_social",
] as const;
const AUTHORIZATION_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";
const API = "https://api.linkedin.com";
const CALLBACK_PATH = "/api/oauth/linkedin/callback";
const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]{1,100}$/;
// Refresh slightly early so a token does not expire mid-publication.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const linkedInCapabilities = [
  "TEXT_POST",
  "IMAGE_POST",
  "LINK_POST",
  "HASHTAGS",
  "SCHEDULING",
];

export type LinkedInConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion: string;
};

function notConfigured() {
  return new AppError(
    503,
    "PROVIDER_NOT_CONFIGURED",
    "LinkedIn integration is not configured.",
  );
}

export function linkedInConfig(): LinkedInConfig {
  if (process.env.LINKEDIN_INTEGRATION_ENABLED !== "true")
    throw notConfigured();
  const clientId = process.env.LINKEDIN_CLIENT_ID?.trim();
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET?.trim();
  const redirect = process.env.LINKEDIN_REDIRECT_URI?.trim();
  const apiVersion = process.env.LINKEDIN_API_VERSION?.trim();
  if (!clientId || !clientSecret || !redirect || !apiVersion)
    throw notConfigured();
  // Versioned APIs use the YYYYMM format; each version is retired after a year.
  if (!/^\d{6}$/.test(apiVersion)) throw notConfigured();
  let redirectUri: URL;
  try {
    redirectUri = new URL(redirect);
  } catch {
    throw notConfigured();
  }
  if (
    redirectUri.pathname !== CALLBACK_PATH ||
    (redirectUri.protocol !== "https:" && redirectUri.hostname !== "localhost")
  )
    throw notConfigured();
  return {
    clientId,
    clientSecret,
    redirectUri: redirectUri.toString(),
    apiVersion,
  };
}

export function linkedInIntegrationStatus() {
  try {
    linkedInConfig();
    return { enabled: true };
  } catch {
    return { enabled: false };
  }
}

export function buildLinkedInAuthorizationUrl(
  config: LinkedInConfig,
  state: string,
) {
  // LinkedIn's web-app flow authenticates the code exchange with the client
  // secret; PKCE is only offered to native clients.
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  }).toString();
  return url.toString();
}

function unavailable() {
  return new AppError(
    503,
    "LINKEDIN_UNAVAILABLE",
    "LinkedIn is temporarily unavailable.",
  );
}

function uncertainDelivery() {
  return new AppError(
    409,
    "LINKEDIN_DELIVERY_UNCERTAIN",
    "LinkedIn did not confirm whether the post was published. Check the profile before retrying.",
  );
}

function classify(status: number) {
  if (status === 429)
    return new AppError(
      429,
      "LINKEDIN_RATE_LIMIT",
      "LinkedIn rate limit reached.",
    );
  if (status === 401)
    return new AppError(
      401,
      "LINKEDIN_TOKEN_INVALID",
      "The LinkedIn authorization is no longer valid. Reconnect the account.",
    );
  if (status >= 500) return unavailable();
  return new AppError(
    422,
    "LINKEDIN_REJECTED",
    "LinkedIn rejected the request. Check the account permissions and content.",
  );
}

function unsupported(code: string, message: string) {
  return new AppError(422, code, message);
}

type FetchLike = typeof fetch;

export type LinkedInGrant = {
  accessToken: string;
  expiresAt?: Date;
  refreshToken?: string;
  refreshExpiresAt?: Date;
  scopes: string[];
};

const secondsFromNow = (value: unknown) =>
  typeof value === "number" && value > 0
    ? new Date(Date.now() + value * 1000)
    : undefined;

export class LinkedInClient {
  constructor(
    private readonly config: LinkedInConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async send(url: string, init: RequestInit, delivery = false) {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // A timeout after the post request was sent may still have published it.
      throw delivery ? uncertainDelivery() : unavailable();
    }
    if (!response.ok) {
      const error = classify(response.status);
      if (delivery && error.code === "LINKEDIN_UNAVAILABLE")
        throw uncertainDelivery();
      throw error;
    }
    return response;
  }

  private headers(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": this.config.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };
  }

  private async grant(params: Record<string, string>): Promise<LinkedInGrant> {
    let response: Response;
    try {
      response = await this.send(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...params,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (error) {
      // invalid_grant and friends come back as 400; they need a reconnect.
      if (error instanceof AppError && error.code === "LINKEDIN_REJECTED")
        throw new AppError(
          401,
          "LINKEDIN_TOKEN_INVALID",
          "LinkedIn did not accept the authorization.",
        );
      throw error;
    }
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token)
      throw new AppError(
        502,
        "LINKEDIN_TOKEN_INVALID",
        "LinkedIn did not return an access token.",
      );
    return {
      accessToken: payload.access_token,
      expiresAt: secondsFromNow(payload.expires_in),
      refreshToken: payload.refresh_token || undefined,
      refreshExpiresAt: secondsFromNow(payload.refresh_token_expires_in),
      scopes: (payload.scope ?? "").split(/[\s,]+/).filter(Boolean),
    };
  }

  exchangeCode(code: string) {
    return this.grant({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
    });
  }

  refresh(refreshToken: string) {
    return this.grant({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async revoke(accessToken: string) {
    await this.send(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        token: accessToken,
      }),
    });
  }

  async userInfo(accessToken: string) {
    const response = await this.send(`${API}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (await response.json().catch(() => ({}))) as {
      sub?: string;
      name?: string;
      picture?: string;
    };
  }

  async initializeImageUpload(accessToken: string, owner: string) {
    const response = await this.send(
      `${API}/rest/images?action=initializeUpload`,
      {
        method: "POST",
        headers: this.headers(accessToken),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      value?: { uploadUrl?: string; image?: string };
    };
    const uploadUrl = payload.value?.uploadUrl;
    const image = payload.value?.image;
    if (!uploadUrl || !image?.startsWith("urn:li:image:")) throw unavailable();
    return { uploadUrl: assertLinkedInUploadUrl(uploadUrl), image };
  }

  async uploadImage(
    uploadUrl: string,
    accessToken: string,
    bytes: Uint8Array,
    mimeType: string,
  ) {
    await this.send(assertLinkedInUploadUrl(uploadUrl), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: bytes as unknown as BodyInit,
    });
  }

  async createPost(accessToken: string, body: Record<string, unknown>) {
    const response = await this.send(
      `${API}/rest/posts`,
      {
        method: "POST",
        headers: this.headers(accessToken),
        body: JSON.stringify(body),
      },
      true,
    );
    // The request succeeded, so the post may be live even without an id.
    const id = response.headers.get("x-restli-id")?.trim();
    if (!id) throw uncertainDelivery();
    return id;
  }
}

// The bearer token is sent along with the bytes, so only LinkedIn hosts from
// the initializeUpload response are accepted.
function assertLinkedInUploadUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
  )
    throw new AppError(
      502,
      "LINKEDIN_UPLOAD_URL_INVALID",
      "LinkedIn returned an unexpected upload address.",
    );
  return url.toString();
}

// Posts use LinkedIn's "little" text format, where these characters are
// markup. Hashtags are kept as hashtag templates so they stay clickable.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (value: string) =>
  value.replace(RESERVED, (character) => `\\${character}`);

export function linkedInCommentary(caption: string, link?: string | null) {
  const text =
    link && !caption.includes(link)
      ? `${caption.trimEnd()}${caption.trim() ? "\n\n" : ""}${link}`
      : caption;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    out +=
      escapeLittle(text.slice(last, match.index)) +
      `{hashtag|\\#|${escapeLittle(match[1])}}`;
    last = match.index + match[0].length;
  }
  return out + escapeLittle(text.slice(last));
}

type LinkedInCredential = {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
  scopes: string[];
  personUrn: string;
};

function credentialScope(
  organizationId: string,
  clientId: string,
  accountId: string,
) {
  return `${organizationId}:${clientId}:${accountId}`;
}

function sealCredential(
  credential: LinkedInCredential,
  organizationId: string,
  clientId: string,
  accountId: string,
) {
  return encrypt(
    JSON.stringify(credential),
    credentialScope(organizationId, clientId, accountId),
  );
}

function decodeCredential(
  encryptedValue: string,
  organizationId: string,
  clientId: string,
  accountId: string,
): LinkedInCredential {
  try {
    const value = JSON.parse(
      decrypt(
        encryptedValue,
        credentialScope(organizationId, clientId, accountId),
      ),
    ) as LinkedInCredential;
    if (value.version !== 1 || !value.accessToken || !value.personUrn)
      throw new Error("invalid credential");
    return value;
  } catch {
    throw new AppError(
      503,
      "LINKEDIN_CREDENTIAL_INVALID",
      "The stored LinkedIn credential is invalid. Reconnect the account.",
    );
  }
}

export const linkedInGrantHash = (personUrn: string) =>
  hashToken(`linkedin-member:${personUrn}`);

export async function startLinkedInOAuth(c: Context) {
  const config = linkedInConfig();
  const state = token();
  await transaction(async (tx) => {
    await tx.query(
      "DELETE FROM oauth_states WHERE expires_at<=now() OR (user_id=$1 AND provider='linkedin')",
      [c.userId],
    );
    await tx.query(
      "INSERT INTO oauth_states(organization_id,client_id,user_id,provider,state_hash,expires_at) VALUES($1,$2,$3,'linkedin',$4,now()+interval '10 minutes')",
      [c.organizationId, c.clientId, c.userId, hashToken(state)],
    );
  });
  return { url: buildLinkedInAuthorizationUrl(config, state) };
}

export async function completeLinkedInOAuth(
  c: Context,
  code: string,
  client = new LinkedInClient(linkedInConfig()),
) {
  const grant = await client.exchangeCode(code);
  if (!grant.scopes.includes("w_member_social"))
    throw new AppError(
      403,
      "LINKEDIN_SCOPE_MISSING",
      "LinkedIn did not grant permission to publish on the profile.",
    );
  const profile = await client.userInfo(grant.accessToken);
  const personUrn = `urn:li:person:${profile.sub ?? ""}`;
  if (!PERSON_URN.test(personUrn))
    throw new AppError(
      502,
      "LINKEDIN_PROFILE_INVALID",
      "LinkedIn did not return a member identifier.",
    );
  const credential: LinkedInCredential = {
    version: 1,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    refreshExpiresAt: grant.refreshExpiresAt?.toISOString(),
    scopes: grant.scopes,
    personUrn,
  };
  const avatar = profile.picture?.startsWith("https://")
    ? profile.picture
    : null;
  return transaction(async (tx) => {
    const account = (
      await tx.query(
        `INSERT INTO social_accounts(organization_id,client_id,platform,name,remote_id,mode,status,token_health,capabilities,avatar,last_sync_at)
         VALUES($1,$2,'linkedin',$3,$4,'direct','CONNECTED','HEALTHY',$5,$6,now())
         ON CONFLICT(organization_id,client_id,platform,mode,remote_id) WHERE deleted_at IS NULL
         DO UPDATE SET name=excluded.name,status='CONNECTED',token_health='HEALTHY',capabilities=excluded.capabilities,avatar=excluded.avatar,updated_at=now()
         RETURNING id`,
        [
          c.organizationId,
          c.clientId,
          profile.name?.trim().slice(0, 200) || "LinkedIn",
          personUrn,
          JSON.stringify(linkedInCapabilities),
          avatar,
        ],
      )
    ).rows[0];
    await tx.query(
      `INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value,expires_at,grant_hash)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(social_account_id) DO UPDATE SET encrypted_value=excluded.encrypted_value,expires_at=excluded.expires_at,grant_hash=excluded.grant_hash,updated_at=now()`,
      [
        c.organizationId,
        c.clientId,
        account.id,
        sealCredential(credential, c.organizationId, c.clientId, account.id),
        grant.expiresAt ?? null,
        linkedInGrantHash(personUrn),
      ],
    );
    await audit(tx, c, "social_account.connected", account.id, {
      platform: "linkedin",
      mode: "direct",
    });
    return { connected: 1, accountId: account.id as string };
  });
}

// The state is looked up and checked against the signed-in session before it
// is consumed, so a foreign callback cannot burn someone else's state.
export async function handleLinkedInCallback(
  input: { state: string | null; code: string | null; error: string | null },
  resolveContext: (clientId: string) => Promise<Context>,
  client?: LinkedInClient,
) {
  const config = linkedInConfig();
  if (!input.state)
    throw new AppError(400, "OAUTH_STATE_MISSING", "OAuth state missing.");
  const found = (
    await pool.query(
      "SELECT * FROM oauth_states WHERE state_hash=$1 AND provider='linkedin' AND expires_at>now()",
      [hashToken(input.state)],
    )
  ).rows[0];
  if (!found)
    throw new AppError(403, "OAUTH_STATE_INVALID", "OAuth state expired.");
  const c = await resolveContext(found.client_id);
  if (
    c.userId !== found.user_id ||
    c.organizationId !== found.organization_id ||
    c.clientId !== found.client_id
  )
    throw new AppError(
      403,
      "OAUTH_SESSION_MISMATCH",
      "OAuth session mismatch.",
    );
  const consumed = await pool.query(
    "DELETE FROM oauth_states WHERE id=$1 AND expires_at>now() RETURNING id",
    [found.id],
  );
  if (!consumed.rows.length)
    throw new AppError(403, "OAUTH_STATE_INVALID", "OAuth state expired.");
  if (input.error)
    throw new AppError(
      400,
      "OAUTH_DENIED",
      "LinkedIn authorization was cancelled.",
    );
  if (!input.code)
    throw new AppError(400, "OAUTH_CODE_MISSING", "OAuth code missing.");
  return completeLinkedInOAuth(
    c,
    input.code,
    client ?? new LinkedInClient(config),
  );
}

async function markReconnectNeeded(accountId: string) {
  await pool.query(
    "UPDATE social_accounts SET token_health='EXPIRED',updated_at=now() WHERE id=$1",
    [accountId],
  );
}

function expired() {
  return new AppError(
    401,
    "LINKEDIN_TOKEN_EXPIRED",
    "The LinkedIn authorization expired. Reconnect the account.",
  );
}

async function loadLinkedInCredential(
  input: { organizationId: string; clientId: string; accountId: string },
  client: () => LinkedInClient,
) {
  const row = (
    await pool.query(
      `SELECT a.id,a.remote_id,c.encrypted_value,c.expires_at
       FROM social_accounts a JOIN social_credentials c ON c.social_account_id=a.id
       WHERE a.organization_id=$1 AND a.client_id=$2 AND a.id=$3
        AND a.mode='direct' AND a.platform='linkedin'
        AND a.status='CONNECTED' AND a.deleted_at IS NULL`,
      [input.organizationId, input.clientId, input.accountId],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      422,
      "LINKEDIN_ACCOUNT_UNAVAILABLE",
      "The LinkedIn account is not connected.",
    );
  if (!PERSON_URN.test(row.remote_id))
    throw unsupported(
      "LINKEDIN_ORGANIZATION_UNSUPPORTED",
      "Publishing to LinkedIn company pages is not supported yet.",
    );
  const credential = decodeCredential(
    row.encrypted_value,
    input.organizationId,
    input.clientId,
    row.id,
  );
  if (
    !row.expires_at ||
    new Date(row.expires_at).getTime() - EXPIRY_MARGIN_MS > Date.now()
  )
    return credential;
  // Plain member apps usually get no refresh token: they must reconnect.
  if (
    !credential.refreshToken ||
    (credential.refreshExpiresAt &&
      new Date(credential.refreshExpiresAt).getTime() <= Date.now())
  ) {
    await markReconnectNeeded(row.id);
    throw expired();
  }
  let next: LinkedInGrant;
  try {
    next = await client().refresh(credential.refreshToken);
  } catch (error) {
    if (
      error instanceof AppError &&
      ["LINKEDIN_UNAVAILABLE", "LINKEDIN_RATE_LIMIT"].includes(error.code)
    )
      throw error;
    await markReconnectNeeded(row.id);
    throw expired();
  }
  const refreshed: LinkedInCredential = {
    ...credential,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken ?? credential.refreshToken,
    refreshExpiresAt:
      next.refreshExpiresAt?.toISOString() ?? credential.refreshExpiresAt,
  };
  await pool.query(
    `UPDATE social_credentials SET encrypted_value=$1,expires_at=$2,updated_at=now()
     WHERE organization_id=$3 AND client_id=$4 AND social_account_id=$5`,
    [
      sealCredential(refreshed, input.organizationId, input.clientId, row.id),
      next.expiresAt ?? null,
      input.organizationId,
      input.clientId,
      row.id,
    ],
  );
  await pool.query(
    "UPDATE social_accounts SET token_health='HEALTHY',updated_at=now() WHERE id=$1",
    [row.id],
  );
  return refreshed;
}

type LinkedInMedia = Content["media"][number] & { object_key: string };

async function receipt(input: {
  idempotencyKey: string;
  organizationId: string;
  clientId: string;
}) {
  return (
    await pool.query(
      "SELECT remote_id FROM provider_receipts WHERE idempotency_key=$1 AND organization_id=$2 AND client_id=$3 AND provider='linkedin'",
      [input.idempotencyKey, input.organizationId, input.clientId],
    )
  ).rows[0]?.remote_id as string | undefined;
}

export async function publishLinkedIn(
  input: {
    organizationId: string;
    clientId: string;
    accountId: string;
    content: Content & { media: LinkedInMedia[] };
    idempotencyKey: string;
  },
  deps: {
    client?: LinkedInClient;
    readObject?: (key: string) => Promise<Uint8Array>;
  } = {},
) {
  const prior = await receipt(input);
  if (prior) return { remoteId: prior };
  const errors = validatePost("linkedin", input.content);
  if (errors.length) throw new AppError(422, "VALIDATION", errors.join(" "));
  if (input.content.media.length > 1)
    throw unsupported(
      "LINKEDIN_MEDIA_UNSUPPORTED",
      "LinkedIn publishing currently supports text or a single image.",
    );
  const media = input.content.media[0];
  if (media && !media.mime_type.startsWith("image/"))
    throw unsupported(
      "LINKEDIN_MEDIA_UNSUPPORTED",
      "LinkedIn publishing currently supports text or a single image.",
    );
  let client = deps.client;
  const lazyClient = () => (client ??= new LinkedInClient(linkedInConfig()));
  const credential = await loadLinkedInCredential(input, lazyClient);
  const linkedIn = lazyClient();
  let image: string | undefined;
  try {
    if (media) {
      const bytes = await (deps.readObject ?? readStoredObject)(
        media.object_key,
      );
      const upload = await linkedIn.initializeImageUpload(
        credential.accessToken,
        credential.personUrn,
      );
      await linkedIn.uploadImage(
        upload.uploadUrl,
        credential.accessToken,
        bytes,
        media.mime_type,
      );
      image = upload.image;
    }
    const remoteId = await linkedIn.createPost(credential.accessToken, {
      author: credential.personUrn,
      commentary: linkedInCommentary(input.content.caption, input.content.link),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(image ? { content: { media: { id: image } } } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    const inserted = (
      await pool.query(
        `INSERT INTO provider_receipts(idempotency_key,organization_id,client_id,provider,remote_id)
         VALUES($1,$2,$3,'linkedin',$4)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING remote_id`,
        [input.idempotencyKey, input.organizationId, input.clientId, remoteId],
      )
    ).rows[0]?.remote_id;
    if (inserted) return { remoteId: inserted as string };
    const concurrent = await receipt(input);
    if (!concurrent)
      throw new AppError(
        409,
        "PROVIDER_RECEIPT_CONFLICT",
        "The provider receipt does not match this publication.",
      );
    return { remoteId: concurrent };
  } catch (error) {
    if (error instanceof AppError && error.code === "LINKEDIN_TOKEN_INVALID")
      await markReconnectNeeded(input.accountId);
    throw error;
  }
}

// Revocation is best effort: the stored token is deleted either way and
// expires on LinkedIn's side.
export async function revokeLinkedInAccess(c: Context, accountId: string) {
  const row = (
    await pool.query(
      `SELECT c.encrypted_value FROM social_credentials c
       JOIN social_accounts a ON a.id=c.social_account_id
       WHERE a.organization_id=$1 AND a.client_id=$2 AND a.id=$3 AND a.platform='linkedin'`,
      [c.organizationId, c.clientId, accountId],
    )
  ).rows[0];
  if (!row || !linkedInIntegrationStatus().enabled) return { revoked: false };
  try {
    const credential = decodeCredential(
      row.encrypted_value,
      c.organizationId,
      c.clientId,
      accountId,
    );
    await new LinkedInClient(linkedInConfig()).revoke(credential.accessToken);
    return { revoked: true };
  } catch {
    return { revoked: false };
  }
}
