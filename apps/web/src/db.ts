import Dexie, { type Table } from "dexie";
import { getDefaultLocale } from "./i18n";
import {
  MAX_NOTE_LENGTH,
  MAX_PROJECT_DEPTH,
  MAX_TITLE_LENGTH,
  compareHlc,
  mergeLww,
  nextHlc,
  type FieldTimestamps,
  type Hlc,
  type Project,
  type ProjectFields,
  type RejectedChange,
  type SyncEntity,
  type SyncRow,
  type Task,
  type TaskFields,
  type Tombstone,
  type UserSettings,
  type UserSettingsState,
  type VersionedFields,
} from "@task/shared";

export interface SettingsRecord extends UserSettingsState {
  id: "settings";
}

export interface OutboxChange {
  change_id: string;
  entity: SyncEntity;
  id: string;
  fields: Record<string, { v: unknown; hlc: Hlc }>;
  created_at: number;
  batch_id?: string | null;
  operation?: "purge";
}

interface MetaRecord {
  key: string;
  value: string | number | Hlc;
}

type LocalRecord<T extends object> = T & {
  id: string;
  field_ts: FieldTimestamps<T>;
  seq: number;
};

export class TaskDatabase extends Dexie {
  tasks!: Table<Task, string>;
  projects!: Table<Project, string>;
  settings!: Table<SettingsRecord, string>;
  outbox!: Table<OutboxChange, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name = "task") {
    super(name);
    this.version(1).stores({
      tasks: "&id, project_id, deleted_at, deleted_batch_id, done, due_date",
      projects: "&id, parent_id, deleted_at, deleted_batch_id",
      settings: "&id",
      outbox: "&change_id, entity, id, created_at, [entity+id]",
      meta: "&key",
    });
  }
}

export const db = new TaskDatabase();

const SETTINGS_ID = "settings" as const;
const DEFAULT_SETTINGS: UserSettings = {
  timezone: "Asia/Tokyo",
  locale: getDefaultLocale(),
  digest_time: "08:00",
};

function taskDefaults(id: string, createdAt = new Date().toISOString()): Task {
  return {
    id,
    project_id: null,
    title: "",
    note: "",
    done: false,
    due_date: null,
    due_time: null,
    priority: 0,
    created_at: createdAt,
    deleted_at: null,
    deleted_batch_id: null,
    field_ts: {},
    seq: 0,
  };
}

function projectDefaults(id: string): Project {
  return {
    id,
    parent_id: null,
    name: "",
    deleted_at: null,
    deleted_batch_id: null,
    field_ts: {},
    seq: 0,
  };
}

function settingsDefaults(): SettingsRecord {
  return { id: SETTINGS_ID, ...DEFAULT_SETTINGS, field_ts: {}, seq: 0 };
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clockIsValid(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function versionFields<T extends object>(patch: Partial<T>, hlc: Hlc): VersionedFields<T> {
  const fields: Record<string, { v: unknown; hlc: Hlc }> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) fields[key] = { v: value, hlc };
  }
  return fields as VersionedFields<T>;
}

async function nextLocalHlc(database: TaskDatabase): Promise<Hlc> {
  const [device, last] = await Promise.all([
    database.meta.get("device_id"),
    database.meta.get("last_hlc"),
  ]);
  if (typeof device?.value !== "string") throw new Error("Local device ID is missing");
  return nextHlc(device.value, Date.now(), (last?.value as Hlc | undefined) ?? null);
}

async function saveHlc(database: TaskDatabase, hlc: Hlc): Promise<void> {
  await database.meta.put({ key: "last_hlc", value: hlc });
}

async function writeFields<T extends object, R extends LocalRecord<T>>(
  database: TaskDatabase,
  table: Table<R, string>,
  entity: SyncEntity,
  id: string,
  defaults: T,
  patch: Partial<T>,
  hlc: Hlc,
  queue = true,
): Promise<R> {
  const current = await table.get(id);
  const base = (current ?? { ...defaults }) as T;
  const fields = versionFields(patch, hlc);
  const merged = mergeLww(base, current?.field_ts ?? {}, fields);
  const row = {
    ...merged.value,
    id,
    field_ts: merged.field_ts,
    seq: current?.seq ?? 0,
  } as R;
  await table.put(row);
  if (queue) {
    const previous = await database.meta.get("outbox_order");
    const createdAt = Math.max(Date.now(), typeof previous?.value === "number" ? previous.value + 1 : 0);
    await database.meta.put({ key: "outbox_order", value: createdAt });
    await database.outbox.put({
      change_id: crypto.randomUUID(),
      entity,
      id,
      fields: fields as Record<string, { v: unknown; hlc: Hlc }>,
      created_at: createdAt,
    });
  }
  return row;
}

async function validateProjectParent(
  projects: Project[],
  id: string,
  parentId: string | null,
): Promise<void> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ancestors = new Set([id]);
  let ancestorDepth = 0;
  let cursor = parentId;
  while (cursor !== null) {
    if (ancestors.has(cursor)) throw new RangeError("Project hierarchy cannot contain a cycle");
    ancestors.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) throw new RangeError("Parent project does not exist");
    if (parent.deleted_at !== null) throw new RangeError("Parent project is in the trash");
    ancestorDepth += 1;
    cursor = parent.parent_id;
  }

  const children = new Map<string, string[]>();
  for (const project of projects) {
    if (project.parent_id !== null) {
      const ids = children.get(project.parent_id) ?? [];
      ids.push(project.id);
      children.set(project.parent_id, ids);
    }
  }
  const subtreeDepth = (projectId: string, path: Set<string>): number => {
    if (path.has(projectId)) throw new RangeError("Project hierarchy cannot contain a cycle");
    const nextPath = new Set(path).add(projectId);
    return 1 + Math.max(0, ...(children.get(projectId) ?? []).map((child) => subtreeDepth(child, nextPath)));
  };
  if (ancestorDepth + subtreeDepth(id, new Set()) > MAX_PROJECT_DEPTH) {
    throw new RangeError(`Project hierarchy cannot exceed ${MAX_PROJECT_DEPTH} levels`);
  }
}

function validateSettings(settings: UserSettings): void {
  if (typeof settings.timezone !== "string" || settings.timezone.length > 100) throw new RangeError("Invalid timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: settings.timezone });
  } catch {
    throw new RangeError("Invalid timezone");
  }
  if (settings.locale !== "ja" && settings.locale !== "en") throw new RangeError("Invalid locale");
  if (!clockIsValid(settings.digest_time)) throw new RangeError("Digest time must use HH:mm");
}

function validateTask(patch: Partial<TaskFields>, current: TaskFields): void {
  const next = { ...current, ...patch };
  if (typeof next.title !== "string" || next.title.trim().length === 0 || [...next.title].length > MAX_TITLE_LENGTH) {
    throw new RangeError(`Task title must contain 1-${MAX_TITLE_LENGTH} characters`);
  }
  if (typeof next.note !== "string" || [...next.note].length > MAX_NOTE_LENGTH) {
    throw new RangeError(`Task note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  if (next.due_date !== null && !dateIsValid(next.due_date)) throw new RangeError("Invalid due date");
  if (next.due_time !== null && (!clockIsValid(next.due_time) || next.due_date === null)) {
    throw new RangeError("Due time requires a date and must use HH:mm");
  }
  if (![0, 1, 2, 3].includes(next.priority)) throw new RangeError("Invalid priority");
}

export async function initializeDatabase(database = db): Promise<void> {
  await database.transaction("rw", database.meta, database.settings, async () => {
    if (!(await database.meta.get("device_id"))) {
      await database.meta.put({ key: "device_id", value: crypto.randomUUID() });
    }
    if (!(await database.settings.get(SETTINGS_ID))) {
      await database.settings.put(settingsDefaults());
    }
    if (!(await database.meta.get("since"))) await database.meta.put({ key: "since", value: 0 });
  });
}

export async function createTask(
  title: string,
  projectId: string | null = null,
  database = db,
): Promise<Task> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle || [...normalizedTitle].length > MAX_TITLE_LENGTH) {
    throw new RangeError(`Task title must contain 1-${MAX_TITLE_LENGTH} characters`);
  }
  return database.transaction("rw", database.tasks, database.projects, database.outbox, database.meta, async () => {
    if (projectId !== null) {
      const project = await database.projects.get(projectId);
      if (!project || project.deleted_at !== null) throw new RangeError("Project does not exist or is in the trash");
    }
    const id = crypto.randomUUID();
    const defaults = taskDefaults(id);
    const hlc = await nextLocalHlc(database);
    const fields: TaskFields = {
      project_id: projectId,
      title: normalizedTitle,
      note: "",
      done: false,
      due_date: null,
      due_time: null,
      priority: 0,
      created_at: defaults.created_at,
      deleted_at: null,
      deleted_batch_id: null,
    };
    const row = await writeFields(database, database.tasks, "task", id, defaults, fields, hlc);
    await saveHlc(database, hlc);
    return row;
  });
}

export async function updateTask(
  id: string,
  patch: Partial<TaskFields>,
  database = db,
): Promise<Task> {
  return database.transaction("rw", database.tasks, database.projects, database.outbox, database.meta, async () => {
    const current = await database.tasks.get(id);
    if (!current) throw new RangeError("Task does not exist");
    const update = { ...patch };
    if (update.title !== undefined) update.title = update.title.trim();
    validateTask(update, current);
    const nextProjectId = update.project_id !== undefined ? update.project_id : current.project_id;
    if (nextProjectId !== null) {
      const project = await database.projects.get(nextProjectId);
      if (!project || project.deleted_at !== null) throw new RangeError("Project does not exist or is in the trash");
    }
    const hlc = await nextLocalHlc(database);
    const row = await writeFields(database, database.tasks, "task", id, taskDefaults(id, current.created_at), update, hlc);
    await saveHlc(database, hlc);
    return row;
  });
}

export async function deleteTask(id: string, database = db): Promise<Task> {
  const current = await database.tasks.get(id);
  if (!current || current.deleted_at !== null) throw new RangeError("Task is not active");
  const deletedAt = new Date().toISOString();
  return updateTask(id, { deleted_at: deletedAt, deleted_batch_id: crypto.randomUUID() }, database);
}

export async function restoreTask(id: string, database = db): Promise<Task> {
  const current = await database.tasks.get(id);
  if (!current || current.deleted_at === null) throw new RangeError("Task is not in the trash");
  return updateTask(id, { deleted_at: null, deleted_batch_id: null }, database);
}

export async function createProject(
  name: string,
  parentId: string | null = null,
  database = db,
): Promise<Project> {
  const normalizedName = name.trim();
  if (!normalizedName || [...normalizedName].length > MAX_TITLE_LENGTH) {
    throw new RangeError(`Project name must contain 1-${MAX_TITLE_LENGTH} characters`);
  }
  return database.transaction("rw", database.projects, database.outbox, database.meta, async () => {
    const projects = await database.projects.toArray();
    const id = crypto.randomUUID();
    await validateProjectParent(projects, id, parentId);
    const hlc = await nextLocalHlc(database);
    const defaults = projectDefaults(id);
    const fields: ProjectFields = {
      parent_id: parentId,
      name: normalizedName,
      deleted_at: null,
      deleted_batch_id: null,
    };
    const row = await writeFields(database, database.projects, "project", id, defaults, fields, hlc);
    await saveHlc(database, hlc);
    return row;
  });
}

export async function updateProject(
  id: string,
  patch: Partial<ProjectFields>,
  database = db,
): Promise<Project> {
  return database.transaction("rw", database.projects, database.outbox, database.meta, async () => {
    const current = await database.projects.get(id);
    if (!current || current.deleted_at !== null) throw new RangeError("Project is not active");
    const update = { ...patch };
    if (update.name !== undefined) {
      update.name = update.name.trim();
      if (!update.name || [...update.name].length > MAX_TITLE_LENGTH) throw new RangeError("Invalid project name");
    }
    if (update.parent_id !== undefined && update.parent_id !== current.parent_id) {
      await validateProjectParent(await database.projects.toArray(), id, update.parent_id);
    }
    const hlc = await nextLocalHlc(database);
    const row = await writeFields(database, database.projects, "project", id, projectDefaults(id), update, hlc);
    await saveHlc(database, hlc);
    return row;
  });
}

function descendantsOf(rootId: string, projects: Project[]): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (project.parent_id !== null && ids.has(project.parent_id) && !ids.has(project.id)) {
        ids.add(project.id);
        changed = true;
      }
    }
  }
  return ids;
}

export async function deleteProject(id: string, database = db): Promise<Project> {
  return database.transaction(
    "rw",
    database.projects,
    database.tasks,
    database.outbox,
    database.meta,
    async () => {
      const root = await database.projects.get(id);
      if (!root || root.deleted_at !== null) throw new RangeError("Project is not active");
      const projects = await database.projects.toArray();
      const ids = descendantsOf(id, projects);
      const tasks = await database.tasks.toArray();
      const batchId = crypto.randomUUID();
      const deletedAt = new Date().toISOString();
      const hlc = await nextLocalHlc(database);
      const result = await writeFields(database, database.projects, "project", id, projectDefaults(id), {
        deleted_at: deletedAt,
        deleted_batch_id: batchId,
      }, hlc);
      for (const child of projects) {
        if (child.id !== id && ids.has(child.id)) {
          await writeFields(database, database.projects, "project", child.id, projectDefaults(child.id), {
            deleted_at: deletedAt,
            deleted_batch_id: batchId,
          }, hlc, false);
        }
      }
      for (const task of tasks) {
        if (task.project_id !== null && ids.has(task.project_id)) {
          await writeFields(database, database.tasks, "task", task.id, taskDefaults(task.id, task.created_at), {
            deleted_at: deletedAt,
            deleted_batch_id: batchId,
          }, hlc, false);
        }
      }
      await saveHlc(database, hlc);
      return result;
    },
  );
}

export async function restoreProject(id: string, database = db): Promise<Project> {
  return database.transaction(
    "rw",
    database.projects,
    database.tasks,
    database.outbox,
    database.meta,
    async () => {
      const root = await database.projects.get(id);
      if (!root || root.deleted_at === null || !root.deleted_batch_id) throw new RangeError("Project is not in the trash");
      const batchId = root.deleted_batch_id;
      const projects = await database.projects.toArray();
      const ids = descendantsOf(id, projects);
      const tasks = await database.tasks.toArray();
      const hlc = await nextLocalHlc(database);
      const result = await writeFields(database, database.projects, "project", id, projectDefaults(id), {
        deleted_at: null,
        deleted_batch_id: null,
      }, hlc);
      for (const child of projects) {
        if (child.id !== id && ids.has(child.id) && child.deleted_batch_id === batchId) {
          await writeFields(database, database.projects, "project", child.id, projectDefaults(child.id), {
            deleted_at: null,
            deleted_batch_id: null,
          }, hlc, false);
        }
      }
      for (const task of tasks) {
        if (task.deleted_batch_id === batchId && task.project_id !== null && ids.has(task.project_id)) {
          await writeFields(database, database.tasks, "task", task.id, taskDefaults(task.id, task.created_at), {
            deleted_at: null,
            deleted_batch_id: null,
          }, hlc, false);
        }
      }
      await saveHlc(database, hlc);
      return result;
    },
  );
}

export async function updateSettings(
  patch: Partial<UserSettings>,
  database = db,
): Promise<SettingsRecord> {
  return database.transaction("rw", database.settings, database.outbox, database.meta, async () => {
    const current = (await database.settings.get(SETTINGS_ID)) ?? settingsDefaults();
    const next = { timezone: current.timezone, locale: current.locale, digest_time: current.digest_time, ...patch };
    validateSettings(next);
    if (Object.keys(patch).length === 0) return current;
    const hlc = await nextLocalHlc(database);
    const row = await writeFields(database, database.settings, "settings", SETTINGS_ID, settingsDefaults(), patch, hlc);
    await saveHlc(database, hlc);
    return row;
  });
}

export async function purgeTrash(entity: "task" | "project", id: string, database = db): Promise<void> {
  await database.transaction("rw", database.tasks, database.projects, database.outbox, database.meta, async () => {
    const selected = entity === "task" ? await database.tasks.get(id) : await database.projects.get(id);
    if (!selected || selected.deleted_at === null) throw new RangeError("Item is not in the trash");
    const batchId = selected.deleted_batch_id;
    const purgedIds: { entity: "task" | "project"; id: string }[] = [{ entity, id }];
    if (entity === "project" && batchId !== null) {
      const [projects, tasks] = await Promise.all([database.projects.toArray(), database.tasks.toArray()]);
      for (const project of projects) {
        if (project.id !== id && project.deleted_at !== null && project.deleted_batch_id === batchId) {
          purgedIds.push({ entity: "project", id: project.id });
        }
      }
      for (const task of tasks) {
        if (task.deleted_at !== null && task.deleted_batch_id === batchId) purgedIds.push({ entity: "task", id: task.id });
      }
      await database.projects.bulkDelete(purgedIds.filter((entry) => entry.entity === "project").map((entry) => entry.id));
      await database.tasks.bulkDelete(purgedIds.filter((entry) => entry.entity === "task").map((entry) => entry.id));
    } else {
      await (entity === "task" ? database.tasks : database.projects).delete(id);
    }
    const previous = await database.meta.get("outbox_order");
    const createdAt = Math.max(Date.now(), typeof previous?.value === "number" ? previous.value + 1 : 0);
    await database.meta.put({ key: "outbox_order", value: createdAt });
    await database.outbox.put({
      change_id: crypto.randomUUID(),
      entity,
      id,
      fields: {},
      created_at: createdAt,
      ...(entity === "project" ? { batch_id: batchId } : {}),
      operation: "purge",
    });
  });
}

export async function applySyncData(
  database: TaskDatabase,
  rows: SyncRow[],
  tombstones: Tombstone[],
  rejected: RejectedChange[],
  fullResync: boolean,
  acknowledged: string[] = [],
): Promise<void> {
  await database.transaction(
    "rw",
    database.tasks,
    database.projects,
    database.settings,
    database.outbox,
    database.meta,
    async () => {
      if (acknowledged.length > 0) await database.outbox.bulkDelete(acknowledged);
      const pending = await database.outbox.toArray();
      const pendingKeys = new Set(pending.filter((item) => !item.operation).map((item) => `${item.entity}:${item.id}`));
      const pendingFields = new Map<string, Set<string>>();
      for (const item of pending) {
        if (item.operation) continue;
        const key = `${item.entity}:${item.id}`;
        const fields = pendingFields.get(key) ?? new Set<string>();
        for (const field of Object.keys(item.fields)) fields.add(field);
        pendingFields.set(key, fields);
      }
      if (fullResync) {
        for (const task of await database.tasks.toArray()) {
          if (!pendingKeys.has(`task:${task.id}`)) await database.tasks.delete(task.id);
        }
        for (const project of await database.projects.toArray()) {
          if (!pendingKeys.has(`project:${project.id}`)) await database.projects.delete(project.id);
        }
        if (!pendingKeys.has("settings:settings")) await database.settings.clear();
      }

      let latest: Hlc | undefined;
      const saveRemote = async <T extends object, R extends LocalRecord<T>>(
        table: Table<R, string>,
        entity: SyncEntity,
        id: string,
        fields: T,
        fieldTs: FieldTimestamps<T>,
        seq: number,
      ) => {
        const local = await table.get(id);
        const value = { ...(local ?? fields) } as T;
        const mergedFieldTs = { ...(local?.field_ts ?? {}) } as FieldTimestamps<T>;
        const unsentFields = pendingFields.get(`${entity}:${id}`);
        for (const key of Object.keys(fieldTs) as (keyof T)[]) {
          const hlc = fieldTs[key];
          if (!hlc || unsentFields?.has(String(key))) continue;
          value[key] = fields[key];
          mergedFieldTs[key] = hlc;
          if (!latest || compareHlc(hlc, latest) > 0) latest = hlc;
        }
        await table.put({
          ...value,
          id,
          field_ts: mergedFieldTs,
          seq: Math.max(local?.seq ?? 0, seq),
        } as R);
      };

      for (const row of rows) {
        if (row.entity === "task") {
          const { entity: _entity, ...task } = row;
          await saveRemote(database.tasks, "task", task.id, task, task.field_ts, task.seq);
        } else if (row.entity === "project") {
          const { entity: _entity, ...project } = row;
          await saveRemote(database.projects, "project", project.id, project, project.field_ts, project.seq);
        } else {
          const { entity: _entity, ...settings } = row;
          await saveRemote(database.settings, "settings", SETTINGS_ID, settings, settings.field_ts, settings.seq);
        }
      }

      for (const item of rejected) {
        const row = item.current;
        const rowId = row.entity === "settings" ? SETTINGS_ID : row.id;
        const newerRow = rows.find((candidate) =>
          candidate.entity === row.entity &&
          (candidate.entity === "settings" ? SETTINGS_ID : candidate.id) === rowId &&
          candidate.seq > row.seq,
        );
        if (newerRow) {
          await database.outbox.delete(item.change_id);
          continue;
        }
        if (row.entity === "task") {
          const { entity: _entity, ...task } = row;
          await database.tasks.put(task);
          for (const clock of Object.values(task.field_ts)) {
            if (clock && (!latest || compareHlc(clock, latest) > 0)) latest = clock;
          }
        } else if (row.entity === "project") {
          const { entity: _entity, ...project } = row;
          await database.projects.put(project);
          for (const clock of Object.values(project.field_ts)) {
            if (clock && (!latest || compareHlc(clock, latest) > 0)) latest = clock;
          }
        } else {
          const { entity: _entity, ...settings } = row;
          await database.settings.put({ ...settings, id: SETTINGS_ID });
          for (const clock of Object.values(settings.field_ts)) {
            if (clock && (!latest || compareHlc(clock, latest) > 0)) latest = clock;
          }
        }
        await database.outbox.delete(item.change_id);
      }

      for (const tombstone of tombstones) {
        if (tombstone.entity === "task") await database.tasks.delete(tombstone.id);
        else await database.projects.delete(tombstone.id);
        await database.outbox.where("[entity+id]").equals([tombstone.entity, tombstone.id]).delete();
      }
      if (latest) {
        const previous = await database.meta.get("last_hlc");
        const previousClock = previous?.value as Hlc | undefined;
        await database.meta.put({ key: "last_hlc", value: previousClock && compareHlc(previousClock, latest) > 0 ? previousClock : latest });
      }
    },
  );
}

export async function getSince(database = db): Promise<number> {
  const record = await database.meta.get("since");
  return typeof record?.value === "number" ? record.value : 0;
}

export async function setSince(value: number, database = db): Promise<void> {
  await database.meta.put({ key: "since", value });
}

export async function getSettings(database = db): Promise<SettingsRecord> {
  return (await database.settings.get(SETTINGS_ID)) ?? settingsDefaults();
}

export async function clearLocalData(
  database = db,
  storage: Pick<Storage, "clear"> = localStorage,
  cacheStorage: Pick<CacheStorage, "keys" | "delete"> | undefined = typeof caches === "undefined" ? undefined : caches,
  navigate: (path: string) => void = (path) => {
    if (import.meta.env.DEV) window.location.reload();
    else window.location.assign(path);
  },
): Promise<void> {
  database.close();
  await database.delete();
  storage.clear();
  if (cacheStorage) {
    await Promise.all((await cacheStorage.keys()).map((name) => cacheStorage.delete(name)));
  }
  // /cdn-cgi/ must bypass future service-worker caches so Access can end its session.
  navigate("/cdn-cgi/access/logout");
}
