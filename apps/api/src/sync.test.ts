import { env as cloudflareEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SyncResponse } from "@task/shared";
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
