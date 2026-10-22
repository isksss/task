import { Hono } from "hono";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
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

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export const scheduled: ExportedHandler<Env>["scheduled"] = async (event) => {
  console.log("Scheduled trigger", event.cron);
};

export default {
  fetch: app.fetch,
  scheduled,
};
