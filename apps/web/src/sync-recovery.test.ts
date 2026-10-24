import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import type { SyncRow } from "@task/shared";
import {
  createProject,
  createTag,
  createTask,
  deleteTask,
  getSince,
  initializeDatabase,
  purgeTrash,
  setTaskTag,
  TaskDatabase,
  updateProject,
  updateSettings,
  updateTag,
  updateTask,
} from "./db";
import { ReauthenticationRequired, syncNow } from "./sync";

const opened: TaskDatabase[] = [];
async function testDb() {
  const database = new TaskDatabase(`recovery-${crypto.randomUUID()}`);
  opened.push(database);
  await initializeDatabase(database);
  return database;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of opened.splice(0)) {
    database.close();
    await database.delete();
  }
});

it.each(["project", "tag", "task_tag", "settings"] as const)(
  "preserves newer %s edits and their clocks when an in-flight change is rejected",
  async (entity) => {
    const database = await testDb();
    let current: SyncRow;
    let edit: () => Promise<unknown>;
    let read: () => Promise<unknown>;
    let expected: Record<string, unknown>;
    switch (entity) {
      case "project": {
        const row = await createProject("original project", null, database);
        current = { ...row, entity, seq: 10 };
        edit = () => updateProject(row.id, { name: "new project name" }, database);
        read = () => database.projects.get(row.id);
        expected = { name: "new project name" };
        break;
      }
      case "tag": {
        const row = await createTag("original tag", database);
        current = { ...row, entity, seq: 10 };
        edit = () => updateTag(row.id, { name: "new tag name" }, database);
        read = () => database.tags.get(row.id);
        expected = { name: "new tag name" };
        break;
      }
      case "task_tag": {
        const task = await createTask("tagged task", null, database);
        const tag = await createTag("tag", database);
        const row = await setTaskTag(task.id, tag.id, true, database);
        current = { ...row, entity, seq: 10 };
        edit = () => setTaskTag(task.id, tag.id, false, database);
        read = () => database.taskTags.get(row.id);
        expected = { active: false };
        break;
      }
      case "settings": {
        const row = await updateSettings({ default_priority: 1 }, database);
        current = { ...row, entity, seq: 10 };
        edit = () => updateSettings({ default_priority: 3 }, database);
        read = () => database.settings.get("settings");
        expected = { default_priority: 3 };
        break;
      }
    }
    const id = current.entity === "settings" ? "settings" : current.id;
    const sent = await database.outbox.where("[entity+id]").equals([entity, id]).first();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      await edit();
      return json({
        upto: 10,
        rows: [],
        tombstones: [],
        rejected: [
          {
            entity,
            id,
            change_id: sent!.change_id,
            reason: "no_fields_applied",
            current,
          },
        ],
      });
    });
    await syncNow(database, fetcher);
    const pending = await database.outbox.toArray();
    expect(pending).toHaveLength(1);
    expect(await read()).toMatchObject({ ...expected, seq: 10 });
    const field = Object.keys(expected)[0]!;
    expect(await read()).toMatchObject({ field_ts: { [field]: pending[0]!.fields[field]!.hlc } });
    fetcher.mockImplementationOnce(async (_path, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0]).toMatchObject({
        entity,
        id,
        fields: { [field]: { v: expected[field] } },
      });
      return json({ upto: 11, rows: [], tombstones: [], rejected: [] });
    });
    await syncNow(database, fetcher);
    expect(await database.outbox.count()).toBe(0);
    expect(await read()).toMatchObject(expected);
  },
);

it.each([
  ["forbidden", () => json({ error: "forbidden" }, 403)],
  [
    "HTML login page",
    () => new Response("<html>Login</html>", { headers: { "Content-Type": "text/html" } }),
  ],
  [
    "Access redirect",
    () => {
      const response = new Response();
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    },
  ],
] as const)("preserves queued writes after a %s response", async (_name, response) => {
  const database = await testDb();
  const task = await createTask("unsent", null, database);
  const queued = await database.outbox.toArray();
  const statuses: string[] = [];
  await expect(
    syncNow(database, vi.fn<typeof fetch>().mockResolvedValue(response()), (status) =>
      statuses.push(status),
    ),
  ).rejects.toBeInstanceOf(ReauthenticationRequired);
  expect(statuses).toEqual(["syncing", "reauth"]);
  expect(await database.tasks.get(task.id)).toEqual(task);
  expect(await database.outbox.toArray()).toEqual(queued);
  expect(await getSince(database)).toBe(0);
});

it("retains queued writes and releases the sync lock after malformed JSON", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const database = await testDb();
  await createTask("unsent", null, database);
  const queued = await database.outbox.toArray();
  const statuses: string[] = [];
  await expect(
    syncNow(
      database,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{", { headers: { "Content-Type": "application/json" } })),
      (status) => statuses.push(status),
    ),
  ).rejects.toBeInstanceOf(SyntaxError);
  expect(statuses).toEqual(["syncing", "error"]);
  expect(await database.outbox.toArray()).toEqual(queued);
  expect(await getSince(database)).toBe(0);
  await syncNow(
    database,
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ upto: 1, rows: [], tombstones: [], rejected: [] })),
  );
  expect(await database.outbox.count()).toBe(0);
});

it("keeps a remotely restored task when a queued permanent deletion conflicts", async () => {
  const database = await testDb();
  const task = await createTask("restored elsewhere", null, database);
  await deleteTask(task.id, database);
  await purgeTrash("task", task.id, database);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({
        upto: 10,
        rows: [{ ...task, entity: "task", seq: 10 }],
        tombstones: [],
        rejected: [],
      }),
    )
    .mockResolvedValueOnce(json({ error: "not_in_trash" }, 409));
  await syncNow(database, fetcher);
  expect(await database.tasks.get(task.id)).toMatchObject({ title: task.title, deleted_at: null });
  expect(await database.outbox.count()).toBe(0);
  expect(await getSince(database)).toBe(10);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(json({ upto: 10, rows: [], tombstones: [], rejected: [] }));
  await syncNow(database, fetcher);
  expect(fetcher.mock.calls[2]![0]).toBe("/api/sync");
});

it("keeps writes created during a full resync while removing stale cached rows", async () => {
  const database = await testDb();
  const stale = await createTask("stale cached task", null, database);
  await database.outbox.clear();
  let pendingId = "";
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
    const pending = await createTask("created during snapshot", null, database);
    pendingId = pending.id;
    return json({ upto: 20, full_resync: true, rows: [], tombstones: [], rejected: [] });
  });
  await syncNow(database, fetcher);
  expect(await database.tasks.get(stale.id)).toBeUndefined();
  expect(await database.tasks.get(pendingId)).toMatchObject({ title: "created during snapshot" });
  expect(await database.outbox.toArray()).toEqual([expect.objectContaining({ id: pendingId })]);
  expect(await getSince(database)).toBe(20);
  fetcher.mockImplementationOnce(async (_path, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      since: 20,
      changes: [expect.objectContaining({ id: pendingId })],
    });
    return json({ upto: 21, rows: [], tombstones: [], rejected: [] });
  });
  await syncNow(database, fetcher);
  expect(await database.outbox.count()).toBe(0);
  expect(await database.tasks.get(pendingId)).toBeDefined();
});

it("discards a newer pending edit when the server permanently deleted its task", async () => {
  const database = await testDb();
  const task = await createTask("purged elsewhere", null, database);
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
    await updateTask(task.id, { title: "edit during sync" }, database);
    return json({
      upto: 20,
      rows: [],
      tombstones: [{ entity: "task", id: task.id, seq: 20, purged_at: "2026-10-24T00:00:00.000Z" }],
      rejected: [],
    });
  });
  await syncNow(database, fetcher);
  expect(await database.tasks.get(task.id)).toBeUndefined();
  expect(await database.outbox.count()).toBe(0);
  fetcher.mockImplementationOnce(async (_path, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ since: 20, changes: [] });
    return json({ upto: 20, rows: [], tombstones: [], rejected: [] });
  });
  await syncNow(database, fetcher);
});

it("does not send a queued purge when the deletion was rejected with an active task", async () => {
  const database = await testDb();
  const task = await createTask("restored before purge", null, database);
  await deleteTask(task.id, database);
  const deletion = await database.outbox.orderBy("created_at").last();
  await purgeTrash("task", task.id, database);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
    json({
      upto: 10,
      rows: [],
      tombstones: [],
      rejected: [
        {
          entity: "task",
          id: task.id,
          change_id: deletion!.change_id,
          reason: "no_fields_applied",
          current: { ...task, entity: "task", seq: 10 },
        },
      ],
    }),
  );
  await syncNow(database, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe("/api/sync");
  expect(await database.tasks.get(task.id)).toMatchObject({ deleted_at: null });
  expect(await database.outbox.count()).toBe(0);
});
