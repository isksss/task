import { describe, expect, it, vi, beforeEach } from "vitest";
import { app, scheduled } from "./index";
import { findOrCreateUser } from "./auth";
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

  it("exports only the authenticated user's data without internal sync or push details", async () => {
    const ownSub = crypto.randomUUID();
    const exportEnv = makeTestEnv(ownSub);
    const ownUser = await findOrCreateUser(exportEnv, { sub: ownSub, email: "own@example.test" });
    const otherSub = crypto.randomUUID();
    const otherUser = await findOrCreateUser(exportEnv, { sub: otherSub, email: "other@example.test" });
    const activeProjectId = crypto.randomUUID();
    const deletedProjectId = crypto.randomUUID();
    const activeTaskId = crypto.randomUUID();
    const deletedTaskId = crypto.randomUUID();
    const deletedBatchId = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();

    await exportEnv.DB.batch([
      exportEnv.DB.prepare("UPDATE users SET timezone = ?, locale = ?, digest_time = ? WHERE id = ?")
        .bind("Europe/Paris", "en", "09:15", ownUser.id),
      exportEnv.DB.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind("America/New_York", otherUser.id),
      exportEnv.DB.prepare(
        `INSERT INTO projects (id, user_id, parent_id, name, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, NULL, ?, NULL, NULL, '{"name":{"ts":1,"counter":0,"device_id":"internal"}}', 41)`,
      ).bind(activeProjectId, ownUser.id, "Own project"),
      exportEnv.DB.prepare(
        `INSERT INTO projects (id, user_id, parent_id, name, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, NULL, ?, ?, ?, '{"name":{"ts":2,"counter":0,"device_id":"internal"}}', 42)`,
      ).bind(deletedProjectId, ownUser.id, "Deleted project", "2026-01-02T03:04:05.000Z", deletedBatchId),
      exportEnv.DB.prepare(
        `INSERT INTO tasks (id, user_id, project_id, title, note, done, due_date, due_time, priority, created_at, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 3, ?, NULL, NULL, '{"title":{"ts":3,"counter":0,"device_id":"internal"}}', 51)`,
      ).bind(activeTaskId, ownUser.id, activeProjectId, "Own task", "Own note", "2026-01-03", "10:30", "2026-01-01T00:00:00.000Z"),
      exportEnv.DB.prepare(
        `INSERT INTO tasks (id, user_id, project_id, title, note, done, due_date, due_time, priority, created_at, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, ?, ?, '', 0, NULL, NULL, 0, ?, ?, ?, '{"done":{"ts":4,"counter":0,"device_id":"internal"}}', 52)`,
      ).bind(deletedTaskId, ownUser.id, deletedProjectId, "Deleted task", "2026-01-01T00:00:00.000Z", "2026-01-02T03:04:05.000Z", deletedBatchId),
      exportEnv.DB.prepare(
        `INSERT INTO projects (id, user_id, parent_id, name, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, NULL, ?, NULL, NULL, '{}', 1)`,
      ).bind(otherProjectId, otherUser.id, "Other user's private project"),
      exportEnv.DB.prepare(
        `INSERT INTO tasks (id, user_id, project_id, title, note, done, due_date, due_time, priority, created_at, deleted_at, deleted_batch_id, field_ts, seq)
         VALUES (?, ?, NULL, ?, '', 0, NULL, NULL, 0, ?, NULL, NULL, '{"title":{"ts":5,"counter":0,"device_id":"private-clock"}}', 99)`,
      ).bind(otherTaskId, otherUser.id, "Other user's private task", "2026-01-01T00:00:00.000Z"),
      exportEnv.DB.prepare(
        "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), ownUser.id, "https://push.example.test/private-endpoint", "private-p256dh-marker", "private-auth-marker", "2026-01-01T00:00:00.000Z"),
    ]);

    const response = await app.request("/api/export", {}, exportEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="task-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    const exported = await response.json() as {
      format: string;
      version: number;
      tasks: Record<string, unknown>[];
      projects: Record<string, unknown>[];
      settings: Record<string, unknown>;
    };
    expect(exported).toMatchObject({
      format: "task-export",
      version: 1,
      settings: { timezone: "Europe/Paris", locale: "en", digest_time: "09:15" },
    });
    expect(exported.tasks).toHaveLength(2);
    expect(exported.projects).toHaveLength(2);
    expect(exported.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: activeTaskId, done: true, title: "Own task" }),
      expect.objectContaining({ id: deletedTaskId, deleted_at: "2026-01-02T03:04:05.000Z", deleted_batch_id: deletedBatchId }),
    ]));
    expect(exported.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: activeProjectId, name: "Own project" }),
      expect.objectContaining({ id: deletedProjectId, deleted_at: "2026-01-02T03:04:05.000Z", deleted_batch_id: deletedBatchId }),
    ]));
    const serialized = JSON.stringify(exported);
    for (const internal of ["field_ts", "seq", "user_id", "access_sub", "email", "private-clock", "private-endpoint", "private-p256dh-marker", "private-auth-marker"]) {
      expect(serialized).not.toContain(internal);
    }
    expect(serialized).not.toContain("Other user's private task");
    expect(serialized).not.toContain("Other user's private project");
    expect(serialized).not.toContain("America/New_York");
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
