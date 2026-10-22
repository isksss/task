import { env as testBindings } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./index";
import { ensureTestSchema, makeTestEnv } from "./test-helpers";
import {
  createVapidJwt,
  decodeBase64Url,
  encryptWebPushPayload,
  getVapidPublicKey,
  parsePushSubscription,
  purgeNotificationLogs,
  sendDuePushNotifications,
} from "./push";

const env = testBindings as unknown as { DB: D1Database };

const RFC_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "_jP0qw3qcZFNtVgj9ztUlI9BMG2SBzLbuaWaUyhkgiA",
  y: "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  key_ops: ["deriveBits", "sign"],
  ext: true,
};

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const decoded = decodeBase64Url(part)!;
  return JSON.parse(new TextDecoder().decode(decoded)) as Record<string, unknown>;
}

async function insertUser(sub: string, timezone = "Asia/Tokyo", locale: "ja" | "en" = "ja", digestTime = "08:00") {
  const workerEnv = makeTestEnv(sub);
  await app.request("/api/health", {}, workerEnv);
  const user = await env.DB.prepare("SELECT id FROM users WHERE access_sub = ?").bind(sub).first<{ id: string }>();
  if (!user) throw new Error("test user was not created");
  await env.DB.prepare("UPDATE users SET timezone = ?, locale = ?, digest_time = ? WHERE id = ?")
    .bind(timezone, locale, digestTime, user.id).run();
  return { workerEnv, userId: user.id };
}

async function insertSubscription(userId: string, endpoint = `https://push.example/${crypto.randomUUID()}`) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const auth = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, userId, endpoint, p256dh, auth, new Date().toISOString()).run();
  return { id, endpoint, p256dh, auth };
}

async function insertTask(
  userId: string,
  fields: { title: string; dueDate: string; dueTime: string | null },
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, note, done, due_date, due_time, priority, created_at, field_ts, seq)
     VALUES (?, ?, ?, '', 0, ?, ?, 0, ?, '{}', 0)`,
  ).bind(id, userId, fields.title, fields.dueDate, fields.dueTime, new Date().toISOString()).run();
  return id;
}

beforeEach(async () => {
  await ensureTestSchema();
});

describe("Web Push cryptography", () => {
  it("matches the RFC 8291 Appendix A aes128gcm test vector", async () => {
    const userPublic = decodeBase64Url(
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".replaceAll(" ", ""),
    )!;
    const ephemeralPublic = decodeBase64Url(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    )!;
    const privateKey = await crypto.subtle.importKey("jwk", RFC_KEY, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = await crypto.subtle.importKey("raw", bufferOf(ephemeralPublic), { name: "ECDH", namedCurve: "P-256" }, true, []);
    const auth = decodeBase64Url("BTBZMqHH6r4Tts7J_aSIgg")!;
    const salt = decodeBase64Url("DGv6ra1nlYgDCS1FRnbzlw")!;
    const body = await encryptWebPushPayload("When I grow up, I want to be a watermelon", userPublic, auth, {
      salt,
      ephemeralKeyPair: { privateKey, publicKey },
    });

    expect(body.slice(0, 86).byteLength).toBe(86);
    expect(encodeBase64Url(body.slice(0, 86))).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    expect(encodeBase64Url(body.slice(86))).toBe(
      "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
    );
  });

  it("creates a verifiable ES256 VAPID JWT with the required audience and subject", async () => {
    const now = 1_700_000_000_000;
    const jwt = await createVapidJwt("https://push.example/send/123", RFC_KEY, now);
    const [headerPart, claimPart, signaturePart] = jwt.split(".");
    expect(decodeJsonPart(headerPart!)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decodeJsonPart(claimPart!)).toEqual({
      aud: "https://push.example",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "mailto:isksss.prp@gmail.com",
    });
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: RFC_KEY.x, y: RFC_KEY.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bufferOf(decodeBase64Url(signaturePart!)!),
      new TextEncoder().encode(`${headerPart}.${claimPart}`),
    )).toBe(true);
  });
});

describe("push subscription API", () => {
  it("exposes the local test public key and validates subscription keys", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const response = await app.request("/api/push/vapid-public-key", {}, workerEnv);
    expect(response.status).toBe(200);
    const result = await response.json() as { publicKey: string };
    expect(decodeBase64Url(result.publicKey)).toHaveLength(65);
    expect(await getVapidPublicKey({ ...workerEnv, DEPLOYMENT_ENV: "production", AUTH_MODE: "access" })).toBeNull();

    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const subscription = {
      endpoint: "https://push.example/endpoint",
      keys: {
        p256dh: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
    await expect(parsePushSubscription(subscription)).resolves.toMatchObject({ endpoint: subscription.endpoint });
    await expect(parsePushSubscription({ ...subscription, endpoint: "http://push.example/endpoint" })).resolves.toBeNull();
    await expect(parsePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: "AA" } })).resolves.toBeNull();
  });

  it("upserts by endpoint and allows deletion only by the owning user", async () => {
    const { workerEnv: ownerEnv, userId } = await insertUser(crypto.randomUUID());
    const { workerEnv: otherEnv } = await insertUser(crypto.randomUUID());
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const subscription = {
      endpoint: `https://push.example/${crypto.randomUUID()}`,
      keys: {
        p256dh: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
    const post = () => app.request("/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    }, ownerEnv);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const stored = await env.DB.prepare("SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint).first<{ id: string; user_id: string }>();
    expect(stored).toMatchObject({ user_id: userId });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint).first<{ count: number }>()).toMatchObject({ count: 1 });

    const forbiddenDelete = await app.request("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }, otherEnv);
    expect(forbiddenDelete.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint).first<{ id: string }>()).toMatchObject({ id: stored!.id });

    const ownDelete = await app.request("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }, ownerEnv);
    expect(ownDelete.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint).first()).toBeNull();
  });

  it("rejects non-HTTPS endpoints and malformed subscription keys", async () => {
    const { workerEnv } = await insertUser(crypto.randomUUID());
    const response = await app.request("/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "http://push.example", keys: { p256dh: "AA", auth: "AA" } }),
    }, workerEnv);
    expect(response.status).toBe(400);
  });
});

describe("push notification cron", () => {
  it("skips sending without a configured secret outside development and test", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockedFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", mockedFetch);
    try {
      await sendDuePushNotifications({
        DB: env.DB,
        DEPLOYMENT_ENV: "staging",
        AUTH_MODE: "access",
      }, new Date());
      expect(warn).toHaveBeenCalledWith("Web Push skipped: VAPID_PRIVATE_KEY is not configured or invalid");
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it("sends due items across DST gaps/overlaps, logs successes, and avoids duplicate sends", async () => {
    const { workerEnv, userId } = await insertUser(crypto.randomUUID(), "America/New_York");
    await insertSubscription(userId);
    const overlapTask = await insertTask(userId, { title: "Overlap", dueDate: "2024-11-03", dueTime: "01:30" });
    const now = new Date("2024-11-03T06:00:00Z");
    const mockedFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", mockedFetch);
    try {
      await sendDuePushNotifications(workerEnv, now);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const request = mockedFetch.mock.calls[0]![1] as RequestInit;
      expect(request.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "3600" });
      await sendDuePushNotifications(workerEnv, now);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare("SELECT slot_key FROM notification_log WHERE slot_key = ?")
        .bind(`task:${overlapTask}:2024-11-03T01:30`).first()).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    const gapUser = await insertUser(crypto.randomUUID(), "America/New_York");
    await insertSubscription(gapUser.userId);
    await insertTask(gapUser.userId, { title: "Gap", dueDate: "2024-03-10", dueTime: "02:30" });
    const gapFetch = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", gapFetch);
    try {
      await sendDuePushNotifications(gapUser.workerEnv, new Date("2024-03-10T07:30:00Z"));
      expect(gapFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends localized date-only digests, retries failures, expires old slots, and removes gone endpoints", async () => {
    const { workerEnv, userId } = await insertUser(crypto.randomUUID(), "America/New_York", "en", "08:00");
    const sub = await insertSubscription(userId);
    await insertTask(userId, { title: "Date only", dueDate: "2024-11-03", dueTime: null });
    await insertTask(userId, { title: "Too old", dueDate: "2024-11-03", dueTime: "07:00" });
    const now = new Date("2024-11-03T13:59:00Z");
    const failThenSucceed = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    failThenSucceed.mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", failThenSucceed);
    try {
      await sendDuePushNotifications(workerEnv, now);
      expect(failThenSucceed).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare("SELECT slot_key FROM notification_log WHERE subscription_id = ?")
        .bind(sub.id).first()).toBeNull();
      await sendDuePushNotifications(workerEnv, now);
      expect(failThenSucceed).toHaveBeenCalledTimes(2);
      const log = await env.DB.prepare("SELECT slot_key, sent_at FROM notification_log WHERE subscription_id = ?")
        .bind(sub.id).first<{ slot_key: string; sent_at: string }>();
      expect(log).toMatchObject({ slot_key: "digest:2024-11-03", sent_at: now.toISOString() });
    } finally {
      vi.unstubAllGlobals();
    }

    const { workerEnv: goneEnv, userId: goneUserId } = await insertUser(crypto.randomUUID());
    const gone404 = await insertSubscription(goneUserId);
    const gone410 = await insertSubscription(goneUserId);
    await insertTask(goneUserId, { title: "Task", dueDate: "2024-06-01", dueTime: "12:30" });
    const goneFetch = vi.fn(async (input: string | URL | Request) =>
      new Response(null, { status: String(input) === gone404.endpoint ? 404 : 410 }),
    );
    vi.stubGlobal("fetch", goneFetch);
    try {
      await sendDuePushNotifications(goneEnv, new Date("2024-06-01T03:32:00Z"));
      expect(goneFetch).toHaveBeenCalledTimes(2);
      expect(await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id IN (?, ?)")
        .bind(gone404.id, gone410.id).all()).toMatchObject({ results: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips expired timed and digest slots and cleans old notification logs", async () => {
    const { workerEnv, userId } = await insertUser(crypto.randomUUID(), "America/New_York", "ja", "08:00");
    const sub = await insertSubscription(userId);
    await insertTask(userId, { title: "Old timed", dueDate: "2024-11-03", dueTime: "07:00" });
    await insertTask(userId, { title: "Today", dueDate: "2024-11-03", dueTime: null });
    const old = "2023-01-01T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO notification_log (subscription_id, slot_key, sent_at) VALUES (?, ?, ?)")
      .bind(sub.id, "old-slot", old).run();
    const mockedFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", mockedFetch);
    try {
      await sendDuePushNotifications(workerEnv, new Date("2024-11-03T14:05:00Z"));
      expect(mockedFetch).not.toHaveBeenCalled();
      await purgeNotificationLogs(workerEnv, new Date("2024-08-01T00:00:00Z"));
      expect(await env.DB.prepare("SELECT slot_key FROM notification_log WHERE slot_key = 'old-slot'").first()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
