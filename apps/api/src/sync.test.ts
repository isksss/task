import { env as cloudflareEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recurringTaskId, type SyncResponse } from "@task/shared";
import { app, scheduled } from "./index";
import { purgeExpiredData } from "./sync";
import {
  ensureTestSchema,
  makeTestEnv,
  projectChange,
  taskChange,
  versioned,
} from "./test-helpers";

const env = cloudflareEnv as unknown as { DB: D1Database };

beforeEach(async () => {
  await ensureTestSchema();
});

async function postSync(workerEnv: ReturnType<typeof makeTestEnv>, body: unknown) {
  return app.request(
    "/api/sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    workerEnv,
  );
}

async function userId(sub: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE access_sub = ?")
    .bind(sub)
    .first<{ id: string }>();
  if (!row) throw new Error("test user was not created");
  return row.id;
}

const syncBody = (changes: unknown[], since = 0) => ({ since, changes });

function trackBindings(database: D1Database): { database: D1Database; counts: number[] } {
  const counts: number[] = [];
  return {
    counts,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, key) {
                if (key === "bind") {
                  return (...values: Parameters<D1PreparedStatement["bind"]>) => {
                    counts.push(values.length);
                    if (values.length > 100) throw new Error(`SQL has ${values.length} bind variables`);
                    return prepared.bind(...values);
                  };
                }
                const value = Reflect.get(prepared, key, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

describe("POST /api/sync", () => {
  it("applies each change once and keeps the assigned sequence stable on retry", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const change = taskChange({ title: versioned("once") });

    const first = await postSync(workerEnv, syncBody([change]));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as SyncResponse;
    const firstUpto = firstBody.upto;

    const retry = await postSync(workerEnv, syncBody([change]));
    const retryBody = (await retry.json()) as SyncResponse;
    expect(retryBody.upto).toBe(firstUpto);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?")
        .bind(change.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("syncs complete create and update field sets for every entity within D1's bind limit", async () => {
    const tracked = trackBindings(env.DB);
    const workerEnv = { ...makeTestEnv(), DB: tracked.database };
    const timestamp = Date.now() - 1000;
    const later = timestamp + 100;
    const projectId = crypto.randomUUID();
    const tagId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const linkId = `${parentId}:${tagId}`;
    const versionFields = (fields: Record<string, unknown>, ts: number) =>
      Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, versioned(value, ts)]));
    const taskFields = (title: string, parentTaskId: string | null, ts: number) => versionFields({
      project_id: projectId,
      parent_task_id: parentTaskId,
      recurrence: { frequency: "monthly", day: 31 },
      title,
      note: "all task fields",
      done: false,
      due_date: "2026-06-01",
      due_time: "09:30",
      priority: 3,
      created_at: new Date(timestamp).toISOString(),
      deleted_at: null,
      deleted_batch_id: null,
    }, ts);
    const create = await postSync(workerEnv, syncBody([
      projectChange(versionFields({ parent_id: null, name: "Project", deleted_at: null, deleted_batch_id: null }, timestamp), projectId),
      { change_id: crypto.randomUUID(), entity: "tag", id: tagId, fields: versionFields({ name: "Personal", deleted_at: null }, timestamp) },
      taskChange(taskFields("Parent", null, timestamp), parentId),
      taskChange(taskFields("Child", parentId, timestamp), childId),
      { change_id: crypto.randomUUID(), entity: "task_tag", id: linkId, fields: versionFields({ active: true }, timestamp) },
      { change_id: crypto.randomUUID(), entity: "settings", id: "settings", fields: versionFields({ timezone: "Europe/Paris", locale: "en", digest_time: "07:15" }, timestamp) },
    ]));
    expect(create.status).toBe(200);
    expect(((await create.json()) as SyncResponse).rejected).toEqual([]);

    const update = await postSync(workerEnv, syncBody([
      projectChange(versionFields({ parent_id: null, name: "Updated project", deleted_at: null, deleted_batch_id: null }, later), projectId),
      { change_id: crypto.randomUUID(), entity: "tag", id: tagId, fields: versionFields({ name: "Updated tag", deleted_at: null }, later) },
      taskChange(taskFields("Updated parent", null, later), parentId),
      taskChange(taskFields("Updated child", parentId, later), childId),
      { change_id: crypto.randomUUID(), entity: "task_tag", id: linkId, fields: versionFields({ active: false }, later) },
      { change_id: crypto.randomUUID(), entity: "settings", id: "settings", fields: versionFields({ timezone: "America/New_York", locale: "ja", digest_time: "08:30" }, later) },
    ]));
    expect(update.status).toBe(200);
    expect(((await update.json()) as SyncResponse).rejected).toEqual([]);
    expect(Math.max(...tracked.counts)).toBeLessThanOrEqual(100);
  });

  it("returns current values when existing-row fields lose an LWW conflict", async () => {
    const workerEnv = makeTestEnv();
    const id = crypto.randomUUID();
    const initialTs = Date.now() - 60_000;
    const winnerTs = initialTs + 20_000;
    await postSync(workerEnv, syncBody([
      taskChange({
        title: versioned("initial title", initialTs),
        note: versioned("initial note", initialTs),
      }, id),
    ]));
    await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("winner", winnerTs) }, id),
    ]));

    const partial = taskChange({
      title: versioned("stale title", initialTs + 10_000),
      note: versioned("accepted note", initialTs + 30_000),
    }, id);
    const partialResponse = await postSync(workerEnv, syncBody([partial]));
    const partialBody = (await partialResponse.json()) as SyncResponse;
    expect(partialBody.rejected).toHaveLength(1);
    expect(partialBody.rejected[0]).toMatchObject({
      change_id: partial.change_id,
      reason: "field_conflict",
      current: { entity: "task", id, title: "winner", note: "accepted note" },
    });

    const losing = taskChange({ title: versioned("older title", initialTs + 15_000) }, id);
    const losingResponse = await postSync(workerEnv, syncBody([losing]));
    const losingBody = (await losingResponse.json()) as SyncResponse;
    expect(losingBody.rejected).toHaveLength(1);
    expect(losingBody.rejected[0]).toMatchObject({
      change_id: losing.change_id,
      reason: "no_fields_applied",
      current: { entity: "task", id, title: "winner" },
    });
  });

  it("rejects HLC device IDs containing non-ASCII characters", async () => {
    const workerEnv = makeTestEnv();
    const change = taskChange({ title: versioned("invalid device") });
    change.fields.title.hlc.device_id = "端末";

    const response = await postSync(workerEnv, syncBody([change]));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("preserves independent fields and rejects a task assigned to another user's project", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const id = crypto.randomUUID();
    const create = taskChange({ title: versioned("initial"), done: versioned(false) }, id);
    await postSync(workerEnv, syncBody([create]));

    const fields = {
      title: versioned("edited title", Date.now() + 10),
      done: versioned(true, Date.now() + 10),
    };
    await postSync(workerEnv, syncBody([taskChange(fields, id)]));
    const task = await env.DB.prepare("SELECT title, done FROM tasks WHERE id = ?")
      .bind(id)
      .first<{ title: string; done: number }>();
    expect(task).toEqual({ title: "edited title", done: 1 });

    const foreignUserId = crypto.randomUUID();
    const foreignProjectId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, access_sub, email, seq_counter, settings_seq)
       VALUES (?, ?, ?, 1, 1)`,
    )
      .bind(foreignUserId, crypto.randomUUID(), "other@example.com")
      .run();
    await env.DB.prepare("INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)")
      .bind(foreignProjectId, foreignUserId, "private")
      .run();

    const response = await postSync(
      workerEnv,
      syncBody([taskChange({ project_id: versioned(foreignProjectId) })]),
    );
    const body = (await response.json()) as SyncResponse;
    expect(body.rejected[0]?.reason).toBe("project_not_found");
  });

  it("validates one-level subtasks and deletes/restores children in the parent's batch", async () => {
    const workerEnv = makeTestEnv();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const nestedId = crypto.randomUUID();
    const created = await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("parent") }, parentId),
      taskChange({ title: versioned("child"), parent_task_id: versioned(parentId) }, childId),
    ]));
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const foreignUserId = crypto.randomUUID();
    const foreignParentId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id, access_sub, email) VALUES (?, ?, ?)")
      .bind(foreignUserId, crypto.randomUUID(), "parent@example.test").run();
    await env.DB.prepare("INSERT INTO tasks (id, user_id, title) VALUES (?, ?, ?)")
      .bind(foreignParentId, foreignUserId, "private parent").run();

    const nested = taskChange({ title: versioned("nested"), parent_task_id: versioned(childId) }, nestedId);
    const rejected = await postSync(workerEnv, syncBody([nested]));
    expect(((await rejected.json()) as SyncResponse).rejected[0]?.reason).toBe("subtask_cannot_be_parent");
    const foreign = taskChange({ parent_task_id: versioned(foreignParentId, Date.now() + 5) }, childId);
    expect(((await (await postSync(workerEnv, syncBody([foreign]))).json()) as SyncResponse).rejected[0]?.reason)
      .toBe("parent_task_not_found");
    const self = taskChange({ parent_task_id: versioned(childId, Date.now() + 10) }, childId);
    expect(((await (await postSync(workerEnv, syncBody([self]))).json()) as SyncResponse).rejected[0]?.reason).toBe("task_cycle");

    const batchId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([taskChange({
      deleted_at: versioned(new Date().toISOString(), Date.now() + 20),
      deleted_batch_id: versioned(batchId, Date.now() + 20),
    }, parentId)]));
    let child = await env.DB.prepare("SELECT deleted_at, deleted_batch_id FROM tasks WHERE user_id = ? AND id = ?")
      .bind(owner, childId).first<{ deleted_at: string | null; deleted_batch_id: string | null }>();
    expect(child?.deleted_at).not.toBeNull();
    expect(child?.deleted_batch_id).toBe(batchId);

    await postSync(workerEnv, syncBody([taskChange({
      deleted_at: versioned(null, Date.now() + 40),
      deleted_batch_id: versioned(null, Date.now() + 40),
    }, parentId)]));
    child = await env.DB.prepare("SELECT deleted_at, deleted_batch_id FROM tasks WHERE user_id = ? AND id = ?")
      .bind(owner, childId).first<{ deleted_at: string | null; deleted_batch_id: string | null }>();
    expect(child).toEqual({ deleted_at: null, deleted_batch_id: null });
  });

  it("cascades task deletion and restoration even when the graph snapshot misses children", async () => {
    const workerEnv = makeTestEnv();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("parent") }, parentId),
      taskChange({ title: versioned("child"), parent_task_id: versioned(parentId) }, childId),
    ]));

    const graphQuery = "SELECT id, project_id, parent_task_id, deleted_at, deleted_batch_id, field_ts, seq FROM tasks WHERE user_id = ?";
    let graphReads = 0;
    const graphlessDb = new Proxy(workerEnv.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql.trim() !== graphQuery) return statement;
            graphReads++;
            return new Proxy(statement, {
              get(prepared, key) {
                if (key === "all") return async () => ({ results: [] });
                const value = Reflect.get(prepared, key, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const graphlessEnv = { ...workerEnv, DB: graphlessDb };
    const batchId = crypto.randomUUID();
    await postSync(graphlessEnv, syncBody([taskChange({
      deleted_at: versioned(new Date().toISOString(), Date.now() + 10),
      deleted_batch_id: versioned(batchId, Date.now() + 10),
    }, parentId)]));
    expect(await env.DB.prepare("SELECT deleted_batch_id FROM tasks WHERE id = ?")
      .bind(childId).first<{ deleted_batch_id: string | null }>()).toEqual({ deleted_batch_id: batchId });

    await postSync(graphlessEnv, syncBody([taskChange({
      deleted_at: versioned(null, Date.now() + 20),
      deleted_batch_id: versioned(null, Date.now() + 20),
    }, parentId)]));
    expect(await env.DB.prepare("SELECT deleted_at, deleted_batch_id FROM tasks WHERE id = ?")
      .bind(childId).first<{ deleted_at: string | null; deleted_batch_id: string | null }>())
      .toEqual({ deleted_at: null, deleted_batch_id: null });
    expect(graphReads).toBe(2);
  });

  it("preserves the one-level subtask constraint across concurrent sync requests", async () => {
    const workerEnv = makeTestEnv();
    const movableId = crypto.randomUUID();
    const otherParentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const setup = await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("movable") }, movableId),
      taskChange({ title: versioned("other parent") }, otherParentId),
      taskChange({ title: versioned("child") }, childId),
    ]));
    expect(((await setup.json()) as SyncResponse).rejected).toEqual([]);

    const timestamp = Date.now() + 100;
    const moveParent = postSync(workerEnv, syncBody([
      taskChange({ parent_task_id: versioned(otherParentId, timestamp) }, movableId),
    ]));
    const addChild = postSync(workerEnv, syncBody([
      taskChange({ parent_task_id: versioned(movableId, timestamp + 1) }, childId),
    ]));
    const responses = await Promise.all([moveParent, addChild]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<SyncResponse>));
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const invalidHierarchy = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM tasks parent
       WHERE parent.user_id = ? AND parent.parent_task_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM tasks child WHERE child.user_id = parent.user_id AND child.parent_task_id = parent.id)`,
    ).bind(owner).first<{ count: number }>();
    expect(invalidHierarchy?.count).toBe(0);
    const rejected = bodies.flatMap(({ rejected: changes }) => changes);
    expect(rejected).toHaveLength(1);
    expect(["subtask_cannot_be_parent", "task_with_subtasks_cannot_be_subtask"])
      .toContain(rejected[0]?.reason);
    expect(rejected[0]?.current.entity).toBe("task");
    if (rejected[0]?.current.entity === "task") {
      const current = await env.DB.prepare("SELECT parent_task_id FROM tasks WHERE user_id = ? AND id = ?")
        .bind(owner, rejected[0].id).first<{ parent_task_id: string | null }>();
      expect(rejected[0].current.parent_task_id).toBe(current?.parent_task_id);
      const rejectedParent = rejected[0].id === movableId ? otherParentId : movableId;
      await expect(env.DB.prepare("UPDATE tasks SET parent_task_id = ? WHERE user_id = ? AND id = ?")
        .bind(rejectedParent, owner, rejected[0].id).run()).rejects.toThrow(rejected[0].reason);
    }
  });

  it("counts deleted subtasks when preventing a task from becoming a subtask", async () => {
    const workerEnv = makeTestEnv();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const newParentId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("parent") }, parentId),
      taskChange({ title: versioned("child"), parent_task_id: versioned(parentId) }, childId),
      taskChange({ title: versioned("new parent") }, newParentId),
    ]));
    await postSync(workerEnv, syncBody([taskChange({
      deleted_at: versioned(new Date().toISOString()),
      deleted_batch_id: versioned(crypto.randomUUID()),
    }, childId)]));

    const response = await postSync(workerEnv, syncBody([taskChange({
      parent_task_id: versioned(newParentId, Date.now() + 100),
    }, parentId)]));
    const body = (await response.json()) as SyncResponse;
    expect(body.rejected[0]).toMatchObject({
      reason: "task_with_subtasks_cannot_be_subtask",
      current: { entity: "task", id: parentId, parent_task_id: null },
    });
  });

  it("keeps concurrent tag edges and deactivates them when a tag is purged", async () => {
    const workerEnv = makeTestEnv();
    const taskId = crypto.randomUUID();
    const firstTagId = crypto.randomUUID();
    const secondTagId = crypto.randomUUID();
    const firstLinkId = `${taskId}:${firstTagId}`;
    const secondLinkId = `${taskId}:${secondTagId}`;
    await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("tagged") }, taskId),
      { change_id: crypto.randomUUID(), entity: "tag", id: firstTagId, fields: { name: versioned("first") } },
      { change_id: crypto.randomUUID(), entity: "tag", id: secondTagId, fields: { name: versioned("second") } },
      { change_id: crypto.randomUUID(), entity: "task_tag", id: firstLinkId, fields: { active: versioned(true) } },
      { change_id: crypto.randomUUID(), entity: "task_tag", id: secondLinkId, fields: { active: versioned(true) } },
    ]));
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const links = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_tags WHERE user_id = ? AND task_id = ? AND active = 1")
      .bind(owner, taskId).first<{ count: number }>();
    expect(links?.count).toBe(2);
    await postSync(workerEnv, syncBody([{
      change_id: crypto.randomUUID(),
      entity: "tag",
      id: firstTagId,
      fields: { deleted_at: versioned(new Date().toISOString(), Date.now() + 100) },
    }]));

    const response = await app.request("/api/trash/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ change_id: crypto.randomUUID(), entity: "tag", id: firstTagId }),
    }, workerEnv);
    expect(response.status).toBe(200);
    const [tag, link, tombstone] = await Promise.all([
      env.DB.prepare("SELECT id FROM tags WHERE user_id = ? AND id = ?").bind(owner, firstTagId).first(),
      env.DB.prepare("SELECT active FROM task_tags WHERE user_id = ? AND id = ?").bind(owner, firstLinkId).first<{ active: number }>(),
      env.DB.prepare("SELECT entity FROM tombstones WHERE user_id = ? AND id = ?").bind(owner, firstTagId).first<{ entity: string }>(),
    ]);
    expect(tag).toBeNull();
    expect(link?.active).toBe(0);
    expect(tombstone?.entity).toBe("tag");
  });

  it("uses the completion HLC for the next task so later offline edits win", async () => {
    const workerEnv = makeTestEnv();
    const id = crypto.randomUUID();
    await postSync(workerEnv, syncBody([taskChange({
      title: versioned("monthly task"),
      due_date: versioned("2025-01-31"),
      recurrence: versioned({ frequency: "monthly", day: 31 }),
    }, id)]));
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const nextId = await recurringTaskId(id, "2025-02-28");
    const completionHlc = { ts: Date.now() - 100, counter: 2, device_id: "offline-device" };
    const completion = taskChange({ done: { v: true, hlc: completionHlc } }, id);
    const laterEdit = taskChange({ title: { v: "edited before sync completed", hlc: { ...completionHlc, counter: 3 } } }, nextId);

    const response = await postSync(workerEnv, syncBody([completion, laterEdit]));
    const body = (await response.json()) as SyncResponse;
    expect(response.status).toBe(200);
    expect(body.rejected).toEqual([]);
    const next = await env.DB.prepare("SELECT title, field_ts FROM tasks WHERE user_id = ? AND id = ?")
      .bind(owner, nextId).first<{ title: string; field_ts: string }>();
    expect(next?.title).toBe("edited before sync completed");
    const fieldTs = JSON.parse(next!.field_ts) as Record<string, unknown>;
    expect(fieldTs.done).toEqual(completionHlc);
    expect(fieldTs.title).toEqual({ ...completionHlc, counter: 3 });
  });

  it("generates one deterministic next task when a recurring task is completed", async () => {
    const workerEnv = makeTestEnv();
    const id = crypto.randomUUID();
    const created = await postSync(workerEnv, syncBody([taskChange({
      title: versioned("monthly task"),
      due_date: versioned("2025-01-31"),
      due_time: versioned("09:30"),
      recurrence: versioned({ frequency: "monthly", day: 31 }),
    }, id)]));
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    let completionTs = Date.now() + 100;
    const firstCompletion = taskChange({ done: versioned(true, ++completionTs) }, id);
    const secondCompletion = taskChange({ done: versioned(true, ++completionTs) }, id);
    secondCompletion.fields.done.hlc.device_id = "second-device";
    await postSync(workerEnv, syncBody([firstCompletion]));
    await postSync(workerEnv, syncBody([secondCompletion]));

    const nextId = await recurringTaskId(id, "2025-02-28");
    const next = await env.DB.prepare(
      "SELECT due_date, due_time, done, recurrence FROM tasks WHERE user_id = ? AND id = ?",
    ).bind(owner, nextId).first<{ due_date: string; due_time: string; done: number; recurrence: string }>();
    expect(next).toMatchObject({ due_date: "2025-02-28", due_time: "09:30", done: 0 });
    expect(JSON.parse(next!.recurrence)).toEqual({ frequency: "monthly", day: 31 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND due_date = ? AND title = ?")
      .bind(owner, "2025-02-28", "monthly task").first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("keeps two concurrent tag additions when completing a recurring task", async () => {
    const workerEnv = makeTestEnv();
    const taskId = crypto.randomUUID();
    const firstTagId = crypto.randomUUID();
    const secondTagId = crypto.randomUUID();
    const dueDate = "2025-01-31";
    const created = await postSync(workerEnv, syncBody([
      taskChange({
        title: versioned("monthly tagged task"),
        due_date: versioned(dueDate),
        recurrence: versioned({ frequency: "monthly", day: 31 }),
      }, taskId),
      { change_id: crypto.randomUUID(), entity: "tag", id: firstTagId, fields: { name: versioned("first") } },
      { change_id: crypto.randomUUID(), entity: "tag", id: secondTagId, fields: { name: versioned("second") } },
    ]));
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);

    const timestamp = Date.now() + 100;
    const [first, second, completion] = await Promise.all([
      postSync(workerEnv, syncBody([{
        change_id: crypto.randomUUID(), entity: "task_tag", id: `${taskId}:${firstTagId}`,
        fields: { active: versioned(true, timestamp) },
      }])),
      postSync(workerEnv, syncBody([{
        change_id: crypto.randomUUID(), entity: "task_tag", id: `${taskId}:${secondTagId}`,
        fields: { active: versioned(true, timestamp) },
      }])),
      postSync(workerEnv, syncBody([taskChange({ done: versioned(true, timestamp) }, taskId)])),
    ]);
    for (const response of [first, second, completion]) {
      expect(response.status).toBe(200);
      expect(((await response.json()) as SyncResponse).rejected).toEqual([]);
    }

    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const nextId = await recurringTaskId(taskId, "2025-02-28");
    const [next, occurrences, links] = await Promise.all([
      env.DB.prepare("SELECT id FROM tasks WHERE user_id = ? AND id = ?").bind(owner, nextId).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND due_date = ? AND title = ?")
        .bind(owner, "2025-02-28", "monthly tagged task").first<{ count: number }>(),
      env.DB.prepare("SELECT tag_id, active FROM task_tags WHERE user_id = ? AND task_id = ? ORDER BY tag_id")
        .bind(owner, taskId).all<{ tag_id: string; active: number }>(),
    ]);
    expect(next).not.toBeNull();
    expect(occurrences).toEqual({ count: 1 });
    expect(links.results).toHaveLength(2);
    expect(links.results).toEqual(expect.arrayContaining([
      { tag_id: firstTagId, active: 1 },
      { tag_id: secondTagId, active: 1 },
    ]));
  });

  it("does not create a next occurrence for a tombstoned deterministic task ID", async () => {
    const workerEnv = makeTestEnv();
    const id = crypto.randomUUID();
    await postSync(workerEnv, syncBody([taskChange({
      title: versioned("monthly task"),
      due_date: versioned("2025-01-31"),
      recurrence: versioned({ frequency: "monthly", day: 31 }),
    }, id)]));
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    const nextId = await recurringTaskId(id, "2025-02-28");
    await env.DB.prepare(
      `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
       SELECT ?, 'task', ?, ?, seq_counter FROM users WHERE id = ?`,
    ).bind(owner, nextId, new Date().toISOString(), owner).run();

    await postSync(workerEnv, syncBody([taskChange({ done: versioned(true, Date.now() + 10) }, id)]));

    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(nextId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM tombstones WHERE user_id = ? AND entity = 'task' AND id = ?")
      .bind(owner, nextId).first()).not.toBeNull();
  });

  it("generates a recurrence only on the false-to-true done transition", async () => {
    const workerEnv = makeTestEnv();
    const id = crypto.randomUUID();
    await postSync(workerEnv, syncBody([taskChange({
      title: versioned("monthly task"),
      due_date: versioned("2025-01-31"),
    }, id)]));
    await postSync(workerEnv, syncBody([taskChange({ done: versioned(true, Date.now() + 10) }, id)]));
    await postSync(workerEnv, syncBody([taskChange({
      recurrence: versioned({ frequency: "monthly", day: 31 }, Date.now() + 20),
    }, id)]));

    const nextId = await recurringTaskId(id, "2025-02-28");
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(nextId).first()).toBeNull();
  });

  it("does not create recurrence occurrences when the task, its project, or its parent is deleted", async () => {
    const workerEnv = makeTestEnv();
    const dueDate = "2025-01-31";
    const recurrence = { frequency: "monthly" as const, day: 31 };
    const sourceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const projectTaskId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const deletedAt = new Date().toISOString();
    const batchId = crypto.randomUUID();

    await postSync(workerEnv, syncBody([taskChange({
      title: versioned("deleted source"), due_date: versioned(dueDate), recurrence: versioned(recurrence),
    }, sourceId)]));
    const owner = await userId(workerEnv.DEV_USER_SUB!);
    await postSync(workerEnv, syncBody([taskChange({
      deleted_at: versioned(deletedAt), deleted_batch_id: versioned(batchId),
    }, sourceId)]));

    await postSync(workerEnv, syncBody([
      projectChange({ name: versioned("deleted project") }, projectId),
      taskChange({
        title: versioned("project task"), project_id: versioned(projectId), due_date: versioned(dueDate), recurrence: versioned(recurrence),
      }, projectTaskId),
    ]));
    await env.DB.prepare("UPDATE projects SET deleted_at = ?, deleted_batch_id = ? WHERE user_id = ? AND id = ?")
      .bind(deletedAt, batchId, owner, projectId).run();

    await postSync(workerEnv, syncBody([
      taskChange({ title: versioned("deleted parent") }, parentId),
      taskChange({
        title: versioned("child task"), parent_task_id: versioned(parentId), due_date: versioned(dueDate), recurrence: versioned(recurrence),
      }, childId),
    ]));
    await env.DB.prepare("UPDATE tasks SET deleted_at = ?, deleted_batch_id = ? WHERE user_id = ? AND id = ?")
      .bind(deletedAt, batchId, owner, parentId).run();

    for (const id of [sourceId, projectTaskId, childId]) {
      await postSync(workerEnv, syncBody([taskChange({ done: versioned(true, Date.now() + 100) }, id)]));
      const nextId = await recurringTaskId(id, "2025-02-28");
      expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(nextId).first()).toBeNull();
    }
  });

  it("rejects project cycles and hierarchies deeper than three levels", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const root = crypto.randomUUID();
    const child = crypto.randomUUID();
    const grandchild = crypto.randomUUID();
    const rootChange = projectChange({ name: versioned("root") }, root);
    const childChange = projectChange({ name: versioned("child"), parent_id: versioned(root) }, child);
    const grandchildChange = projectChange(
      { name: versioned("grandchild"), parent_id: versioned(child) },
      grandchild,
    );
    const created = await postSync(workerEnv, syncBody([rootChange, childChange, grandchildChange]));
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);

    const cycle = projectChange({ parent_id: versioned(grandchild, Date.now() + 20) }, root);
    const tooDeep = projectChange({ name: versioned("fourth"), parent_id: versioned(grandchild) });
    const missingParent = projectChange({ parent_id: versioned(crypto.randomUUID()) });
    const rejected = await postSync(workerEnv, syncBody([cycle, tooDeep, missingParent]));
    const body = (await rejected.json()) as SyncResponse;
    expect(body.rejected.map(({ reason }) => reason)).toEqual([
      "project_cycle",
      "project_depth_exceeded",
      "parent_not_found",
    ]);
    expect(body.rejected[0]?.current.entity).toBe("project");
    if (body.rejected[0]?.current.entity === "project") {
      expect(body.rejected[0].current.parent_id).toBeNull();
    }
    const owner = await userId(sub);
    await expect(
      env.DB.prepare("UPDATE projects SET parent_id = ? WHERE user_id = ? AND id = ?")
        .bind(grandchild, owner, root)
        .run(),
    ).rejects.toThrow("project_cycle");
    const triggerOnlyProject = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, user_id) VALUES (?, ?)")
      .bind(triggerOnlyProject, owner)
      .run();
    await expect(
      env.DB.prepare("UPDATE projects SET parent_id = ? WHERE user_id = ? AND id = ?")
        .bind(grandchild, owner, triggerOnlyProject)
        .run(),
    ).rejects.toThrow("project_depth_exceeded");
  });

  it("immediately purges a project deletion batch and records sync tombstones", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const created = await postSync(
      workerEnv,
      syncBody([
        projectChange({ name: versioned("root") }, rootId),
        projectChange({ name: versioned("child"), parent_id: versioned(rootId) }, childId),
        taskChange({ title: versioned("nested task"), project_id: versioned(childId) }, taskId),
      ]),
    );
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);
    const deletedAt = new Date().toISOString();
    const batchId = crypto.randomUUID();
    await postSync(
      workerEnv,
      syncBody([projectChange({ deleted_at: versioned(deletedAt), deleted_batch_id: versioned(batchId) }, rootId)]),
    );

    const request = {
      change_id: crypto.randomUUID(),
      entity: "project",
      id: rootId,
      batch_id: batchId,
    };
    const purge = () => app.request(
      "/api/trash/purge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
      workerEnv,
    );
    const response = await purge();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT id FROM projects WHERE id IN (?, ?)").bind(rootId, childId).all()).toMatchObject({ results: [] });
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT entity, id FROM tombstones WHERE id IN (?, ?, ?) ORDER BY entity, id").bind(rootId, childId, taskId).all()).toMatchObject({ results: expect.arrayContaining([
      { entity: "project", id: rootId },
      { entity: "project", id: childId },
      { entity: "task", id: taskId },
    ]) });
    const retry = await purge();
    expect(retry.status).toBe(200);
  });

  it("resumes a project batch purge after its root row is already gone", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([
      projectChange({ name: versioned("root") }, rootId),
      projectChange({ name: versioned("child"), parent_id: versioned(rootId) }, childId),
      taskChange({ title: versioned("task"), project_id: versioned(childId) }, taskId),
    ]));
    const batchId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([
      projectChange({
        deleted_at: versioned(new Date().toISOString()),
        deleted_batch_id: versioned(batchId),
      }, rootId),
    ]));
    const owner = await userId(sub);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
         SELECT ?, 'project', ?, ?, seq_counter FROM users WHERE id = ?`,
      ).bind(owner, rootId, new Date().toISOString(), owner),
      env.DB.prepare("DELETE FROM projects WHERE user_id = ? AND id = ?").bind(owner, rootId),
    ]);

    const response = await app.request(
      "/api/trash/purge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ change_id: crypto.randomUUID(), entity: "project", id: rootId, batch_id: batchId }),
      },
      workerEnv,
    );
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(childId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId).first()).toBeNull();
  });

  it("refuses to resurrect a tombstoned task", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const change = taskChange({ title: versioned("before purge") });
    const created = await postSync(workerEnv, syncBody([change]));
    const upto = ((await created.json()) as SyncResponse).upto;
    const owner = await userId(sub);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?").bind(owner),
      env.DB.prepare(
        `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
         SELECT ?, 'task', ?, ?, seq_counter FROM users WHERE id = ?`,
      ).bind(owner, change.id, new Date().toISOString(), owner),
      env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").bind(owner, change.id),
    ]);

    const attempted = await postSync(
      workerEnv,
      syncBody([taskChange({ title: versioned("resurrected", Date.now() + 10) }, change.id)], upto),
    );
    const body = (await attempted.json()) as SyncResponse;
    expect(body.tombstones).toEqual([
      expect.objectContaining({ entity: "task", id: change.id }),
    ]);
    expect(
      await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(change.id).first(),
    ).toBeNull();
  });

  it("paginates against a fixed upto while later edits are delivered by the next sync", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const changes = Array.from({ length: 100 }, (_, index) =>
      taskChange({ title: versioned(`task-${index}`, Date.now() + index) }),
    );
    const first = await postSync(workerEnv, syncBody(changes));
    const firstBody = (await first.json()) as SyncResponse;
    expect(firstBody.rows).toHaveLength(100);
    expect(firstBody.next_page).toBeDefined();

    const editedId = changes[0]!.id;
    await postSync(
      workerEnv,
      syncBody([taskChange({ title: versioned("updated-after-upto", Date.now() + 1000) }, editedId)]),
    );
    const second = await postSync(workerEnv, {
      since: 0,
      upto: firstBody.upto,
      page: firstBody.next_page,
      changes: [],
    });
    const secondBody = (await second.json()) as SyncResponse;
    expect(secondBody.upto).toBe(firstBody.upto);
    expect(secondBody.rows.some((row) => row.entity === "task" && row.title === "updated-after-upto")).toBe(false);

    const nextSync = await postSync(workerEnv, syncBody([], firstBody.upto));
    const nextBody = (await nextSync.json()) as SyncResponse;
    expect(nextBody.rows).toContainEqual(
      expect.objectContaining({ entity: "task", id: editedId, title: "updated-after-upto" }),
    );
  });

  it("deletes and restores only the matching project subtree and batch", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const unrelatedTaskId = crypto.randomUUID();
    const unrelatedProjectId = crypto.randomUUID();
    const sameBatchTaskId = crypto.randomUUID();
    const unrelatedBatchId = crypto.randomUUID();
    const sameBatchDeletedAt = new Date().toISOString();
    const batchId = crypto.randomUUID();
    const created = await postSync(
      workerEnv,
      syncBody([
        projectChange({ name: versioned("root") }, rootId),
        projectChange({ name: versioned("child"), parent_id: versioned(rootId) }, childId),
        taskChange({ title: versioned("task"), project_id: versioned(childId) }, taskId),
        projectChange(
          {
            name: versioned("unrelated project"),
            deleted_at: versioned(sameBatchDeletedAt),
            deleted_batch_id: versioned(batchId),
          },
          unrelatedProjectId,
        ),
        taskChange(
          {
            title: versioned("independently deleted task"),
            project_id: versioned(null),
            deleted_at: versioned(new Date().toISOString()),
            deleted_batch_id: versioned(unrelatedBatchId),
          },
          unrelatedTaskId,
        ),
        taskChange(
          {
            title: versioned("unrelated task with reused batch"),
            project_id: versioned(unrelatedProjectId),
            deleted_at: versioned(sameBatchDeletedAt),
            deleted_batch_id: versioned(batchId),
          },
          sameBatchTaskId,
        ),
      ]),
    );
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);
    const unrelatedDeletedAt = await env.DB.prepare("SELECT deleted_at FROM tasks WHERE id = ?")
      .bind(unrelatedTaskId)
      .first<{ deleted_at: string }>();
    const reusedBatchDeletedAt = await env.DB.prepare("SELECT deleted_at FROM tasks WHERE id = ?")
      .bind(sameBatchTaskId)
      .first<{ deleted_at: string }>();

    const deletedAt = new Date().toISOString();
    const deletion = await postSync(
      workerEnv,
      syncBody([
        projectChange(
          {
            deleted_at: versioned(deletedAt, Date.now() + 100),
            deleted_batch_id: versioned(batchId, Date.now() + 100),
          },
          rootId,
        ),
      ]),
    );
    expect(((await deletion.json()) as SyncResponse).rejected).toEqual([]);
    const deleted = await env.DB.prepare(
      `SELECT (SELECT deleted_batch_id FROM projects WHERE id = ?) AS child_batch,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS task_batch,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS unrelated_batch,
              (SELECT deleted_at FROM projects WHERE id = ?) AS unrelated_project_deleted,
              (SELECT deleted_batch_id FROM projects WHERE id = ?) AS unrelated_project_batch,
              (SELECT deleted_at FROM tasks WHERE id = ?) AS reused_batch_task_deleted,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS reused_batch_task_batch`,
    )
      .bind(childId, taskId, unrelatedTaskId, unrelatedProjectId, unrelatedProjectId, sameBatchTaskId, sameBatchTaskId)
      .first<Record<string, string | null>>();
    expect(deleted).toMatchObject({
      child_batch: batchId,
      task_batch: batchId,
      unrelated_batch: unrelatedBatchId,
      unrelated_project_batch: batchId,
      reused_batch_task_batch: batchId,
    });
    expect(deleted?.unrelated_project_deleted).not.toBeNull();
    expect(deleted?.reused_batch_task_deleted).not.toBeNull();

    const restored = await postSync(
      workerEnv,
      syncBody([projectChange({ deleted_at: versioned(null, Date.now() + 200) }, rootId)]),
    );
    expect(((await restored.json()) as SyncResponse).rejected).toEqual([]);
    const active = await env.DB.prepare(
      `SELECT (SELECT deleted_at FROM projects WHERE id = ?) AS child_deleted,
              (SELECT deleted_batch_id FROM projects WHERE id = ?) AS child_batch,
              (SELECT deleted_at FROM tasks WHERE id = ?) AS task_deleted,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS task_batch,
              (SELECT deleted_at FROM tasks WHERE id = ?) AS unrelated_deleted,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS unrelated_batch,
              (SELECT deleted_at FROM projects WHERE id = ?) AS unrelated_project_deleted,
              (SELECT deleted_batch_id FROM projects WHERE id = ?) AS unrelated_project_batch,
              (SELECT deleted_at FROM tasks WHERE id = ?) AS reused_batch_task_deleted,
              (SELECT deleted_batch_id FROM tasks WHERE id = ?) AS reused_batch_task_batch`,
    )
      .bind(
        childId, childId, taskId, taskId, unrelatedTaskId, unrelatedTaskId,
        unrelatedProjectId, unrelatedProjectId, sameBatchTaskId, sameBatchTaskId,
      )
      .first<Record<string, string | null>>();
    expect(active).toEqual({
      child_deleted: null,
      child_batch: null,
      task_deleted: null,
      task_batch: null,
      unrelated_deleted: unrelatedDeletedAt?.deleted_at,
      unrelated_batch: unrelatedBatchId,
      unrelated_project_deleted: expect.any(String),
      unrelated_project_batch: batchId,
      reused_batch_task_deleted: reusedBatchDeletedAt?.deleted_at,
      reused_batch_task_batch: batchId,
    });
  });

  it("rejects restoring a project beneath a deleted ancestor and returns current", async () => {
    const workerEnv = makeTestEnv();
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    await postSync(
      workerEnv,
      syncBody([
        projectChange({ name: versioned("root") }, rootId),
        projectChange({ name: versioned("child"), parent_id: versioned(rootId) }, childId),
      ]),
    );
    await postSync(
      workerEnv,
      syncBody([
        projectChange(
          {
            deleted_at: versioned(new Date().toISOString(), Date.now() + 100),
            deleted_batch_id: versioned(batchId, Date.now() + 100),
          },
          rootId,
        ),
      ]),
    );

    const response = await postSync(
      workerEnv,
      syncBody([projectChange({ deleted_at: versioned(null, Date.now() + 200) }, childId)]),
    );
    const body = (await response.json()) as SyncResponse;
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]).toMatchObject({ reason: "parent_deleted", entity: "project", id: childId });
    expect(body.rejected[0]?.current).toMatchObject({ entity: "project", id: childId });
    if (body.rejected[0]?.current.entity === "project") {
      expect(body.rejected[0].current.deleted_at).not.toBeNull();
    }
  });

  it("rejects restoring a task while its project is deleted and returns current", async () => {
    const workerEnv = makeTestEnv();
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    await postSync(
      workerEnv,
      syncBody([
        projectChange({ name: versioned("project") }, projectId),
        taskChange({ title: versioned("task"), project_id: versioned(projectId) }, taskId),
      ]),
    );
    await postSync(
      workerEnv,
      syncBody([
        projectChange(
          {
            deleted_at: versioned(new Date().toISOString(), Date.now() + 100),
            deleted_batch_id: versioned(batchId, Date.now() + 100),
          },
          projectId,
        ),
      ]),
    );

    const response = await postSync(
      workerEnv,
      syncBody([taskChange({ deleted_at: versioned(null, Date.now() + 200) }, taskId)]),
    );
    const body = (await response.json()) as SyncResponse;
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]).toMatchObject({ reason: "project_deleted", entity: "task", id: taskId });
    expect(body.rejected[0]?.current).toMatchObject({ entity: "task", id: taskId });
    if (body.rejected[0]?.current.entity === "task") {
      expect(body.rejected[0].current.deleted_at).not.toBeNull();
    }
  });

  it("puts an offline-created task in the deleted project's batch", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const projectId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const deletedAt = new Date().toISOString();
    const project = await postSync(
      workerEnv,
      syncBody([
        projectChange(
          {
            name: versioned("deleted project"),
            deleted_at: versioned(deletedAt),
            deleted_batch_id: versioned(batchId),
          },
          projectId,
        ),
      ]),
    );
    expect(((await project.json()) as SyncResponse).rejected).toEqual([]);

    const task = taskChange({ title: versioned("offline task"), project_id: versioned(projectId) });
    const created = await postSync(workerEnv, syncBody([task]));
    expect(((await created.json()) as SyncResponse).rejected).toEqual([]);
    const projectDeletedAt = await env.DB.prepare("SELECT deleted_at FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ deleted_at: string }>();
    expect(
      await env.DB.prepare("SELECT deleted_at, deleted_batch_id FROM tasks WHERE id = ?")
        .bind(task.id)
        .first(),
    ).toEqual({ deleted_at: projectDeletedAt?.deleted_at, deleted_batch_id: batchId });
  });

  it("rechecks project deletion in the same batch that writes an assigned task", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const projectId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    await postSync(workerEnv, syncBody([projectChange({ name: versioned("active") }, projectId)]));
    const owner = await userId(sub);
    const deletedAt = new Date().toISOString();
    const deletionClock = { ts: Date.now(), counter: 1, device_id: "server" };
    let injectDeletion = true;
    const racingDb = new Proxy(workerEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (injectDeletion) {
              injectDeletion = false;
              await target.batch([
                target.prepare("UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?").bind(owner),
                target.prepare(
                  `UPDATE projects SET deleted_at = ?, deleted_batch_id = ?,
                    field_ts = json_set(field_ts, '$.deleted_at', json(?), '$.deleted_batch_id', json(?)),
                    seq = (SELECT seq_counter FROM users WHERE id = ?) WHERE user_id = ? AND id = ?`,
                ).bind(
                  deletedAt,
                  batchId,
                  JSON.stringify(deletionClock),
                  JSON.stringify(deletionClock),
                  owner,
                  owner,
                  projectId,
                ),
              ]);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const task = taskChange({ title: versioned("racing task"), project_id: versioned(projectId) });
    const response = await postSync({ ...workerEnv, DB: racingDb }, syncBody([task]));
    expect(((await response.json()) as SyncResponse).rejected).toEqual([]);
    expect(
      await env.DB.prepare("SELECT deleted_at, deleted_batch_id FROM tasks WHERE id = ?")
        .bind(task.id)
        .first(),
    ).toEqual({ deleted_at: deletedAt, deleted_batch_id: batchId });
  });

  it("requests a full snapshot when the cursor predates the tombstone retention floor", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const change = taskChange({ title: versioned("snapshot task") });
    const created = await postSync(workerEnv, syncBody([change]));
    const upto = ((await created.json()) as SyncResponse).upto;
    const owner = await userId(sub);
    await env.DB.prepare("UPDATE users SET tombstone_floor_seq = ? WHERE id = ?").bind(upto, owner).run();

    const response = await postSync(workerEnv, syncBody([]));
    const body = (await response.json()) as SyncResponse;
    expect(body.full_resync).toBe(true);
    expect(body.rows).toContainEqual(expect.objectContaining({ entity: "task", id: change.id }));
  });

  it("returns a server error when a valid settings update fails in D1", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const failingDb = new Proxy(workerEnv.DB, {
      get(target, property) {
        if (property === "batch") return () => { throw new Error("database unavailable"); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          change_id: crypto.randomUUID(),
          fields: { timezone: versioned("America/New_York") },
        }),
      },
      { ...workerEnv, DB: failingDb },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "settings_failed" });
  });

  it("synchronizes settings through their versioned fields", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const initial = await app.request("/api/settings", {}, workerEnv);
    expect(await initial.json()).toMatchObject({ timezone: "Asia/Tokyo", locale: "ja", digest_time: "08:00" });

    const response = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          change_id: crypto.randomUUID(),
          fields: { timezone: versioned("America/New_York") },
        }),
      },
      workerEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ timezone: "America/New_York" });
  });
});

describe("daily purge", () => {
  it("uses server deletion time so client timestamps cannot cause immediate purge", async () => {
    const workerEnv = makeTestEnv(crypto.randomUUID());
    const oldDeletedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const change = taskChange({
      title: versioned("new trash"),
      deleted_at: versioned(oldDeletedAt),
      deleted_batch_id: versioned(crypto.randomUUID()),
    });
    const response = await postSync(workerEnv, syncBody([change]));
    expect(response.status).toBe(200);

    const stored = await env.DB.prepare("SELECT deleted_at, field_ts FROM tasks WHERE id = ?")
      .bind(change.id)
      .first<{ deleted_at: string; field_ts: string }>();
    expect(stored).not.toBeNull();
    expect(new Date(stored!.deleted_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.parse(stored!.field_ts).deleted_at).toEqual(change.fields.deleted_at.hlc);

    await purgeExpiredData(env);
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(change.id).first()).not.toBeNull();
  });

  it("records tombstones before physically deleting old trash", async () => {
    const sub = crypto.randomUUID();
    const workerEnv = makeTestEnv(sub);
    const oldDeletedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const change = taskChange({
      title: versioned("old trash"),
      deleted_at: versioned(oldDeletedAt),
      deleted_batch_id: versioned(crypto.randomUUID()),
    });
    const created = await postSync(workerEnv, syncBody([change]));
    const oldCursor = ((await created.json()) as SyncResponse).upto;
    await env.DB.prepare("UPDATE tasks SET deleted_at = ? WHERE id = ?").bind(oldDeletedAt, change.id).run();
    const owner = await userId(sub);
    const oldTombstoneId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?").bind(owner),
      env.DB.prepare(
        `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
         SELECT ?, 'task', ?, ?, seq_counter FROM users WHERE id = ?`,
      ).bind(
        owner,
        oldTombstoneId,
        new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString(),
        owner,
      ),
    ]);

    await scheduled?.(
      { cron: "0 0 * * *", scheduledTime: Date.now(), noRetry() {} },
      workerEnv,
      {} as ExecutionContext,
    );
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(change.id).first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM tombstones WHERE id = ? AND entity = 'task'")
        .bind(change.id)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM tombstones WHERE id = ?")
        .bind(oldTombstoneId)
        .first(),
    ).toBeNull();
    const resync = await postSync(workerEnv, syncBody([], oldCursor));
    expect(((await resync.json()) as SyncResponse).full_resync).toBe(true);
  });
});
