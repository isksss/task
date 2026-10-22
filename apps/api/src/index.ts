import { Hono } from "hono";
import { authenticate, findOrCreateUser, type AuthBindings, type UserRow } from "./auth";
import { ensureLocalSchema } from "./schema";
import {
  getVapidPublicKey,
  parsePushEndpoint,
  parsePushSubscription,
  purgeNotificationLogs,
  sendDuePushNotifications,
} from "./push";
import {
  handleSyncRequest,
  purgeExpiredData,
  purgeTrashEntity,
  readUserSettings,
  requestBody,
  updateSettings,
  type SyncEnv,
} from "./sync";

export interface Env extends AuthBindings {
  ASSETS: Fetcher;
  VAPID_PRIVATE_KEY?: string;
}

type AppEnv = {
  Bindings: Env;
  Variables: { user: UserRow };
};

export const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const identity = await authenticate(c.req.raw, c.env);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  try {
    if (c.env.DEPLOYMENT_ENV === "development" && c.env.AUTH_MODE === "development") {
      await ensureLocalSchema(c.env.DB);
    }
    c.set("user", await findOrCreateUser(c.env, identity));
  } catch (error) {
    console.error("User initialization failed", error);
    return c.json({ error: "service_unavailable" }, 503);
  }
  await next();
  c.header("Cache-Control", "no-store");
});

app.get("/api/health", async (c) => {
  try {
    const result = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return result?.ok === 1 ? c.json({ ok: true }) : c.json({ ok: false }, 503);
  } catch (error) {
    console.error("Health check failed", error);
    return c.json({ ok: false }, 503);
  }
});

app.post("/api/sync", async (c) => {
  let body: unknown;
  try {
    body = await requestBody(c.req.raw);
  } catch (error) {
    return c.json({ error: error instanceof RangeError ? "request_too_large" : "invalid_request" }, error instanceof RangeError ? 413 : 400);
  }
  try {
    const result = await handleSyncRequest(c.env as SyncEnv, c.get("user"), body);
    return c.json(result.body, result.status);
  } catch (error) {
    console.error("Sync failed", error);
    return c.json({ error: "sync_failed" }, 500);
  }
});

app.post("/api/trash/purge", async (c) => {
  let body: unknown;
  try {
    body = await requestBody(c.req.raw);
  } catch (error) {
    return c.json({ error: error instanceof RangeError ? "request_too_large" : "invalid_request" }, error instanceof RangeError ? 413 : 400);
  }
  try {
    const result = await purgeTrashEntity(c.env as SyncEnv, c.get("user"), body);
    return c.json(result.body, result.status);
  } catch (error) {
    console.error("Trash purge failed", error);
    return c.json({ error: "purge_failed" }, 500);
  }
});

app.get("/api/push/vapid-public-key", async (c) => {
  const publicKey = await getVapidPublicKey(c.env);
  return publicKey ? c.json({ publicKey }) : c.json({ error: "push_unavailable" }, 503);
});

app.post("/api/push/subscriptions", async (c) => {
  let body: unknown;
  try {
    body = await requestBody(c.req.raw);
  } catch (error) {
    return c.json({ error: error instanceof RangeError ? "request_too_large" : "invalid_request" }, error instanceof RangeError ? 413 : 400);
  }
  const subscription = await parsePushSubscription(body);
  if (!subscription) return c.json({ error: "invalid_request" }, 400);
  try {
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
         p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(crypto.randomUUID(), c.get("user").id, subscription.endpoint, subscription.p256dh, subscription.auth, new Date().toISOString()).run();
    return c.json({ ok: true });
  } catch (error) {
    console.error("Push subscription save failed", error);
    return c.json({ error: "push_subscription_failed" }, 500);
  }
});

app.delete("/api/push/subscriptions", async (c) => {
  let body: unknown;
  try {
    body = await requestBody(c.req.raw);
  } catch (error) {
    return c.json({ error: error instanceof RangeError ? "request_too_large" : "invalid_request" }, error instanceof RangeError ? 413 : 400);
  }
  const endpoint = body !== null && typeof body === "object" && !Array.isArray(body)
    ? parsePushEndpoint((body as Record<string, unknown>).endpoint)
    : null;
  if (!endpoint) return c.json({ error: "invalid_request" }, 400);
  try {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
      .bind(c.get("user").id, endpoint).run();
    return c.json({ ok: true });
  } catch (error) {
    console.error("Push subscription delete failed", error);
    return c.json({ error: "push_subscription_failed" }, 500);
  }
});

app.get("/api/settings", async (c) => {
  try {
    return c.json(await readUserSettings(c.env as SyncEnv, c.get("user")));
  } catch (error) {
    console.error("Settings read failed", error);
    return c.json({ error: "settings_failed" }, 500);
  }
});

app.put("/api/settings", async (c) => {
  let body: unknown;
  try {
    body = await requestBody(c.req.raw);
  } catch (error) {
    return c.json({ error: error instanceof RangeError ? "request_too_large" : "invalid_request" }, error instanceof RangeError ? 413 : 400);
  }
  try {
    const result = await updateSettings(c.env as SyncEnv, c.get("user"), body);
    return c.json(result.body, result.status);
  } catch (error) {
    console.error("Settings update failed", error);
    return c.json({ error: "settings_failed" }, 500);
  }
});

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export const scheduled: ExportedHandler<Env>["scheduled"] = async (event, env) => {
  console.log("Scheduled trigger", event.cron);
  if (event.cron === "* * * * *") await sendDuePushNotifications(env);
  if (event.cron === "0 0 * * *") {
    await purgeExpiredData(env);
    await purgeNotificationLogs(env);
  }
};

export default {
  fetch: app.fetch,
  scheduled,
};
