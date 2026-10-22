import { describe, expect, it, vi, beforeEach } from "vitest";
import { app, scheduled } from "./index";
import { requestBody } from "./sync";
import { ensureTestSchema, makeTestEnv } from "./test-helpers";

const workerEnv = makeTestEnv();

beforeEach(async () => {
  await ensureTestSchema();
});

describe("request body limit", () => {
  it("rejects an oversized Content-Length before reading the body", async () => {
    const request = new Request("https://task.test/api/sync", {
      method: "POST",
      headers: { "Content-Length": "3000001" },
      body: "{}",
    });
    expect(request.bodyUsed).toBe(false);
    await expect(requestBody(request)).rejects.toThrow(RangeError);
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading a streamed body after it exceeds the byte limit", async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(1_000_000));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://task.test/api/sync", {
      method: "POST",
      headers: { "Content-Length": "1" },
      body: stream,
    });

    await expect(requestBody(request)).rejects.toThrow(RangeError);
    expect(reads).toBeLessThan(10);
  });
});

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
