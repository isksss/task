import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareHlc, HLC_FUTURE_TOLERANCE_MS, recurringTaskId, type Task } from "@task/shared";
import {
  clearLocalData,
  createProject,
  createTask,
  createTag,
  deleteProject,
  deleteTask,
  initializeDatabase,
  purgeTrash,
  TaskDatabase,
  updateProject,
  updateSettings,
  updateTask,
  updateTag,
  setTaskTag,
} from "./db";
import { getSince } from "./db";
import { ReauthenticationRequired, syncNow, waitForSync } from "./sync";

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
    parent_task_id: null,
    recurrence: null,
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
      "created_at", "deleted_at", "deleted_batch_id", "done", "due_date", "due_time", "note", "parent_task_id", "priority", "project_id", "recurrence", "title",
    ]);
    expect(queued[0]?.fields.title?.v).toBe("Plan the week");
    expect(queued[0]?.fields.created_at?.v).toBe(task.created_at);
    expect(compareHlc(queued[0]!.fields.title!.hlc, task.field_ts.title!)).toBe(0);
    expect(await database.tasks.get(task.id)).toEqual(task);
  });

  it("upgrades version-one task rows with the v2 relationship and recurrence fields", async () => {
    const name = `task-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      tasks: "&id, project_id, deleted_at, deleted_batch_id, done, due_date",
      projects: "&id, parent_id, deleted_at, deleted_batch_id",
      settings: "&id",
      outbox: "&change_id, entity, id, created_at, [entity+id]",
      meta: "&key",
    });
    await legacy.table("tasks").put({ id: "legacy", title: "old" });
    legacy.close();

    const database = new TaskDatabase(name);
    opened.push(database);
    await initializeDatabase(database);
    expect(await database.tasks.get("legacy")).toMatchObject({ parent_task_id: null, recurrence: null });
  });

  it("writes tags as independent LWW relationships", async () => {
    const database = await testDb();
    const task = await createTask("Tagged task", null, database);
    const first = await createTag("home", database);
    const second = await createTag("work", database);
    await Promise.all([
      setTaskTag(task.id, first.id, true, database),
      setTaskTag(task.id, second.id, true, database),
    ]);

    const links = await database.taskTags.toArray();
    expect(links.filter((link) => link.active).map((link) => link.id).sort()).toEqual([
      `${task.id}:${first.id}`,
      `${task.id}:${second.id}`,
    ].sort());
    expect((await database.outbox.where("entity").equals("task_tag").toArray())).toHaveLength(2);
    await setTaskTag(task.id, first.id, false, database);
    expect((await database.taskTags.get(`${task.id}:${first.id}`))?.active).toBe(false);
    expect((await updateTag(first.id, { name: "personal" }, database)).name).toBe("personal");
  });

  it("creates recurrence occurrences locally and cascades parent task trash by batch", async () => {
    const database = await testDb();
    const parent = await createTask("Monthly check", null, database);
    const child = await createTask("Check item", null, database, parent.id);
    await expect(createTask("Too deep", null, database, child.id)).rejects.toThrow(/subtasks/);
    await updateTask(parent.id, {
      due_date: "2025-01-31",
      due_time: "10:15",
      recurrence: { frequency: "monthly", day: 31 },
    }, database);
    const recurrenceOutbox = await database.outbox.where("[entity+id]").equals(["task", parent.id]).toArray();
    expect(recurrenceOutbox.some((change) =>
      change.fields.recurrence?.v && (change.fields.recurrence.v as { frequency?: string }).frequency === "monthly",
    )).toBe(true);
    await updateTask(parent.id, { done: true }, database);

    const nextId = await recurringTaskId(parent.id, "2025-02-28");
    expect(await database.tasks.get(nextId)).toMatchObject({
      due_date: "2025-02-28",
      due_time: "10:15",
      done: false,
      recurrence: { frequency: "monthly", day: 31 },
    });
    expect((await database.outbox.where("[entity+id]").equals(["task", nextId]).count())).toBe(1);
    await updateTask(parent.id, { done: false }, database);
    expect(await database.tasks.get(nextId)).toBeDefined();

    await deleteTask(parent.id, database);
    const deletedParent = await database.tasks.get(parent.id);
    const deletedChild = await database.tasks.get(child.id);
    expect(deletedChild?.deleted_batch_id).toBe(deletedParent?.deleted_batch_id);
    await (await import("./db")).restoreTask(parent.id, database);
    expect((await database.tasks.get(parent.id))?.deleted_at).toBeNull();
    expect((await database.tasks.get(child.id))?.deleted_at).toBeNull();

    await deleteTask(parent.id, database);
    await purgeTrash("task", parent.id, database);
    expect(await database.tasks.get(parent.id)).toBeUndefined();
    expect(await database.tasks.get(child.id)).toBeUndefined();
  });

  it("generates a recurrence only on the false-to-true done transition", async () => {
    const database = await testDb();
    const task = await createTask("Monthly task", null, database);
    await updateTask(task.id, { due_date: "2025-01-31" }, database);
    await updateTask(task.id, { done: true }, database);
    await updateTask(task.id, { recurrence: { frequency: "monthly", day: 31 } }, database);

    const nextId = await recurringTaskId(task.id, "2025-02-28");
    expect(await database.tasks.get(nextId)).toBeUndefined();
    await updateTask(task.id, { done: false }, database);
    await updateTask(task.id, { done: true }, database);
    expect(await database.tasks.get(nextId)).toMatchObject({ done: false, due_date: "2025-02-28" });
  });

  it("does not generate recurrence occurrences from deleted task contexts", async () => {
    const database = await testDb();
    const source = await createTask("Deleted task", null, database);
    await updateTask(source.id, {
      due_date: "2025-01-31",
      recurrence: { frequency: "monthly", day: 31 },
    }, database);
    await deleteTask(source.id, database);
    await updateTask(source.id, { done: true }, database);
    expect(await database.tasks.get(await recurringTaskId(source.id, "2025-02-28"))).toBeUndefined();

    const project = await createProject("Deleted project", null, database);
    const projectTask = await createTask("Project task", project.id, database);
    await updateTask(projectTask.id, {
      due_date: "2025-01-31",
      recurrence: { frequency: "monthly", day: 31 },
    }, database);
    await database.projects.update(project.id, { deleted_at: new Date().toISOString() });
    await expect(updateTask(projectTask.id, { done: true }, database)).rejects.toThrow(/trash/);
    expect(await database.tasks.get(await recurringTaskId(projectTask.id, "2025-02-28"))).toBeUndefined();

    const parent = await createTask("Deleted parent", null, database);
    const child = await createTask("Child task", null, database, parent.id);
    await updateTask(child.id, {
      due_date: "2025-01-31",
      recurrence: { frequency: "monthly", day: 31 },
    }, database);
    await database.tasks.update(parent.id, { deleted_at: new Date().toISOString() });
    await updateTask(child.id, { done: true }, database);
    expect(await database.tasks.get(await recurringTaskId(child.id, "2025-02-28"))).toBeUndefined();
  });

  it("counts deleted children when preventing a task from becoming a subtask", async () => {
    const database = await testDb();
    const parent = await createTask("Parent", null, database);
    const otherParent = await createTask("Other parent", null, database);
    const child = await createTask("Child", null, database, parent.id);
    await deleteTask(child.id, database);

    await expect(updateTask(parent.id, { parent_task_id: otherParent.id }, database)).rejects.toThrow(/subtasks/);
  });

  it("clears IndexedDB, browser storage, and caches before navigating to Access logout", async () => {
    const database = await testDb();
    await createTask("local task", null, database);
    const storage = { clear: vi.fn() };
    const cacheStorage = {
      keys: vi.fn(async () => ["task-shell", "task-assets"]),
      delete: vi.fn(async () => true),
    };
    const navigate = vi.fn();

    await clearLocalData(database, storage, cacheStorage, navigate);

    expect(storage.clear).toHaveBeenCalledOnce();
    expect(cacheStorage.keys).toHaveBeenCalledOnce();
    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/cdn-cgi/access/logout");
    const emptyDatabase = new TaskDatabase(database.name);
    opened.push(emptyDatabase);
    expect(await emptyDatabase.tasks.count()).toBe(0);
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
    const otherProject = await createProject("Other", null, database);
    const nestedTask = await createTask("Fix the shelf", child.id, database);
    const inboxSubtask = await createTask("Inbox subtask", null, database, nestedTask.id);
    const otherProjectSubtask = await createTask("Other-project subtask", otherProject.id, database, nestedTask.id);
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
    expect((await database.tasks.get(inboxSubtask.id))?.deleted_batch_id).toBe(deletedRoot?.deleted_batch_id);
    expect((await database.tasks.get(otherProjectSubtask.id))?.deleted_batch_id).toBe(deletedRoot?.deleted_batch_id);
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
    expect((await database.tasks.get(inboxSubtask.id))?.deleted_at).toBeNull();
    expect((await database.tasks.get(otherProjectSubtask.id))?.deleted_at).toBeNull();
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

  it("waits for the active sync without scheduling another sync", async () => {
    const database = await testDb();
    await createTask("waiting task", null, database);
    let release!: (response: Response) => void;
    let started!: () => void;
    const startedSync = new Promise<void>((resolve) => { started = resolve; });
    const pendingResponse = new Promise<Response>((resolve) => { release = resolve; });
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      started();
      return pendingResponse;
    }) as typeof fetch;

    const activeSync = syncNow(database, fetcher);
    await startedSync;
    let finishedWaiting = false;
    const waiting = waitForSync(database).then(() => { finishedWaiting = true; });
    await Promise.resolve();
    expect(finishedWaiting).toBe(false);
    release(jsonResponse({ upto: 1, rows: [], tombstones: [], rejected: [] }));
    await Promise.all([activeSync, waiting]);

    expect(finishedWaiting).toBe(true);
    expect(calls).toBe(1);
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
