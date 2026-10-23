export interface AuthBindings {
  DB: D1Database;
  DEPLOYMENT_ENV?: string;
  AUTH_MODE?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  DEV_USER_SUB?: string;
}

export interface AuthIdentity {
  sub: string;
  email: string;
}

export interface UserRow {
  id: string;
  access_sub: string;
  email: string;
  timezone: string;
  locale: "ja" | "en";
  digest_time: string;
  default_priority: number;
  default_project_id: string | null;
  field_ts: string;
  seq_counter: number;
  settings_seq: number;
  tombstone_floor_seq: number;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

interface JsonWebKeySet {
  keys?: AccessJwk[];
}

const CLOCK_TOLERANCE_SECONDS = 60;
const CERT_CACHE_MS = 5 * 60 * 1000;
const certCache = new Map<string, { keys: AccessJwk[]; expiresAt: number }>();

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJsonSegment(value: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function fetchKeys(team: string, refresh = false): Promise<AccessJwk[] | null> {
  const cached = certCache.get(team);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  try {
    const response = await fetch(`https://${team}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !Array.isArray((body as JsonWebKeySet).keys)) {
      return null;
    }
    const keys = (body as JsonWebKeySet).keys!;
    certCache.set(team, { keys, expiresAt: Date.now() + CERT_CACHE_MS });
    return keys;
  } catch {
    return null;
  }
}

function audMatches(claim: unknown, expected: string): boolean {
  return claim === expected || (Array.isArray(claim) && claim.includes(expected));
}

export async function verifyAccessJwt(
  token: string,
  env: Pick<AuthBindings, "ACCESS_TEAM" | "ACCESS_AUD" | "ALLOWED_EMAILS">,
): Promise<AuthIdentity | null> {
  const team = env.ACCESS_TEAM;
  const audience = env.ACCESS_AUD;
  const allowedEmails = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!team || !/^[a-z0-9.-]+$/i.test(team) || !audience || allowedEmails.length === 0) return null;

  if (token.length > 16_384) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (
    !header ||
    !payload ||
    !signature ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string"
  ) {
    return null;
  }

  let keys = await fetchKeys(team);
  let jwk = keys?.find((key) => key !== null && typeof key === "object" && key.kid === header.kid);
  if (!jwk) {
    keys = await fetchKeys(team, true);
    jwk = keys?.find((key) => key !== null && typeof key === "object" && key.kid === header.kid);
  }
  if (
    !jwk ||
    jwk.kty !== "RSA" ||
    (jwk.alg && jwk.alg !== "RS256") ||
    (jwk.use && jwk.use !== "sig")
  ) {
    return null;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer.slice(
        signature.byteOffset,
        signature.byteOffset + signature.byteLength,
      ) as ArrayBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      !validSignature ||
      payload.iss !== `https://${team}` ||
      !audMatches(payload.aud, audience) ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp < now - CLOCK_TOLERANCE_SECONDS ||
      (payload.nbf !== undefined &&
        (typeof payload.nbf !== "number" ||
          !Number.isFinite(payload.nbf) ||
          payload.nbf > now + CLOCK_TOLERANCE_SECONDS)) ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      typeof payload.email !== "string" ||
      payload.email.length > 320 ||
      !allowedEmails.includes(payload.email.toLowerCase())
    ) {
      return null;
    }
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export async function authenticate(
  request: Request,
  env: AuthBindings,
): Promise<AuthIdentity | null> {
  const localMode = env.AUTH_MODE;
  if ((localMode === "development" || localMode === "test") && env.DEPLOYMENT_ENV === localMode) {
    const email = (env.ALLOWED_EMAILS ?? "isksss.prp@gmail.com").split(",")[0].trim();
    return {
      sub: env.DEV_USER_SUB ?? `local-${localMode}-user`,
      email,
    };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  return token ? verifyAccessJwt(token, env) : null;
}

export async function findOrCreateUser(
  env: AuthBindings,
  identity: AuthIdentity,
): Promise<UserRow> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
       (id, access_sub, email, timezone, locale, digest_time, field_ts, seq_counter, settings_seq)
     VALUES (?, ?, ?, 'Asia/Tokyo', 'ja', '08:00', '{}', 1, 1)`,
  )
    .bind(crypto.randomUUID(), identity.sub, identity.email)
    .run();
  await env.DB.prepare("UPDATE users SET email = ? WHERE access_sub = ? AND email <> ?")
    .bind(identity.email, identity.sub, identity.email)
    .run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE access_sub = ?")
    .bind(identity.sub)
    .first<UserRow>();
  if (!user) throw new Error("Authenticated user could not be created");
  return user;
}

export function clearAccessCertCache(): void {
  certCache.clear();
}
