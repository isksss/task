import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./index";
import { clearAccessCertCache } from "./auth";
import { ensureTestSchema, makeTestEnv } from "./test-helpers";

const team = "test.cloudflareaccess.com";
const audience = "test-audience";
const allowedEmail = "allowed@example.com";
let signingKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid?: string; alg?: string; use?: string };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encode(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeToken(
  claims: Record<string, unknown> = {},
  options: { kid?: string; alg?: string; privateKey?: CryptoKey } = {},
): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? "test-key" };
  const payload = {
    iss: `https://${team}`,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: crypto.randomUUID(),
    email: allowedEmail,
    ...claims,
  };
  const content = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.privateKey ?? signingKey.privateKey,
    new TextEncoder().encode(content),
  );
  return `${content}.${base64url(new Uint8Array(signature))}`;
}

function accessEnv(overrides: Record<string, string> = {}) {
  return {
    ...makeTestEnv(),
    DEPLOYMENT_ENV: "staging",
    AUTH_MODE: "access",
    ACCESS_TEAM: team,
    ACCESS_AUD: audience,
    ALLOWED_EMAILS: allowedEmail,
    ...overrides,
  };
}

async function requestToken(token: string, workerEnv = accessEnv()) {
  return app.request(
    "/api/health",
    { headers: { "Cf-Access-Jwt-Assertion": token } },
    workerEnv,
  );
}

beforeAll(async () => {
  [signingKey, otherKey] = await Promise.all([
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ),
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ),
  ]);
  publicJwk = (await crypto.subtle.exportKey("jwk", signingKey.publicKey)) as typeof publicJwk;
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

beforeEach(async () => {
  await ensureTestSchema();
  clearAccessCertCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [publicJwk] })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessCertCache();
});

describe("Cloudflare Access JWT middleware", () => {
  it("verifies RS256 and provisions a user from the verified sub", async () => {
    const token = await makeToken();
    const response = await requestToken(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("rejects a modified signature and non-RS256 algorithms", async () => {
    const valid = await makeToken();
    const [header, payload, signature] = valid.split(".");
    const changed = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect((await requestToken(changed)).status).toBe(401);

    const wrongAlgorithm = await makeToken({}, { alg: "HS256" });
    expect((await requestToken(wrongAlgorithm)).status).toBe(401);
  });

  it.each([
    ["issuer", { iss: "https://wrong.cloudflareaccess.com" }],
    ["audience", { aud: "wrong-audience" }],
    ["expiration", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["not-before", { nbf: Math.floor(Date.now() / 1000) + 120 }],
    ["email", { email: "someone-else@example.com" }],
  ])("rejects a token with invalid %s", async (_name, claims) => {
    const token = await makeToken(claims);
    expect((await requestToken(token)).status).toBe(401);
  });

  it("refreshes cached certificates for an unknown key id", async () => {
    const token = await makeToken({}, { kid: "rotated-key" });
    expect((await requestToken(token)).status).toBe(401);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["staging", "test"],
    ["production", "development"],
  ])("cannot use the local bypass in %s", async (deployment, mode) => {
    const response = await app.request(
      "/api/health",
      {},
      accessEnv({ DEPLOYMENT_ENV: deployment, AUTH_MODE: mode }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects an absent token outside development and test", async () => {
    const response = await app.request(
      "/api/health",
      {},
      {
        ...(env as unknown as ReturnType<typeof makeTestEnv>),
        AUTH_MODE: "access",
        DEPLOYMENT_ENV: "production",
        ACCESS_TEAM: team,
        ACCESS_AUD: audience,
        ALLOWED_EMAILS: allowedEmail,
      },
    );
    expect(response.status).toBe(401);
  });
});
