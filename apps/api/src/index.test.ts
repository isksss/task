import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { app, scheduled, type Env } from "./index";

const workerEnv = env as unknown as Env;

describe("API Worker", () => {
  it("checks D1 and returns health JSON", async () => {
    const response = await app.request("/api/health", {}, workerEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns a JSON 404 for unknown API routes even when HTML is accepted", async () => {
    const response = await app.request(
      "/api/x",
      { headers: { Accept: "text/html" } },
      workerEnv,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("logs scheduled trigger events", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await scheduled?.(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} },
      workerEnv,
      {} as ExecutionContext,
    );

    expect(log).toHaveBeenCalledWith("Scheduled trigger", "* * * * *");
    log.mockRestore();
  });
});
