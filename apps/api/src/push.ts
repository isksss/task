import { todayInTimeZone, wallClockToInstant } from "@task/shared";

export interface PushEnv {
  DB: D1Database;
  DEPLOYMENT_ENV?: string;
  AUTH_MODE?: string;
  VAPID_PRIVATE_KEY?: string;
}

interface VapidMaterial {
  jwk: JsonWebKey;
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface PushPreferences {
  timezone: string;
  locale: "ja" | "en";
  digest_time: string;
}

interface PushUserRow extends PushPreferences {
  id: string;
}

interface PushTaskRow extends PushPreferences {
  user_id: string;
  task_id: string;
  title: string;
  due_date: string;
  due_time: string;
}

interface NotificationSlot {
  userId: string;
  slotKey: string;
  dueAt: number;
  title: string;
  body: string;
  url: string;
}

interface Delivery {
  subscription: PushSubscriptionRow;
  slot: NotificationSlot;
}

const SUBJECT = "mailto:isksss.prp@gmail.com";
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_CRON = 100;
const SEND_CONCURRENCY = 10;
const NOTIFICATION_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const RFC_TEST_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "_jP0qw3qcZFNtVgj9ztUlI9BMG2SBzLbuaWaUyhkgiA",
  y: "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  key_ops: ["sign"],
  ext: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bufferOf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bufferOf(salt), info: bufferOf(info) },
    key,
    length * 8,
  ));
}

export async function encryptWebPushPayload(
  payload: string,
  userPublicKey: Uint8Array,
  authSecret: Uint8Array,
  options: { salt?: Uint8Array; ephemeralKeyPair?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  if (userPublicKey.byteLength !== 65 || userPublicKey[0] !== 4 || authSecret.byteLength !== 16) {
    throw new RangeError("Invalid Web Push subscription keys");
  }
  const userKey = await crypto.subtle.importKey(
    "raw",
    bufferOf(userPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = options.ephemeralKeyPair ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: userKey },
    ephemeral.privateKey,
    256,
  ));
  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    userPublicKey,
    ephemeralPublicKey,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength !== 16) throw new RangeError("Web Push salt must contain 16 bytes");
  const contentKey = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concatBytes(new TextEncoder().encode(payload), new Uint8Array([2]));
  const cipherText = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferOf(nonce), tagLength: 128 },
    await crypto.subtle.importKey("raw", bufferOf(contentKey), "AES-GCM", false, ["encrypt"]),
    bufferOf(plaintext),
  ));
  return concatBytes(salt, new Uint8Array([0, 0, 16, 0, 65]), ephemeralPublicKey, cipherText);
}

async function importVapidMaterial(jwk: JsonWebKey): Promise<VapidMaterial> {
  if (
    jwk.kty !== "EC" || jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof jwk.d !== "string"
  ) throw new TypeError("VAPID key must be a P-256 private JWK");
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  const d = decodeBase64Url(jwk.d);
  if (!x || x.byteLength !== 32 || !y || y.byteLength !== 32 || !d || d.byteLength !== 32) {
    throw new TypeError("VAPID JWK has invalid P-256 coordinates");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { jwk, privateKey, publicKey: concatBytes(new Uint8Array([4]), x, y) };
}

async function vapidMaterial(env: PushEnv): Promise<VapidMaterial | null> {
  const local =
    (env.AUTH_MODE === "development" && env.DEPLOYMENT_ENV === "development") ||
    (env.AUTH_MODE === "test" && env.DEPLOYMENT_ENV === "test");
  const raw = env.VAPID_PRIVATE_KEY ?? (local ? JSON.stringify(RFC_TEST_KEY) : undefined);
  if (!raw) return null;
  try {
    const jwk: unknown = JSON.parse(raw);
    return isRecord(jwk) ? await importVapidMaterial(jwk as JsonWebKey) : null;
  } catch {
    return null;
  }
}

export async function getVapidPublicKey(env: PushEnv): Promise<string | null> {
  const material = await vapidMaterial(env);
  return material ? base64Url(material.publicKey) : null;
}

async function signVapidJwt(endpoint: string, material: VapidMaterial, now: number): Promise<string> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Invalid Web Push endpoint");
  const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson({
    aud: url.origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: SUBJECT,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    material.privateKey,
    new TextEncoder().encode(unsigned),
  ));
  return `${unsigned}.${base64Url(signature)}`;
}

export async function createVapidJwt(endpoint: string, jwk: JsonWebKey, now = Date.now()): Promise<string> {
  return signVapidJwt(endpoint, await importVapidMaterial(jwk), now);
}

interface ParsedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function parsePushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.hash ? value : null;
  } catch {
    return null;
  }
}

export async function parsePushSubscription(value: unknown): Promise<ParsedSubscription | null> {
  if (!isRecord(value) || !isRecord(value.keys)) return null;
  const endpoint = parsePushEndpoint(value.endpoint);
  if (!endpoint) return null;
  const p256dh = value.keys.p256dh;
  const auth = value.keys.auth;
  if (typeof p256dh !== "string" || p256dh.length !== 87 || typeof auth !== "string" || auth.length !== 22) return null;
  const publicKey = decodeBase64Url(p256dh);
  const authSecret = decodeBase64Url(auth);
  if (!publicKey || publicKey.byteLength !== 65 || publicKey[0] !== 4 || !authSecret || authSecret.byteLength !== 16) return null;
  try {
    await crypto.subtle.importKey("raw", bufferOf(publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

function localDateOffset(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function localizedMessage(locale: "ja" | "en", title: string): string {
  return locale === "ja" ? `${title} の期限です` : `Due: ${title}`;
}

async function collectSlots(env: PushEnv, now: Date): Promise<NotificationSlot[]> {
  const taskRows = await env.DB.prepare(
    `SELECT t.user_id, t.id AS task_id, t.title, t.due_date, t.due_time,
            u.timezone, u.locale, u.digest_time
     FROM tasks t JOIN users u ON u.id = t.user_id
     WHERE t.done = 0 AND t.deleted_at IS NULL AND t.due_time IS NOT NULL
       AND t.due_date BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = t.user_id)
     ORDER BY t.due_date, t.due_time, t.id`,
  ).bind(localDateOffset(now, -1), localDateOffset(now, 1)).all<PushTaskRow>();
  const slots: NotificationSlot[] = [];
  for (const task of taskRows.results) {
    try {
      const dueAt = wallClockToInstant(task.due_date, task.due_time, task.timezone).getTime();
      if (dueAt > now.getTime() || now.getTime() - dueAt > RETRY_WINDOW_MS) continue;
      slots.push({
        userId: task.user_id,
        slotKey: `task:${task.task_id}:${task.due_date}T${task.due_time}`,
        dueAt,
        title: "task",
        body: localizedMessage(task.locale, task.title),
        url: `/?task=${encodeURIComponent(task.task_id)}`,
      });
    } catch (error) {
      console.error("Invalid task notification time", task.task_id, error);
    }
  }

  const users = await env.DB.prepare(
    `SELECT u.id, u.timezone, u.locale, u.digest_time FROM users u
     WHERE EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)`,
  ).all<PushUserRow>();
  for (const user of users.results) {
    try {
      const today = todayInTimeZone(now, user.timezone);
      const digestAt = wallClockToInstant(today, user.digest_time, user.timezone).getTime();
      if (digestAt > now.getTime() || now.getTime() - digestAt > RETRY_WINDOW_MS) continue;
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND due_date = ? AND due_time IS NULL`,
      ).bind(user.id, today).first<{ count: number }>();
      if (!count || count.count === 0) continue;
      slots.push({
        userId: user.id,
        slotKey: `digest:${today}`,
        dueAt: digestAt,
        title: "task",
        body: user.locale === "ja" ? `今日のタスク ${count.count} 件` : `You have ${count.count} tasks due today.`,
        url: "/",
      });
    } catch (error) {
      console.error("Invalid daily digest time", user.id, error);
    }
  }
  return slots.sort((a, b) => a.dueAt - b.dueAt || (a.slotKey < b.slotKey ? -1 : a.slotKey > b.slotKey ? 1 : 0));
}

export async function sendDuePushNotifications(env: PushEnv, now = new Date()): Promise<void> {
  const material = await vapidMaterial(env);
  if (!material) {
    console.warn("Web Push skipped: VAPID_PRIVATE_KEY is not configured or invalid");
    return;
  }
  try {
    if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid cron time");
    const slots = await collectSlots(env, now);
    if (slots.length === 0) return;
    const userIds = [...new Set(slots.map(({ userId }) => userId))];
    const subscriptions: PushSubscriptionRow[] = [];
    for (const userId of userIds) {
      const rows = await env.DB.prepare(
        "SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id",
      ).bind(userId).all<PushSubscriptionRow>();
      subscriptions.push(...rows.results);
    }
    const cutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const logged = await env.DB.prepare(
      "SELECT subscription_id, slot_key FROM notification_log WHERE sent_at >= ?",
    ).bind(cutoff).all<{ subscription_id: string; slot_key: string }>();
    const alreadySent = new Set(logged.results.map(({ subscription_id, slot_key }) => `${subscription_id}:${slot_key}`));
    const byUser = new Map<string, PushSubscriptionRow[]>();
    for (const subscription of subscriptions) {
      const list = byUser.get(subscription.user_id) ?? [];
      list.push(subscription);
      byUser.set(subscription.user_id, list);
    }
    const deliveries: Delivery[] = [];
    // shortcut: 失敗が続く先頭候補が後続を塞ぎうる。個人利用で1分100件を超えたら永続カーソルに移行する。
    for (const slot of slots) {
      for (const subscription of byUser.get(slot.userId) ?? []) {
        if (alreadySent.has(`${subscription.id}:${slot.slotKey}`)) continue;
        deliveries.push({ subscription, slot });
        if (deliveries.length === MAX_SENDS_PER_CRON) break;
      }
      if (deliveries.length === MAX_SENDS_PER_CRON) break;
    }

    for (let offset = 0; offset < deliveries.length; offset += SEND_CONCURRENCY) {
      await Promise.all(deliveries.slice(offset, offset + SEND_CONCURRENCY).map(async (delivery) => {
        const publicKey = decodeBase64Url(delivery.subscription.p256dh);
        const authSecret = decodeBase64Url(delivery.subscription.auth);
        if (!publicKey || !authSecret) return;
        try {
          const jwt = await signVapidJwt(delivery.subscription.endpoint, material, now.getTime());
          const body = await encryptWebPushPayload(JSON.stringify({
            title: delivery.slot.title,
            body: delivery.slot.body,
            url: delivery.slot.url,
          }), publicKey, authSecret);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          let response: Response;
          try {
            response = await fetch(delivery.subscription.endpoint, {
              method: "POST",
              redirect: "manual",
              signal: controller.signal,
              headers: {
                Authorization: `vapid t=${jwt}, k=${base64Url(material.publicKey)}`,
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                TTL: "3600",
                Urgency: "normal",
              },
              body: bufferOf(body),
            });
          } finally {
            clearTimeout(timeout);
          }
          if (response.status === 404 || response.status === 410) {
            await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
              .bind(delivery.subscription.id).run();
          } else if (response.ok) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO notification_log (subscription_id, slot_key, sent_at) VALUES (?, ?, ?)",
            ).bind(delivery.subscription.id, delivery.slot.slotKey, now.toISOString()).run();
          } else {
            console.warn("Web Push service returned an error", response.status);
          }
        } catch (error) {
          console.error("Web Push delivery failed", delivery.subscription.endpoint, error);
        }
      }));
    }
  } catch (error) {
    console.error("Web Push cron failed", error);
  }
}

export async function purgeNotificationLogs(env: PushEnv, now = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - NOTIFICATION_LOG_RETENTION_MS).toISOString();
    await env.DB.prepare("DELETE FROM notification_log WHERE sent_at < ?").bind(cutoff).run();
  } catch (error) {
    console.error("Notification log cleanup failed", error);
  }
}
