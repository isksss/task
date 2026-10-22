import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { compareHlc, HLC_FUTURE_TOLERANCE_MS, type Task } from "@task/shared";
import {
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  initializeDatabase,
  purgeTrash,
  TaskDatabase,
  updateProject,
  updateSettings,
} from "./db";
import { getSince } from "./db";
import { ReauthenticationRequired, syncNow } from "./sync";

const opened: TaskDatabase[] = [];

async function testDb(): Promise<TaskDatabase> {
  const database = new TaskDatabase(`task-test-${crypto.randomUUID()}`);
  opened.push(database);
  await initializeDatabase(database);
  return database;
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    database.close();
    await database.delete();
  }
});

function serverTask(id: string, title: string, seq: number): Task {
  return {
    id,
    project_id: null,
    title,
    note: "",
    done: false,
    due_date: null,
    due_time: null,
    priority: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    deleted_batch_id: null,
    field_ts: { title: { ts: seq, counter: 0, device_id: "server" } },
    seq,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("local database", () => {
  it("persists a device ID and stores local writes with their versioned outbox change", async () => {
    const database = await testDb();
    const task = await createTask("Plan the week", null, database);
    const device = await database.meta.get("device_id");
    const queued = await database.outbox.toArray();

    expect(typeof device?.value).toBe("string");
    await initializeDatabase(database);
    expect((await database.meta.get("device_id"))?.value).toBe(device?.value);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ entity: "task", id: task.id });
    expect(Object.keys(queued[0]!.fields).sort()).toEqual([
      "created_at", "deleted_at", "deleted_batch_id", "done", "due_date", "due_time", "note", "priority", "project_id", "title",
    ]);
    expect(queued[0]?.fields.title?.v).toBe("Plan the week");
    expect(queued[0]?.fields.created_at?.v).toBe(task.created_at);
    expect(compareHlc(queued[0]!.fields.title!.hlc, task.field_ts.title!)).toBe(0);
    expect(await database.tasks.get(task.id)).toEqual(task);
  });

  it("stores and validates synchronized user settings", async () => {
    const database = await testDb();
    const settings = await updateSettings({ timezone: "America/Los_Angeles", locale: "en", digest_time: "07:15" }, database);
    const queued = await database.outbox.toArray();

    expect(settings).toMatchObject({ timezone: "America/Los_Angeles", locale: "en", digest_time: "07:15" });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ entity: "settings", id: "settings" });
    await expect(updateSettings({ timezone: "Not/A_Timezone" }, database)).rejects.toThrow(/timezone/i);
  });

  it("cascades project trash locally and restores only its deletion batch", async () => {
    const database = await testDb();
    const root = await createProject("Home", null, database);
    const child = await createProject("Repairs", root.id, database);
    const nestedTask = await createTask("Fix the shelf", child.id, database);
    const unrelatedTask = await createTask("Renew a pass", null, database);
    await deleteTask(unrelatedTask.id, database);
    const outboxBeforeProjectDelete = await database.outbox.count();
    const rootCreate = await database.outbox.where("[entity+id]").equals(["project", root.id]).first();
    expect(Object.keys(rootCreate!.fields).sort()).toEqual(["deleted_at", "deleted_batch_id", "name", "parent_id"]);

    await deleteProject(root.id, database);
    const [deletedRoot, deletedChild, deletedTask, deletedUnrelated] = await Promise.all([
      database.projects.get(root.id),
      database.projects.get(child.id),
      database.tasks.get(nestedTask.id),
      database.tasks.get(unrelatedTask.id),
    ]);
    expect(deletedRoot?.deleted_at).not.toBeNull();
    expect(deletedChild?.deleted_batch_id).toBe(deletedRoot?.deleted_batch_id);
    expect(deletedTask?.deleted_batch_id).toBe(deletedRoot?.deleted_batch_id);
    expect(deletedUnrelated?.deleted_batch_id).not.toBe(deletedRoot?.deleted_batch_id);
    expect(await database.outbox.count()).toBe(outboxBeforeProjectDelete + 1);

    const batchId = deletedRoot!.deleted_batch_id;
    const rootOutbox = (await database.outbox.where("[entity+id]").equals(["project", root.id]).toArray())
      .find((change) => typeof change.fields.deleted_at?.v === "string");
    expect(rootOutbox?.fields.deleted_batch_id?.v).toBe(batchId);
    const restoreClock = (await database.meta.get("last_hlc"))?.value;
    expect(restoreClock).toBeDefined();

    const { restoreProject } = await import("./db");
    await restoreProject(root.id, database);
    expect((await database.projects.get(root.id))?.deleted_at).toBeNull();
    expect((await database.projects.get(child.id))?.deleted_at).toBeNull();
    expect((await database.tasks.get(nestedTask.id))?.deleted_at).toBeNull();
    expect((await database.tasks.get(unrelatedTask.id))?.deleted_at).not.toBeNull();
  });

  it("keeps queued writes ordered before an offline permanent-delete operation", async () => {
    const database = await testDb();
    const task = await createTask("remove me", null, database);
    await deleteTask(task.id, database);
    await purgeTrash("task", task.id, database);

    expect(await database.tasks.get(task.id)).toBeUndefined();
    const queued = await database.outbox.orderBy("created_at").toArray();
    expect(queued).toHaveLength(3);
    expect(queued.map(({ operation }) => operation ?? "change")).toEqual(["change", "change", "purge"]);
    expect(queued[0]!.created_at).toBeLessThan(queued[1]!.created_at);
    expect(queued[1]!.created_at).toBeLessThan(queued[2]!.created_at);
  });

  it("rejects client-side cycles and hierarchies deeper than three levels", async () => {
    const database = await testDb();
    const root = await createProject("Level one", null, database);
    const child = await createProject("Level two", root.id, database);
    const grandchild = await createProject("Level three", child.id, database);

    await expect(createProject("Too deep", grandchild.id, database)).rejects.toThrow(/3 levels/);
    await expect(updateProject(root.id, { parent_id: grandchild.id }, database)).rejects.toThrow(/cycle/);
  });
});

describe("sync loop", () => {
  it("reads every page before advancing the cursor", async () => {
    const database = await testDb();
    await createTask("queued change", null, database);
    const first = serverTask("remote-a", "first page", 2);
    const second = serverTask("remote-b", "second page", 3);
    let call = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("same-origin");
      const body = JSON.parse(String(init?.body)) as { since: number; changes: unknown[]; page?: string };
      expect(body.since).toBe(0);
      if (call === 1) {
        expect(body.changes).toHaveLength(1);
        return jsonResponse({ upto: 9, next_page: "page-2", rows: [{ entity: "task", ...first }], tombstones: [], rejected: [] });
      }
      expect(await getSince(database)).toBe(0);
      expect(body.page).toBe("page-2");
      expect(body.changes).toEqual([]);
      return jsonResponse({ upto: 9, rows: [{ entity: "task", ...second }], tombstones: [], rejected: [] });
    }) as typeof fetch;

    await syncNow(database, fetcher);
    expect(call).toBe(2);
    expect(await getSince(database)).toBe(9);
    expect((await database.tasks.get(first.id))?.title).toBe("first page");
    expect((await database.tasks.get(second.id))?.title).toBe("second page");
    expect(await database.outbox.count()).toBe(0);
  });

  it("replaces a clamped future HLC before applying another device's update", async () => {
    const database = await testDb();
    const task = await createTask("initial", null, database);
    const queued = await database.outbox.where("[entity+id]").equals(["task", task.id]).first();
    const local = (await database.tasks.get(task.id))!;
    const serverNow = Date.now();
    const futureClock = {
      ts: serverNow + HLC_FUTURE_TOLERANCE_MS + 60_000,
      counter: 0,
      device_id: "skewed_device",
    };
    const clampedClock = { ts: serverNow, counter: 0, device_id: "skewed_device" };
    const remoteClock = { ts: serverNow + 1, counter: 0, device_id: "second_device" };
    const futureLocal = {
      ...local,
      title: "future local edit",
      field_ts: { ...local.field_ts, title: futureClock },
    };
    await database.tasks.put(futureLocal);
    await database.outbox.put({
      ...queued!,
      fields: { ...queued!.fields, title: { v: futureLocal.title, hlc: futureClock } },
    });

    let call = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init?.body)) as {
        changes: { fields: { title: { hlc: { ts: number } } } }[];
      };
      if (call === 1) {
        expect(body.changes[0]?.fields.title.hlc.ts).toBe(futureClock.ts);
        return jsonResponse({
          upto: 1,
          rows: [{
            entity: "task",
            ...futureLocal,
            field_ts: { ...futureLocal.field_ts, title: clampedClock },
            seq: 1,
          }],
          tombstones: [],
          rejected: [],
        });
      }
      expect(body.changes).toEqual([]);
      const clamped = await database.tasks.get(task.id);
      return jsonResponse({
        upto: 2,
        rows: [{
          entity: "task",
          ...clamped!,
          title: "second device edit",
          field_ts: { ...clamped!.field_ts, title: remoteClock },
          seq: 2,
        }],
        tombstones: [],
        rejected: [],
      });
    }) as typeof fetch;

    expect(futureClock.ts - serverNow).toBeGreaterThan(HLC_FUTURE_TOLERANCE_MS);
    await syncNow(database, fetcher);
    expect((await database.tasks.get(task.id))?.field_ts.title).toEqual(clampedClock);
    expect(await database.outbox.count()).toBe(0);
    await syncNow(database, fetcher);
    expect((await database.tasks.get(task.id))?.title).toBe("second device edit");
    expect((await database.tasks.get(task.id))?.field_ts.title).toEqual(remoteClock);
  });

  it("runs again when a local edit arrives during an active sync", async () => {
    const database = await testDb();
    await createTask("first", null, database);
    let releaseFirst!: (response: Response) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const delayed = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    const fetcher = (async () => {
      call += 1;
      if (call === 1) {
        firstStarted();
        return delayed;
      }
      return jsonResponse({ upto: 2, rows: [], tombstones: [], rejected: [] });
    }) as typeof fetch;

    const firstSync = syncNow(database, fetcher);
    await started;
    await createTask("second", null, database);
    const joinedSync = syncNow(database, fetcher);
    releaseFirst(jsonResponse({ upto: 1, rows: [], tombstones: [], rejected: [] }));
    await Promise.all([firstSync, joinedSync]);

    expect(call).toBe(2);
    expect(await getSince(database)).toBe(2);
    expect(await database.outbox.count()).toBe(0);
  });

  it("pushes unsent changes before clearing and installing a full server snapshot", async () => {
    const database = await testDb();
    await database.tasks.put(serverTask("stale", "stale local row", 1));
    const local = await createTask("local change", null, database);
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { changes: unknown[] };
      expect(body.changes).toHaveLength(1);
      return jsonResponse({
        upto: 10,
        full_resync: true,
        rows: [
          { entity: "task", ...serverTask("restored", "from server", 10) },
          { entity: "task", ...local, seq: 9 },
        ],
        tombstones: [],
        rejected: [],
      });
    }) as typeof fetch;

    await syncNow(database, fetcher);
    expect(await database.tasks.get("stale")).toBeUndefined();
    expect((await database.tasks.get("restored"))?.title).toBe("from server");
    expect((await database.tasks.get(local.id))?.title).toBe("local change");
    expect(await database.outbox.count()).toBe(0);
    expect(await getSince(database)).toBe(10);
  });

  it("overwrites rejected rows and removes tombstoned IDs", async () => {
    const database = await testDb();
    const localRejected = await createTask("local title", null, database);
    const tombstoned = await createTask("purged locally", null, database);
    const current = { entity: "task" as const, ...serverTask(localRejected.id, "server title", 12) };
    const fetcher = (async () => jsonResponse({
      upto: 15,
      rows: [],
      tombstones: [{ entity: "task", id: tombstoned.id, purged_at: "2026-01-02T00:00:00.000Z", seq: 15 }],
      rejected: [{ change_id: "rejected", id: localRejected.id, entity: "task", reason: "conflict", current }],
    })) as typeof fetch;

    await syncNow(database, fetcher);
    expect((await database.tasks.get(localRejected.id))?.title).toBe("server title");
    expect(await database.tasks.get(tombstoned.id)).toBeUndefined();
    expect(await getSince(database)).toBe(15);
  });

  it("does not apply a rejected current row over a newer row in the same response", async () => {
    const database = await testDb();
    const local = await createTask("local title", null, database);
    const older = { entity: "task" as const, ...serverTask(local.id, "rejected current", 12) };
    const newer = { entity: "task" as const, ...serverTask(local.id, "new accepted value", 13) };
    const fetcher = (async () => jsonResponse({
      upto: 13,
      rows: [newer],
      tombstones: [],
      rejected: [{ change_id: "rejected", id: local.id, entity: "task", reason: "conflict", current: older }],
    })) as typeof fetch;

    await syncNow(database, fetcher);
    expect((await database.tasks.get(local.id))?.title).toBe("new accepted value");
  });

  it("pushes queued changes before an offline trash purge and then pulls its tombstone", async () => {
    const database = await testDb();
    const task = await createTask("delete forever", null, database);
    await deleteTask(task.id, database);
    await purgeTrash("task", task.id, database);
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/sync" && paths.length === 1) {
        const body = JSON.parse(String(init?.body)) as { changes: unknown[] };
        expect(body.changes).toHaveLength(2);
        return jsonResponse({ upto: 5, rows: [], tombstones: [], rejected: [] });
      }
      if (path === "/api/trash/purge") return jsonResponse({ ok: true });
      expect(path).toBe("/api/sync");
      const body = JSON.parse(String(init?.body)) as { since: number; changes: unknown[] };
      expect(body).toEqual({ since: 5, changes: [] });
      return jsonResponse({
        upto: 6,
        rows: [],
        tombstones: [{ entity: "task", id: task.id, purged_at: "2026-01-02T00:00:00.000Z", seq: 6 }],
        rejected: [],
      });
    }) as typeof fetch;

    await syncNow(database, fetcher);
    expect(paths).toEqual(["/api/sync", "/api/trash/purge", "/api/sync"]);
    expect(await database.tasks.get(task.id)).toBeUndefined();
    expect(await database.outbox.count()).toBe(0);
    expect(await getSince(database)).toBe(6);
  });

  it("keeps queued changes for a quiet retry after a network failure", async () => {
    const database = await testDb();
    await createTask("offline edit", null, database);
    let status = "";
    await expect(syncNow(database, (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch, (next) => { status = next; }))
      .rejects.toThrow("Failed to fetch");
    expect(status).toBe("offline");
    expect(await database.outbox.count()).toBe(1);
    expect(await getSince(database)).toBe(0);
  });

  it("detects a login-required response and keeps the cursor unchanged", async () => {
    const database = await testDb();
    await expect(syncNow(database, (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch))
      .rejects.toBeInstanceOf(ReauthenticationRequired);
    expect(await getSince(database)).toBe(0);
  });
});
