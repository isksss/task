import {
  MAX_NOTE_LENGTH,
  MAX_PROJECT_DEPTH,
  MAX_SYNC_CHANGES_PER_REQUEST,
  MAX_TITLE_LENGTH,
  clampFutureHlc,
  compareHlc,
  isValidRecurrence,
  mergeLww,
  nextHlc,
  nextRecurrenceDate,
  recurringTaskId,
  type FieldTimestamps,
  type Hlc,
  type Project,
  type ProjectFields,
  type Recurrence,
  type RejectedChange,
  type SyncChange,
  type SyncEntity,
  type SyncResponse,
  type SyncRow,
  type Task,
  type TaskFields,
  type TaskTag,
  type TaskTagFields,
  type Tag,
  type TagFields,
  type Tombstone,
  type UserSettings,
  type UserSettingsState,
  type VersionedFields,
} from "@task/shared";
import type { UserRow } from "./auth";

export interface SyncEnv {
  DB: D1Database;
}

interface FieldUpdate {
  v: unknown;
  hlc: Hlc;
}

type LooseFieldTimestamps = Record<string, Hlc | undefined>;

type LooseChange = {
  change_id: string;
  entity: SyncEntity;
  id: string;
  fields: Record<string, FieldUpdate>;
};

interface DbProject extends Omit<Project, "field_ts"> {
  field_ts: string;
}

interface DbTask extends Omit<Task, "field_ts" | "done" | "recurrence"> {
  field_ts: string;
  done: number;
  recurrence: string | null;
}

interface DbTag extends Omit<Tag, "field_ts"> {
  field_ts: string;
}

interface DbTaskTag extends Omit<TaskTag, "field_ts" | "active"> {
  field_ts: string;
  active: number;
}

interface DbUserSettings extends UserSettings {
  id: string;
  field_ts: string;
  settings_seq: number;
  seq_counter: number;
  tombstone_floor_seq: number;
}

interface ProjectGraphRow {
  id: string;
  parent_id: string | null;
  deleted_at: string | null;
  deleted_batch_id: string | null;
  field_ts: string;
  seq: number;
}

interface TaskGraphRow {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  deleted_at: string | null;
  deleted_batch_id: string | null;
  field_ts: string;
  seq: number;
}

interface VersionedPageRow {
  entity: "task" | "project" | "tag" | "task_tag" | "settings";
  kind: "row" | "tombstone";
  id: string;
  seq: number;
  payload: string | null;
  purged_at: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const PAGE_TOKEN_PREFIX = "v1.";
const SETTINGS_ID = "settings";
const MAX_REQUEST_BODY_BYTES = 3_000_000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
const TASK_KEYS: (keyof TaskFields)[] = [
  "project_id",
  "parent_task_id",
  "recurrence",
  "title",
  "note",
  "done",
  "due_date",
  "due_time",
  "priority",
  "created_at",
  "deleted_at",
  "deleted_batch_id",
];
const PROJECT_KEYS: (keyof ProjectFields)[] = [
  "parent_id",
  "name",
  "deleted_at",
  "deleted_batch_id",
];
const TAG_KEYS: (keyof TagFields)[] = ["name", "deleted_at"];
const TASK_TAG_KEYS: (keyof TaskTagFields)[] = ["active"];
const SETTINGS_KEYS: (keyof UserSettings)[] = ["timezone", "locale", "digest_time"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function taskTagIds(id: string): { taskId: string; tagId: string } | null {
  const parts = id.split(":");
  return parts.length === 2 && isUuid(parts[0]) && isUuid(parts[1])
    ? { taskId: parts[0], tagId: parts[1] }
    : null;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidInstant(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return Boolean(
    value.length <= 40 &&
      match &&
      isValidDate(match[1]!) &&
      Number(match[2]) <= 23 &&
      Number(match[3]) <= 59 &&
      Number(match[4]) <= 59 &&
      (match[5] === "Z" || (Number(match[6]) <= 23 && Number(match[7]) <= 59)) &&
      Number.isFinite(Date.parse(value)),
  );
}

function isValidClock(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validFieldValue(entity: SyncEntity, field: string, value: unknown): boolean {
  if (entity === "task") {
    switch (field as keyof TaskFields) {
      case "project_id":
        return value === null || isUuid(value);
      case "title":
        return typeof value === "string" && [...value].length <= MAX_TITLE_LENGTH;
      case "note":
        return typeof value === "string" && [...value].length <= MAX_NOTE_LENGTH;
      case "done":
        return typeof value === "boolean";
      case "due_date":
        return value === null || (typeof value === "string" && isValidDate(value));
      case "due_time":
        return value === null || (typeof value === "string" && isValidClock(value));
      case "parent_task_id":
        return value === null || isUuid(value);
      case "recurrence":
        return value === null || isValidRecurrence(value);
      case "priority":
        return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
      case "created_at":
        return typeof value === "string" && isValidInstant(value);
      case "deleted_at":
        return value === null || (typeof value === "string" && isValidInstant(value));
      case "deleted_batch_id":
        return value === null || isUuid(value);
    }
  }
  if (entity === "project") {
    switch (field as keyof ProjectFields) {
      case "parent_id":
        return value === null || isUuid(value);
      case "name":
        return typeof value === "string" && [...value].length <= MAX_TITLE_LENGTH;
      case "deleted_at":
        return value === null || (typeof value === "string" && isValidInstant(value));
      case "deleted_batch_id":
        return value === null || isUuid(value);
    }
  }
  if (entity === "tag") {
    switch (field as keyof TagFields) {
      case "name":
        return typeof value === "string" && value.trim().length > 0 && [...value].length <= MAX_TITLE_LENGTH;
      case "deleted_at":
        return value === null || (typeof value === "string" && isValidInstant(value));
    }
  }
  if (entity === "task_tag" && field === "active") return typeof value === "boolean";
  if (entity === "settings") {
    switch (field as keyof UserSettings) {
      case "timezone":
        if (typeof value !== "string" || value.length > 100) return false;
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      case "locale":
        return value === "ja" || value === "en";
      case "digest_time":
        return typeof value === "string" && isValidClock(value);
    }
  }
  return false;
}

function parseChange(value: unknown): LooseChange {
  if (!isRecord(value)) throw new TypeError("change must be an object");
  const { change_id, entity, id, fields } = value;
  if (
    !isUuid(change_id) ||
    (entity !== "task" && entity !== "project" && entity !== "tag" && entity !== "task_tag" && entity !== "settings") ||
    (entity === "settings" ? id !== SETTINGS_ID : entity === "task_tag" ? typeof id !== "string" || !taskTagIds(id) : !isUuid(id)) ||
    !isRecord(fields)
  ) {
    throw new TypeError("invalid change envelope");
  }
  const allowed = entity === "task" ? TASK_KEYS : entity === "project" ? PROJECT_KEYS : entity === "tag" ? TAG_KEYS : entity === "task_tag" ? TASK_TAG_KEYS : SETTINGS_KEYS;
  const entries = Object.entries(fields);
  if (entries.length === 0 || entries.some(([key]) => !allowed.includes(key as never))) {
    throw new TypeError("invalid change fields");
  }
  const parsedFields: Record<string, FieldUpdate> = {};
  for (const [field, raw] of entries) {
    if (!isRecord(raw) || !isRecord(raw.hlc)) throw new TypeError("invalid field version");
    const hlc = raw.hlc;
    if (
      !Number.isSafeInteger(hlc.ts) ||
      Number(hlc.ts) < 0 ||
      !Number.isSafeInteger(hlc.counter) ||
      Number(hlc.counter) < 0 ||
      typeof hlc.device_id !== "string" ||
      !DEVICE_ID_PATTERN.test(hlc.device_id) ||
      !validFieldValue(entity, field, raw.v)
    ) {
      throw new TypeError(`invalid value for ${field}`);
    }
    parsedFields[field] = { v: raw.v, hlc: hlc as unknown as Hlc };
  }
  return {
    change_id: change_id as string,
    entity: entity as SyncEntity,
    id: id as string,
    fields: parsedFields,
  };
}

export interface ParsedSyncRequest {
  since: number;
  upto?: number;
  page?: string;
  changes: LooseChange[];
}

export function parseSyncRequest(value: unknown): ParsedSyncRequest {
  if (!isRecord(value)) throw new TypeError("request must be an object");
  if (
    !Number.isSafeInteger(value.since) ||
    Number(value.since) < 0 ||
    (value.upto !== undefined && (!Number.isSafeInteger(value.upto) || Number(value.upto) < 0)) ||
    (value.page !== undefined && (typeof value.page !== "string" || value.page.length > 500)) ||
    !Array.isArray(value.changes) ||
    value.changes.length > MAX_SYNC_CHANGES_PER_REQUEST
  ) {
    throw new TypeError("invalid sync request");
  }
  const changes = value.changes.map(parseChange);
  if (new Set(changes.map((change) => change.change_id)).size !== changes.length) {
    throw new TypeError("duplicate change_id");
  }
  return {
    since: Number(value.since),
    ...(value.upto === undefined ? {} : { upto: Number(value.upto) }),
    ...(value.page === undefined ? {} : { page: value.page }),
    changes,
  };
}

function parseFieldTs<T extends object>(value: string): FieldTimestamps<T> {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? (parsed as FieldTimestamps<T>) : {};
}

function projectFromDb(row: DbProject): Project {
  return { ...row, field_ts: parseFieldTs<ProjectFields>(row.field_ts) };
}

function taskFromDb(row: DbTask): Task {
  return {
    ...row,
    done: row.done === 1,
    recurrence: row.recurrence === null ? null : JSON.parse(row.recurrence) as Recurrence,
    field_ts: parseFieldTs<TaskFields>(row.field_ts),
  };
}

function tagFromDb(row: DbTag): Tag {
  return { ...row, field_ts: parseFieldTs<TagFields>(row.field_ts) };
}

function taskTagFromDb(row: DbTaskTag): TaskTag {
  return { ...row, active: row.active === 1, field_ts: parseFieldTs<TaskTagFields>(row.field_ts) };
}

function settingsFromDb(row: DbUserSettings): UserSettingsState {
  return {
    timezone: row.timezone,
    locale: row.locale,
    digest_time: row.digest_time,
    field_ts: parseFieldTs<UserSettings>(row.field_ts),
    seq: row.settings_seq,
  };
}

async function readProject(env: SyncEnv, userId: string, id: string): Promise<Project | null> {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE user_id = ? AND id = ?")
    .bind(userId, id)
    .first<DbProject>();
  return row ? projectFromDb(row) : null;
}

async function readTask(env: SyncEnv, userId: string, id: string): Promise<Task | null> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND id = ?")
    .bind(userId, id)
    .first<DbTask>();
  return row ? taskFromDb(row) : null;
}

async function readTag(env: SyncEnv, userId: string, id: string): Promise<Tag | null> {
  const row = await env.DB.prepare("SELECT * FROM tags WHERE user_id = ? AND id = ?")
    .bind(userId, id)
    .first<DbTag>();
  return row ? tagFromDb(row) : null;
}

async function readTaskTag(env: SyncEnv, userId: string, id: string): Promise<TaskTag | null> {
  const row = await env.DB.prepare("SELECT * FROM task_tags WHERE user_id = ? AND id = ?")
    .bind(userId, id)
    .first<DbTaskTag>();
  return row ? taskTagFromDb(row) : null;
}

async function readSettings(env: SyncEnv, user: UserRow): Promise<UserSettingsState> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(user.id)
    .first<DbUserSettings>();
  if (!row) throw new Error("Authenticated user missing from database");
  return settingsFromDb(row);
}

function defaultProject(id: string): Project {
  return { id, parent_id: null, name: "", deleted_at: null, deleted_batch_id: null, field_ts: {}, seq: 0 };
}

function defaultTask(id: string, now: string): Task {
  return {
    id,
    project_id: null,
    parent_task_id: null,
    recurrence: null,
    title: "",
    note: "",
    done: false,
    due_date: null,
    due_time: null,
    priority: 0,
    created_at: now,
    deleted_at: null,
    deleted_batch_id: null,
    field_ts: {},
    seq: 0,
  };
}

function defaultTag(id: string): Tag {
  return { id, name: "", deleted_at: null, field_ts: {}, seq: 0 };
}

function defaultTaskTag(id: string): TaskTag {
  const ids = taskTagIds(id);
  if (!ids) throw new RangeError("Invalid task tag ID");
  return { id, task_id: ids.taskId, tag_id: ids.tagId, active: false, field_ts: {}, seq: 0 };
}

function defaultSettings(): UserSettingsState {
  return { timezone: "Asia/Tokyo", locale: "ja", digest_time: "08:00", field_ts: {}, seq: 1 };
}

function maxHlc(...clocks: (Hlc | undefined)[]): Hlc | undefined {
  return clocks.reduce<Hlc | undefined>(
    (max, clock) => (clock && (!max || compareHlc(clock, max) > 0) ? clock : max),
    undefined,
  );
}

function allFieldClocks(fields: Record<string, FieldUpdate>): Hlc[] {
  return Object.values(fields).map(({ hlc }) => hlc);
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function encodePageToken(value: PageToken): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return PAGE_TOKEN_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePageToken(value: string): PageToken | null {
  if (!value.startsWith(PAGE_TOKEN_PREFIX)) return null;
  const encoded = value.slice(PAGE_TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0)),
      ),
    );
    if (!isRecord(parsed)) return null;
    if (
      !Number.isSafeInteger(parsed.since) ||
      !Number.isSafeInteger(parsed.upto) ||
      Number(parsed.since) < 0 ||
      Number(parsed.upto) < Number(parsed.since) ||
      typeof parsed.full !== "boolean"
    ) {
      return null;
    }
    let cursor: PageCursor | undefined;
    if (parsed.cursor !== undefined) {
      if (
        !isRecord(parsed.cursor) ||
        !Number.isSafeInteger(parsed.cursor.seq) ||
        Number(parsed.cursor.seq) < 0 ||
        (parsed.cursor.entity !== "task" &&
          parsed.cursor.entity !== "project" &&
          parsed.cursor.entity !== "tag" &&
          parsed.cursor.entity !== "task_tag" &&
          parsed.cursor.entity !== "settings") ||
        typeof parsed.cursor.id !== "string"
      ) {
        return null;
      }
      cursor = {
        seq: Number(parsed.cursor.seq),
        entity: parsed.cursor.entity,
        id: parsed.cursor.id,
      };
    }
    return {
      since: Number(parsed.since),
      upto: Number(parsed.upto),
      full: parsed.full,
      ...(cursor ? { cursor } : {}),
    };
  } catch {
    return null;
  }
}

interface PageCursor {
  seq: number;
  entity: VersionedPageRow["entity"];
  id: string;
}

interface PageToken {
  since: number;
  upto: number;
  full: boolean;
  cursor?: PageCursor;
}

function sqlHlcWins(field: string): { sql: string; values: (string | number)[] } {
  const ts = `json_extract(field_ts, '$.${field}.ts')`;
  const counter = `json_extract(field_ts, '$.${field}.counter')`;
  const device = `json_extract(field_ts, '$.${field}.device_id')`;
  return {
    sql: `(${ts} IS NULL OR ${ts} < ? OR (${ts} = ? AND (${counter} < ? OR (${counter} = ? AND ${device} < ?))))`,
    values: [],
  };
}

function conditionFor(field: string, hlc: Hlc): { sql: string; values: (string | number)[] } {
  const condition = sqlHlcWins(field);
  condition.values = [hlc.ts, hlc.ts, hlc.counter, hlc.counter, hlc.device_id];
  return condition;
}

function dbFieldValue(field: string, value: unknown): unknown {
  if (field === "done" || field === "active") return value ? 1 : 0;
  return field === "recurrence" && value !== null ? encodeJson(value) : value;
}

function updateVersionedRow(
  env: SyncEnv,
  table: "tasks" | "projects" | "tags" | "task_tags" | "users",
  userId: string,
  id: string,
  fields: Record<string, FieldUpdate>,
): D1PreparedStatement {
  const entries = Object.entries(fields);
  const inputValue = (field: string, property: string) =>
    `(SELECT json_extract(data, '$.fields.${field}.${property}') FROM incoming)`;
  const conditionForInput = (field: string) => {
    const ts = `json_extract(field_ts, '$.${field}.ts')`;
    const counter = `json_extract(field_ts, '$.${field}.counter')`;
    const device = `json_extract(field_ts, '$.${field}.device_id')`;
    const incomingTs = inputValue(field, "hlc.ts");
    const incomingCounter = inputValue(field, "hlc.counter");
    const incomingDevice = inputValue(field, "hlc.device_id");
    return `(${ts} IS NULL OR ${ts} < ${incomingTs} OR (${ts} = ${incomingTs} AND (${counter} < ${incomingCounter} OR (${counter} = ${incomingCounter} AND ${device} < ${incomingDevice}))))`;
  };
  const setParts = entries.map(([field]) =>
    `${field} = CASE WHEN ${conditionForInput(field)} THEN ${inputValue(field, "v")} ELSE ${field} END`,
  );
  const fieldTsExpression = `json_set(field_ts, ${entries
    .map(([field]) =>
      `'$.${field}', json(CASE WHEN ${conditionForInput(field)} THEN ${inputValue(field, "hlc")} ELSE json_extract(field_ts, '$.${field}') END)`,
    )
    .join(", ")})`;
  setParts.push(`field_ts = ${fieldTsExpression}`);
  setParts.push(table === "users"
    ? "settings_seq = (SELECT seq_counter FROM users WHERE id = ?)"
    : "seq = (SELECT seq_counter FROM users WHERE id = ?)");

  const where = entries.map(([field]) => conditionForInput(field)).join(" OR ");
  const whereId = table === "users" ? "id = ?" : "user_id = ? AND id = ?";
  const query = `WITH incoming(data) AS (SELECT json(?)) UPDATE ${table} SET ${setParts.join(", ")} WHERE ${whereId} AND (${where})`;
  const payload = encodeJson({
    fields: Object.fromEntries(entries.map(([field, update]) => [field, {
      v: dbFieldValue(field, update.v),
      hlc: update.hlc,
    }])),
  });
  return env.DB.prepare(query).bind(
    payload,
    userId,
    ...(table === "users" ? [userId] : [userId, id]),
  );
}

function projectTrashStatement(
  env: SyncEnv,
  userId: string,
  taskId: string,
  projectId: string,
  hlc: Hlc,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE tasks
       SET deleted_at = (SELECT deleted_at FROM projects WHERE user_id = ? AND id = ?),
           deleted_batch_id = (SELECT deleted_batch_id FROM projects WHERE user_id = ? AND id = ?),
           field_ts = json_set(field_ts, '$.deleted_at', json(?), '$.deleted_batch_id', json(?)),
           seq = (SELECT seq_counter FROM users WHERE id = ?)
     WHERE user_id = ? AND id = ? AND project_id = ? AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL AND deleted_batch_id IS NOT NULL)`,
  ).bind(
    userId, projectId, userId, projectId, encodeJson(hlc), encodeJson(hlc),
    userId, userId, taskId, projectId, userId, projectId,
  );
}

function recurringTaskStatements(
  env: SyncEnv,
  userId: string,
  sourceId: string,
  id: string,
  fields: TaskFields,
  hlc: Hlc,
): D1PreparedStatement[] {
  const fieldTs = Object.fromEntries(TASK_KEYS.map((field) => [field, hlc]));
  return [
    env.DB.prepare(
      `UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)
       AND NOT EXISTS (SELECT 1 FROM tombstones WHERE user_id = ? AND entity = 'task' AND id = ?)`,
    ).bind(userId, id, userId, id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks
         (id, user_id, project_id, parent_task_id, recurrence, title, note, done, due_date, due_time,
          priority, created_at, deleted_at, deleted_batch_id, field_ts, seq)
       SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?, seq_counter
       FROM users WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM tombstones WHERE user_id = ? AND entity = 'task' AND id = ?)
         AND EXISTS (SELECT 1 FROM tasks WHERE user_id = ? AND id = ? AND done = 1 AND deleted_at IS NULL)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL))`,
    ).bind(
      id, userId, fields.project_id, fields.parent_task_id, fields.recurrence === null ? null : encodeJson(fields.recurrence),
      fields.title, fields.note, fields.due_date, fields.due_time, fields.priority, fields.created_at,
      encodeJson(fieldTs), userId, id, userId, id, userId, sourceId,
      fields.project_id, userId, fields.project_id, fields.parent_task_id, userId, fields.parent_task_id,
    ),
  ];
}

function insertBaseRow(
  env: SyncEnv,
  entity: "task" | "project" | "tag" | "task_tag",
  userId: string,
  id: string,
  now: string,
): D1PreparedStatement {
  if (entity === "project") {
    return env.DB.prepare(
      `INSERT OR IGNORE INTO projects (id, user_id, parent_id, name, deleted_at, deleted_batch_id, field_ts, seq)
       VALUES (?, ?, NULL, '', NULL, NULL, '{}', 0)`,
    ).bind(id, userId);
  }
  if (entity === "tag") {
    return env.DB.prepare(
      "INSERT OR IGNORE INTO tags (id, user_id, name, deleted_at, field_ts, seq) VALUES (?, ?, '', NULL, '{}', 0)",
    ).bind(id, userId);
  }
  if (entity === "task_tag") {
    const ids = taskTagIds(id)!;
    return env.DB.prepare(
      "INSERT OR IGNORE INTO task_tags (id, user_id, task_id, tag_id, active, field_ts, seq) VALUES (?, ?, ?, ?, 0, '{}', 0)",
    ).bind(id, userId, ids.taskId, ids.tagId);
  }
  return env.DB.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, user_id, project_id, parent_task_id, recurrence, title, note, done, due_date, due_time, priority, created_at, deleted_at, deleted_batch_id, field_ts, seq)
     VALUES (?, ?, NULL, NULL, NULL, '', '', 0, NULL, NULL, 0, ?, NULL, NULL, '{}', 0)`,
  ).bind(id, userId, now);
}

function currentState(
  change: LooseChange,
  current: Task | Project | Tag | TaskTag | UserSettingsState | null,
  now: string,
): { values: Record<string, unknown>; field_ts: LooseFieldTimestamps } {
  if (change.entity === "task") {
    const row = current as Task | null;
    const fallback = defaultTask(change.id, now);
    return {
      values: { ...(row ?? fallback) },
      field_ts: (row ?? fallback).field_ts as LooseFieldTimestamps,
    };
  }
  if (change.entity === "project") {
    const row = current as Project | null;
    const fallback = defaultProject(change.id);
    return {
      values: { ...(row ?? fallback) },
      field_ts: (row ?? fallback).field_ts as LooseFieldTimestamps,
    };
  }
  if (change.entity === "tag") {
    const row = current as Tag | null;
    const fallback = defaultTag(change.id);
    return { values: { ...(row ?? fallback) }, field_ts: (row ?? fallback).field_ts as LooseFieldTimestamps };
  }
  if (change.entity === "task_tag") {
    const row = current as TaskTag | null;
    const fallback = defaultTaskTag(change.id);
    return { values: { active: (row ?? fallback).active }, field_ts: (row ?? fallback).field_ts as LooseFieldTimestamps };
  }
  const row = (current as UserSettingsState | null) ?? defaultSettings();
  return {
    values: { timezone: row.timezone, locale: row.locale, digest_time: row.digest_time },
    field_ts: row.field_ts as LooseFieldTimestamps,
  };
}

async function foreignEntityExists(
  env: SyncEnv,
  entity: "task" | "project" | "tag" | "task_tag",
  userId: string,
  id: string,
): Promise<boolean> {
  const table = entity === "task" ? "tasks" : entity === "project" ? "projects" : entity === "tag" ? "tags" : "task_tags";
  const row = await env.DB.prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ user_id: string }>();
  return row !== null && row.user_id !== userId;
}

async function getTombstone(
  env: SyncEnv,
  userId: string,
  entity: "task" | "project" | "tag",
  id: string,
): Promise<Tombstone | null> {
  return env.DB.prepare("SELECT entity, id, purged_at, seq FROM tombstones WHERE user_id = ? AND entity = ? AND id = ?")
    .bind(userId, entity, id)
    .first<Tombstone>();
}

async function wasApplied(env: SyncEnv, userId: string, changeId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM applied_changes WHERE user_id = ? AND change_id = ?")
    .bind(userId, changeId)
    .first<{ found: number }>();
  return row !== null;
}

function syntheticCurrent(entity: SyncEntity, id: string, now: string): SyncRow {
  if (entity === "task") return { entity, ...defaultTask(id, now) };
  if (entity === "project") return { entity, ...defaultProject(id) };
  if (entity === "tag") return { entity, ...defaultTag(id) };
  if (entity === "task_tag") return { entity, ...defaultTaskTag(id) };
  return { entity, ...defaultSettings() };
}

async function validateProjectParent(
  env: SyncEnv,
  userId: string,
  id: string,
  parentId: string | null,
): Promise<string | null> {
  if (parentId === null) return null;
  const rows = await env.DB.prepare(
    "SELECT id, parent_id, deleted_at FROM projects WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string; parent_id: string | null; deleted_at: string | null }>();
  const projects = new Map(rows.results.map((row) => [row.id, row]));
  const ancestors = new Set<string>([id]);
  let cursor: string | null = parentId;
  let ancestorDepth = 0;
  while (cursor !== null) {
    if (ancestors.has(cursor)) return "project_cycle";
    ancestors.add(cursor);
    const parent = projects.get(cursor);
    if (!parent) return "parent_not_found";
    if (parent.deleted_at !== null) return "parent_deleted";
    ancestorDepth++;
    if (ancestorDepth + 1 > MAX_PROJECT_DEPTH) return "project_depth_exceeded";
    cursor = parent.parent_id;
  }

  const children = new Map<string, string[]>();
  for (const project of projects.values()) {
    if (project.parent_id !== null) {
      const list = children.get(project.parent_id) ?? [];
      list.push(project.id);
      children.set(project.parent_id, list);
    }
  }
  const depthFrom = (projectId: string, path: Set<string>): number => {
    if (path.has(projectId)) return Number.POSITIVE_INFINITY;
    const nextPath = new Set(path).add(projectId);
    const childDepth = Math.max(0, ...(children.get(projectId) ?? []).map((child) => depthFrom(child, nextPath)));
    return 1 + childDepth;
  };
  if (ancestorDepth + depthFrom(id, new Set()) > MAX_PROJECT_DEPTH) return "project_depth_exceeded";
  return null;
}

async function validateTaskParent(
  env: SyncEnv,
  userId: string,
  id: string,
  parentId: string | null,
): Promise<string | null> {
  if (parentId === null) return null;
  if (id === parentId) return "task_cycle";
  const parent = await readTask(env, userId, parentId);
  if (!parent) return "parent_task_not_found";
  if (parent.parent_task_id !== null) return "subtask_cannot_be_parent";
  const hasChildren = await env.DB.prepare(
    "SELECT 1 AS found FROM tasks WHERE user_id = ? AND parent_task_id = ? AND id <> ? LIMIT 1",
  ).bind(userId, id, id).first<{ found: number }>();
  if (hasChildren) return "task_with_subtasks_cannot_be_subtask";
  return null;
}

async function loadProjectGraph(env: SyncEnv, userId: string): Promise<ProjectGraphRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, parent_id, deleted_at, deleted_batch_id, field_ts, seq FROM projects WHERE user_id = ?",
  )
    .bind(userId)
    .all<ProjectGraphRow>();
  return result.results;
}

async function loadTaskGraph(env: SyncEnv, userId: string): Promise<TaskGraphRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, project_id, parent_task_id, deleted_at, deleted_batch_id, field_ts, seq FROM tasks WHERE user_id = ?",
  )
    .bind(userId)
    .all<TaskGraphRow>();
  return result.results;
}

function cascadeTargets(
  entity: "task" | "project",
  id: string,
  batchId: string,
  action: "delete" | "restore",
  projects: ProjectGraphRow[],
  tasks: TaskGraphRow[],
): { projectIds: string[]; taskIds: string[]; latestHlc?: Hlc } {
  const projectIds = new Set<string>();
  const taskIds = new Set<string>();
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  let latest: Hlc | undefined;
  if (entity === "task" && (action === "delete" || action === "restore")) {
    for (const task of tasks) {
      if (task.parent_task_id === id && (action === "delete" ? task.deleted_at === null : task.deleted_batch_id === batchId)) {
        taskIds.add(task.id);
      }
    }
  }
  if (entity === "project" && (action === "delete" || action === "restore")) {
    const descendants = new Set<string>();
    const visit = (parentId: string) => {
      for (const project of projects) {
        if (project.parent_id !== parentId || descendants.has(project.id)) continue;
        descendants.add(project.id);
        visit(project.id);
      }
    };
    visit(id);
    if (action === "delete") {
      for (const projectId of descendants) projectIds.add(projectId);
      for (const task of tasks) {
        if (task.deleted_at === null && (task.project_id === id || (task.project_id !== null && descendants.has(task.project_id)))) {
          taskIds.add(task.id);
        }
      }
    } else {
      for (const project of projects) {
        if (descendants.has(project.id) && project.deleted_batch_id === batchId) projectIds.add(project.id);
      }
      for (const task of tasks) {
        if (
          task.deleted_batch_id === batchId &&
          (task.project_id === id || (task.project_id !== null && descendants.has(task.project_id)))
        ) {
          taskIds.add(task.id);
        }
      }
    }
  }
  const rootTaskIds = [...taskIds];
  for (const task of tasks) {
    if (task.parent_task_id !== null && rootTaskIds.includes(task.parent_task_id) &&
      (action === "delete" ? task.deleted_at === null : task.deleted_batch_id === batchId)) taskIds.add(task.id);
  }

  for (const projectId of projectIds) {
    const project = projectMap.get(projectId);
    if (!project) continue;
    const clocks = parseFieldTs<ProjectFields>(project.field_ts);
    latest = maxHlc(latest, clocks.deleted_at, clocks.deleted_batch_id);
  }
  for (const task of tasks) {
    if (!taskIds.has(task.id)) continue;
    const clocks = parseFieldTs<TaskFields>(task.field_ts);
    latest = maxHlc(latest, clocks.deleted_at, clocks.deleted_batch_id);
  }
  return { projectIds: [...projectIds], taskIds: [...taskIds], latestHlc: latest };
}

function cascadeUpdateStatement(
  env: SyncEnv,
  table: "projects" | "tasks",
  userId: string,
  mode: "delete" | "restore",
  batchId: string,
  deletedAt: string | null,
  hlc: Hlc,
  rootProjectId?: string,
): D1PreparedStatement {
  const atCondition = conditionFor("deleted_at", hlc);
  const batchCondition = conditionFor("deleted_batch_id", hlc);
  let where: string;
  let whereValues: unknown[];
  if (mode === "restore") {
    const descendants = `WITH RECURSIVE descendants(id) AS (
      SELECT id FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND deleted_batch_id IS NULL
      UNION
      SELECT child.id FROM projects child JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.user_id = ?
    ) SELECT id FROM descendants`;
    if (table === "projects") {
      where = `user_id = ? AND deleted_batch_id = ? AND id IN (${descendants}) AND id <> ?`;
      whereValues = [userId, batchId, userId, rootProjectId!, userId, rootProjectId!];
    } else {
      where = `user_id = ? AND deleted_batch_id = ? AND id IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND deleted_batch_id IS NULL
          UNION
          SELECT child.id FROM projects child JOIN descendants parent ON child.parent_id = parent.id
          WHERE child.user_id = ?
        ), target_tasks(id) AS (
          SELECT id FROM tasks WHERE user_id = ? AND project_id IN (SELECT id FROM descendants) AND deleted_batch_id = ?
          UNION
          SELECT child.id FROM tasks child JOIN target_tasks parent ON child.parent_task_id = parent.id
          WHERE child.user_id = ? AND child.deleted_batch_id = ?
        ) SELECT id FROM target_tasks
      )`;
      whereValues = [userId, batchId, userId, rootProjectId!, userId, userId, batchId, userId, batchId];
    }
  } else if (table === "projects") {
    where = `user_id = ? AND id IN (
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM projects WHERE user_id = ? AND id = ? AND deleted_at = ? AND deleted_batch_id = ?
        UNION
        SELECT child.id FROM projects child JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.user_id = ?
      ) SELECT id FROM descendants
    ) AND id <> ?`;
    whereValues = [userId, userId, rootProjectId!, deletedAt, batchId, userId, rootProjectId!];
  } else {
    const projectRoot = "SELECT id FROM projects WHERE user_id = ? AND id = ? AND deleted_at = ? AND deleted_batch_id = ?";
    const taskCondition = "deleted_at IS NULL";
    const childCondition = "child.deleted_at IS NULL";
    where = `user_id = ? AND id IN (
      WITH RECURSIVE descendants(id) AS (
        ${projectRoot}
        UNION
        SELECT child.id FROM projects child JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.user_id = ?
      ), target_tasks(id) AS (
        SELECT id FROM tasks WHERE user_id = ? AND project_id IN (SELECT id FROM descendants) AND ${taskCondition}
        UNION
        SELECT child.id FROM tasks child JOIN target_tasks parent ON child.parent_task_id = parent.id
        WHERE child.user_id = ? AND ${childCondition}
      ) SELECT id FROM target_tasks
    )`;
    whereValues = [userId, userId, rootProjectId!, deletedAt!, batchId, userId, userId, userId];
  }

  const fullFieldTs = `json_set(field_ts,
    '$.deleted_at', json(CASE WHEN ${atCondition.sql} THEN ? ELSE json_extract(field_ts, '$.deleted_at') END),
    '$.deleted_batch_id', json(CASE WHEN ${batchCondition.sql} THEN ? ELSE json_extract(field_ts, '$.deleted_batch_id') END))`;
  const fieldTsParams = [
    ...atCondition.values,
    encodeJson(hlc),
    ...batchCondition.values,
    encodeJson(hlc),
  ];
  return env.DB.prepare(
    `UPDATE ${table}
       SET deleted_at = CASE WHEN ${atCondition.sql} THEN ? ELSE deleted_at END,
           deleted_batch_id = CASE WHEN ${batchCondition.sql} THEN ? ELSE deleted_batch_id END,
           field_ts = ${fullFieldTs},
           seq = (SELECT seq_counter FROM users WHERE id = ?)
     WHERE ${where} AND (${atCondition.sql} OR ${batchCondition.sql})`,
  ).bind(
    ...atCondition.values,
    deletedAt,
    ...batchCondition.values,
    mode === "restore" ? null : batchId,
    ...fieldTsParams,
    userId,
    ...whereValues,
    ...atCondition.values,
    ...batchCondition.values,
  );
}

function taskChildrenCascadeStatement(
  env: SyncEnv,
  userId: string,
  parentTaskId: string,
  mode: "delete" | "restore",
  batchId: string,
  deletedAt: string | null,
  hlc: Hlc,
): D1PreparedStatement {
  const atCondition = conditionFor("deleted_at", hlc);
  const batchCondition = conditionFor("deleted_batch_id", hlc);
  const stateCondition = mode === "delete" ? "deleted_at IS NULL" : "deleted_batch_id = ?";
  const parentState = mode === "delete"
    ? "deleted_at = ? AND deleted_batch_id = ?"
    : "deleted_at IS NULL AND deleted_batch_id IS NULL";
  const fullFieldTs = `json_set(field_ts,
    '$.deleted_at', json(CASE WHEN ${atCondition.sql} THEN ? ELSE json_extract(field_ts, '$.deleted_at') END),
    '$.deleted_batch_id', json(CASE WHEN ${batchCondition.sql} THEN ? ELSE json_extract(field_ts, '$.deleted_batch_id') END))`;
  return env.DB.prepare(
    `UPDATE tasks
       SET deleted_at = CASE WHEN ${atCondition.sql} THEN ? ELSE deleted_at END,
           deleted_batch_id = CASE WHEN ${batchCondition.sql} THEN ? ELSE deleted_batch_id END,
           field_ts = ${fullFieldTs},
           seq = (SELECT seq_counter FROM users WHERE id = ?)
     WHERE user_id = ? AND parent_task_id = ? AND ${stateCondition}
       AND EXISTS (SELECT 1 FROM tasks parent WHERE parent.user_id = ? AND parent.id = ? AND ${parentState})
       AND (${atCondition.sql} OR ${batchCondition.sql})`,
  ).bind(
    ...atCondition.values, deletedAt,
    ...batchCondition.values, mode === "restore" ? null : batchId,
    ...atCondition.values, encodeJson(hlc),
    ...batchCondition.values, encodeJson(hlc),
    userId, userId, parentTaskId,
    ...(mode === "restore" ? [batchId] : []),
    userId, parentTaskId,
    ...(mode === "delete" ? [deletedAt!, batchId] : []),
    ...atCondition.values, ...batchCondition.values,
  );
}

function appliedChangeStatement(env: SyncEnv, userId: string, changeId: string, now: string) {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO applied_changes (user_id, change_id, applied_at) VALUES (?, ?, ?)",
  ).bind(userId, changeId, now);
}

function fieldVersionsForMerge(fields: Record<string, FieldUpdate>, now: number, fieldTs: LooseFieldTimestamps) {
  const clamped: Record<string, FieldUpdate> = {};
  for (const [key, update] of Object.entries(fields)) {
    clamped[key] = {
      ...update,
      hlc: clampFutureHlc(update.hlc, now, fieldTs[key]),
    };
  }
  return clamped;
}

function toTypedVersionedFields<T extends object>(fields: Record<string, FieldUpdate>): VersionedFields<T> {
  return fields as VersionedFields<T>;
}

function winningFields<T extends object>(
  fieldTs: FieldTimestamps<T>,
  fields: Record<string, FieldUpdate>,
): Record<string, FieldUpdate> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, update]) => {
      const current = fieldTs[key as keyof T];
      return !current || compareHlc(update.hlc, current) > 0;
    }),
  );
}

async function applyChange(
  env: SyncEnv,
  user: UserRow,
  change: LooseChange,
): Promise<{ rejected?: RejectedChange; tombstone?: Tombstone }> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  if (change.entity === "task" || change.entity === "project" || change.entity === "tag") {
    const tombstone = await getTombstone(env, user.id, change.entity, change.id);
    if (tombstone) {
      if (!(await wasApplied(env, user.id, change.change_id))) {
        await env.DB.batch([appliedChangeStatement(env, user.id, change.change_id, now)]);
      }
      return { tombstone };
    }
  }
  if (await wasApplied(env, user.id, change.change_id)) return {};
  if (change.entity !== "settings") {
    if (await foreignEntityExists(env, change.entity, user.id, change.id)) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: change.entity,
          id: change.id,
          reason: "id_unavailable",
          current: syntheticCurrent(change.entity, change.id, now),
        } as RejectedChange,
      };
    }
  }

  let current: Task | Project | Tag | TaskTag | UserSettingsState | null;
  if (change.entity === "task") current = await readTask(env, user.id, change.id);
  else if (change.entity === "project") current = await readProject(env, user.id, change.id);
  else if (change.entity === "tag") current = await readTag(env, user.id, change.id);
  else if (change.entity === "task_tag") current = await readTaskTag(env, user.id, change.id);
  else current = await readSettings(env, user);

  const state = currentState(change, current, now);
  const currentVersions = state.field_ts;
  let fields = fieldVersionsForMerge(change.fields, nowMs, currentVersions);
  const isNew = current === null && change.entity !== "settings";

  if (change.entity === "task" || change.entity === "project") {
    const before = state.values;
    const deletionVersions = currentVersions as FieldTimestamps<TaskFields>;
    const deletedAtUpdate = fields.deleted_at;
    const currentDeletedAt = before.deleted_at as string | null;
    if (deletedAtUpdate?.v !== undefined && deletedAtUpdate.v !== null && currentDeletedAt === null) {
      const batchUpdate = fields.deleted_batch_id;
      if (batchUpdate?.v === undefined || batchUpdate.v === null) {
        const generated = nextHlc("server", nowMs, maxHlc(deletedAtUpdate.hlc, batchUpdate?.hlc));
        fields.deleted_batch_id = { v: crypto.randomUUID(), hlc: generated };
      }
    }
    if (deletedAtUpdate?.v === null && currentDeletedAt !== null) {
      const restoreClock = nextHlc(
        "server",
        nowMs,
        maxHlc(
          deletionVersions.deleted_at,
          deletionVersions.deleted_batch_id,
          ...allFieldClocks(fields),
        ),
      );
      fields.deleted_batch_id = { v: null, hlc: restoreClock };
    }
  }

  let mergedValue: Record<string, unknown> = { ...state.values };
  const merge = () => {
    if (change.entity === "task") {
      const result = mergeLww(state.values as unknown as TaskFields, currentVersions as FieldTimestamps<TaskFields>, toTypedVersionedFields<TaskFields>(fields));
      mergedValue = result.value as unknown as Record<string, unknown>;
    } else if (change.entity === "project") {
      const result = mergeLww(state.values as unknown as ProjectFields, currentVersions as FieldTimestamps<ProjectFields>, toTypedVersionedFields<ProjectFields>(fields));
      mergedValue = result.value as unknown as Record<string, unknown>;
    } else if (change.entity === "tag") {
      const result = mergeLww(state.values as unknown as TagFields, currentVersions as FieldTimestamps<TagFields>, toTypedVersionedFields<TagFields>(fields));
      mergedValue = result.value as unknown as Record<string, unknown>;
    } else if (change.entity === "task_tag") {
      const result = mergeLww(state.values as unknown as TaskTagFields, currentVersions as FieldTimestamps<TaskTagFields>, toTypedVersionedFields<TaskTagFields>(fields));
      mergedValue = result.value as unknown as Record<string, unknown>;
    } else {
      const result = mergeLww(state.values as unknown as UserSettings, currentVersions as FieldTimestamps<UserSettings>, toTypedVersionedFields<UserSettings>(fields));
      mergedValue = result.value as unknown as Record<string, unknown>;
    }
  };
  merge();
  if (
    (change.entity === "task" || change.entity === "project" || change.entity === "tag") &&
    state.values.deleted_at === null &&
    mergedValue.deleted_at !== null &&
    fields.deleted_at
  ) {
    fields.deleted_at = { ...fields.deleted_at, v: now };
    merge();
  }

  let projectTrash: { projectId: string; hlc: Hlc } | undefined;
  if (change.entity === "task") {
    const currentTask = current as Task | null;
    const projectId = mergedValue.project_id as string | null;
    if (projectId !== null) {
      const target = await readProject(env, user.id, projectId);
      if (!target) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason: "project_not_found",
            current: { entity: "task", ...(current as Task | null ?? defaultTask(change.id, now)) },
          } as RejectedChange,
        };
      }
      if (
        target.deleted_at !== null &&
        currentTask !== null &&
        currentTask.deleted_at !== null &&
        mergedValue.deleted_at === null
      ) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason: "project_deleted",
            current: { entity: "task", ...currentTask },
          },
        };
      }
      if (target.deleted_at !== null && mergedValue.deleted_at === null) {
        const targetClock = maxHlc(target.field_ts.deleted_at, target.field_ts.deleted_batch_id);
        const forcedClock = nextHlc("server", nowMs, maxHlc(targetClock, ...allFieldClocks(fields)));
        fields.deleted_at = { v: target.deleted_at, hlc: forcedClock };
        fields.deleted_batch_id = { v: target.deleted_batch_id, hlc: forcedClock };
        merge();
      }
      if (mergedValue.deleted_at === null) {
        projectTrash = {
          projectId,
          hlc: nextHlc(
            "server",
            nowMs,
            maxHlc(
              target.field_ts.deleted_at,
              target.field_ts.deleted_batch_id,
              currentVersions.deleted_at,
              currentVersions.deleted_batch_id,
              ...allFieldClocks(fields),
            ),
          ),
        };
      }
    }
    if (mergedValue.due_date === null && mergedValue.due_time !== null) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: "task",
          id: change.id,
          reason: "due_time_requires_date",
          current: { entity: "task", ...(current as Task | null ?? defaultTask(change.id, now)) },
        } as RejectedChange,
      };
    }
    if (mergedValue.recurrence !== null && mergedValue.due_date === null) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: "task",
          id: change.id,
          reason: "recurrence_requires_date",
          current: { entity: "task", ...(currentTask ?? defaultTask(change.id, now)) },
        },
      };
    }
    const parentTaskId = mergedValue.parent_task_id as string | null;
    if (fields.parent_task_id && parentTaskId !== state.values.parent_task_id) {
      const reason = await validateTaskParent(env, user.id, change.id, parentTaskId);
      if (reason) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason,
            current: { entity: "task", ...(currentTask ?? defaultTask(change.id, now)) },
          } as RejectedChange,
        };
      }
    }
    if (parentTaskId !== null) {
      const parent = await readTask(env, user.id, parentTaskId);
      if (!parent) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason: "parent_task_not_found",
            current: { entity: "task", ...(currentTask ?? defaultTask(change.id, now)) },
          } as RejectedChange,
        };
      }
      if (parent.parent_task_id !== null) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason: "subtask_cannot_be_parent",
            current: { entity: "task", ...(currentTask ?? defaultTask(change.id, now)) },
          } as RejectedChange,
        };
      }
      if (parent.deleted_at !== null && mergedValue.deleted_at === null) {
        if (currentTask && currentTask.deleted_at !== null) {
          return {
            rejected: {
              change_id: change.change_id,
              entity: "task",
              id: change.id,
              reason: "parent_task_deleted",
              current: { entity: "task", ...(currentTask ?? defaultTask(change.id, now)) },
            } as RejectedChange,
          };
        }
        const parentClock = maxHlc(parent.field_ts.deleted_at, parent.field_ts.deleted_batch_id);
        const clock = nextHlc("server", nowMs, maxHlc(parentClock, ...allFieldClocks(fields)));
        fields.deleted_at = { v: parent.deleted_at, hlc: clock };
        fields.deleted_batch_id = { v: parent.deleted_batch_id, hlc: clock };
        merge();
      }
    }
    if (
      currentTask &&
      currentTask.deleted_at !== null &&
      mergedValue.deleted_at !== null &&
      mergedValue.deleted_batch_id !== currentTask.deleted_batch_id
    ) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: "task",
          id: change.id,
          reason: "deleted_batch_immutable",
          current: { entity: "task", ...(current as Task) },
        } as RejectedChange,
      };
    }
  }

  if (change.entity === "task_tag" && mergedValue.active === true) {
    const ids = taskTagIds(change.id)!;
    const [task, tag] = await Promise.all([
      readTask(env, user.id, ids.taskId),
      readTag(env, user.id, ids.tagId),
    ]);
    const reason = !task ? "task_not_found" : task.deleted_at !== null ? "task_deleted" :
      !tag ? "tag_not_found" : tag.deleted_at !== null ? "tag_deleted" : null;
    if (reason) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: "task_tag",
          id: change.id,
          reason,
          current: { entity: "task_tag", ...(current as TaskTag | null ?? defaultTaskTag(change.id)) },
        } as RejectedChange,
      };
    }
  }

  const projectParentChanged =
    change.entity === "project" &&
    fields.parent_id &&
    mergedValue.parent_id !== (state.values.parent_id as string | null);
  const restoringProject =
    change.entity === "project" && state.values.deleted_at !== null && mergedValue.deleted_at === null;
  if (change.entity === "project" && (projectParentChanged || restoringProject)) {
    const reason = await validateProjectParent(env, user.id, change.id, mergedValue.parent_id as string | null);
    if (reason) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: "project",
          id: change.id,
          reason,
          current: { entity: "project", ...(current as Project | null ?? defaultProject(change.id)) },
        } as RejectedChange,
      };
    }
  }

  let cascade: { action: "delete" | "restore"; batchId: string; deletedAt: string | null; hlc: Hlc } | undefined;
  if (change.entity === "project" || change.entity === "task") {
    const oldDeletedAt = (state.values.deleted_at ?? null) as string | null;
    const newDeletedAt = (mergedValue.deleted_at ?? null) as string | null;
    const oldBatchId = (state.values.deleted_batch_id ?? null) as string | null;
    const newBatchId = (mergedValue.deleted_batch_id ?? null) as string | null;
    if (oldDeletedAt === null && newDeletedAt !== null) {
      if (!newBatchId) {
        const generated = crypto.randomUUID();
        const clock = nextHlc("server", nowMs, maxHlc(...allFieldClocks(fields)));
        fields.deleted_batch_id = { v: generated, hlc: clock };
        merge();
      }
      if (change.entity === "project" || change.entity === "task") {
        cascade = {
          action: "delete",
          batchId: mergedValue.deleted_batch_id as string,
          deletedAt: newDeletedAt,
          hlc: fields.deleted_at?.hlc ?? nextHlc("server", nowMs),
        };
      }
    } else if (oldDeletedAt !== null && newDeletedAt === null && oldBatchId) {
      if (change.entity === "project" || change.entity === "task") {
        cascade = {
          action: "restore",
          batchId: oldBatchId,
          deletedAt: null,
          hlc: fields.deleted_batch_id?.hlc ?? nextHlc("server", nowMs),
        };
      }
    } else if (oldDeletedAt !== null && newDeletedAt !== null && newBatchId !== oldBatchId) {
      return {
        rejected: {
          change_id: change.change_id,
          entity: change.entity,
          id: change.id,
          reason: "deleted_batch_immutable",
          current: {
            entity: change.entity,
            ...(current ?? (change.entity === "task" ? defaultTask(change.id, now) : change.entity === "project" ? defaultProject(change.id) : change.entity === "tag" ? defaultTag(change.id) : change.entity === "task_tag" ? defaultTaskTag(change.id) : defaultSettings())),
          } as SyncRow,
        } as RejectedChange,
      };
    }
  }

  const changedFields = winningFields(currentVersions, fields);
  let recurrenceOccurrence: { id: string; fields: TaskFields; hlc: Hlc } | undefined;
  // shortcut: 完了が繰り返し設定より先に届くと次回分が生成されない。複数端末で頻発したら完了時刻の記録と後着照合に移行する。
  if (
    change.entity === "task" &&
    (current as Task | null)?.done === false &&
    (current as Task | null)?.deleted_at === null &&
    changedFields.done !== undefined &&
    mergedValue.done === true &&
    mergedValue.deleted_at === null &&
    mergedValue.recurrence !== null &&
    mergedValue.due_date !== null
  ) {
    const recurrence = mergedValue.recurrence as Recurrence;
    const dueDate = nextRecurrenceDate(mergedValue.due_date as string, recurrence);
    const id = await recurringTaskId(change.id, dueDate);
    recurrenceOccurrence = {
      id,
      hlc: changedFields.done.hlc,
      fields: {
        project_id: mergedValue.project_id as string | null,
        parent_task_id: mergedValue.parent_task_id as string | null,
        recurrence,
        title: mergedValue.title as string,
        note: mergedValue.note as string,
        done: false,
        due_date: dueDate,
        due_time: mergedValue.due_time as string | null,
        priority: mergedValue.priority as TaskFields["priority"],
        created_at: now,
        deleted_at: null,
        deleted_batch_id: null,
      },
    };
  }
  const requestedFields = Object.keys(change.fields);
  const lostFields = !isNew && requestedFields.some((field) => !(field in changedFields));
  if (isNew && Object.keys(changedFields).length === 0) {
    return {
      rejected: {
        change_id: change.change_id,
        entity: change.entity,
        id: change.id,
        reason: "no_fields_applied",
        current: syntheticCurrent(change.entity, change.id, now),
      } as RejectedChange,
    };
  }

  const statements: D1PreparedStatement[] = [];
  if (isNew && change.entity !== "settings") {
    statements.push(insertBaseRow(env, change.entity, user.id, change.id, now));
  }
  if (Object.keys(changedFields).length > 0) {
    statements.push(env.DB.prepare("UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?").bind(user.id));
    const table = change.entity === "settings" ? "users" : change.entity === "task" ? "tasks" : change.entity === "project" ? "projects" : change.entity === "tag" ? "tags" : "task_tags";
    statements.push(updateVersionedRow(env, table, user.id, change.id, changedFields));
    if (projectTrash) {
      statements.push(projectTrashStatement(env, user.id, change.id, projectTrash.projectId, projectTrash.hlc));
    }
    if (cascade) {
      const [projects, tasks] = await Promise.all([loadProjectGraph(env, user.id), loadTaskGraph(env, user.id)]);
      const targets = cascadeTargets(
        change.entity as "task" | "project",
        change.id,
        cascade.batchId,
        cascade.action,
        projects,
        tasks,
      );
      const cascadeClock = nextHlc(
        "server",
        nowMs,
        maxHlc(cascade.hlc, targets.latestHlc),
      );
      if (change.entity === "project" && (targets.projectIds.length || cascade.action === "delete")) {
        statements.push(
          cascadeUpdateStatement(
            env,
            "projects",
            user.id,
            cascade.action,
            cascade.batchId,
            cascade.deletedAt,
            cascadeClock,
            change.id,
          ),
        );
      }
      if (change.entity === "task") {
        statements.push(taskChildrenCascadeStatement(
          env, user.id, change.id, cascade.action, cascade.batchId, cascade.deletedAt, cascadeClock,
        ));
      } else if (change.entity === "project" && (targets.taskIds.length || cascade.action === "delete")) {
        statements.push(cascadeUpdateStatement(
          env,
          "tasks",
          user.id,
          cascade.action,
          cascade.batchId,
          cascade.deletedAt,
          cascadeClock,
          change.id,
        ));
      }
    }
  }
  if (recurrenceOccurrence) {
    statements.push(...recurringTaskStatements(env, user.id, change.id, recurrenceOccurrence.id, recurrenceOccurrence.fields, recurrenceOccurrence.hlc));
  }
  statements.push(appliedChangeStatement(env, user.id, change.change_id, now));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (change.entity === "project" && fields.parent_id) {
      const reason = ["project_cycle", "project_depth_exceeded", "parent_not_found", "parent_deleted"]
        .find((candidate) => message.includes(candidate));
      if (reason) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "project",
            id: change.id,
            reason,
            current: { entity: "project", ...(await readProject(env, user.id, change.id) ?? defaultProject(change.id)) },
          },
        };
      }
    }
    if (change.entity === "task" && fields.parent_task_id) {
      const reason = ["subtask_cannot_be_parent", "task_with_subtasks_cannot_be_subtask", "parent_task_not_found"]
        .find((candidate) => message.includes(candidate));
      if (reason) {
        return {
          rejected: {
            change_id: change.change_id,
            entity: "task",
            id: change.id,
            reason,
            current: { entity: "task", ...(await readTask(env, user.id, change.id) ?? defaultTask(change.id, now)) },
          },
        };
      }
    }
    throw error;
  }
  if (lostFields) {
    const updatedCurrent = change.entity === "task"
      ? await readTask(env, user.id, change.id)
      : change.entity === "project"
        ? await readProject(env, user.id, change.id)
        : change.entity === "tag"
          ? await readTag(env, user.id, change.id)
          : change.entity === "task_tag"
            ? await readTaskTag(env, user.id, change.id)
            : await readSettings(env, user);
    const fallback = change.entity === "task" ? defaultTask(change.id, now)
      : change.entity === "project" ? defaultProject(change.id)
        : change.entity === "tag" ? defaultTag(change.id)
          : change.entity === "task_tag" ? defaultTaskTag(change.id) : defaultSettings();
    return {
      rejected: {
        change_id: change.change_id,
        entity: change.entity,
        id: change.id,
        reason: requestedFields.every((field) => !(field in changedFields)) ? "no_fields_applied" : "field_conflict",
        current: { entity: change.entity, ...(updatedCurrent ?? fallback) } as SyncRow,
      } as RejectedChange,
    };
  }
  return {};
}

export async function handleSyncRequest(
  env: SyncEnv,
  user: UserRow,
  body: unknown,
): Promise<{ status: 200 | 400; body: SyncResponse | { error: string } }> {
  let request: ParsedSyncRequest;
  try {
    request = parseSyncRequest(body);
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const currentUser = await env.DB.prepare("SELECT seq_counter, tombstone_floor_seq FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ seq_counter: number; tombstone_floor_seq: number }>();
  if (!currentUser || request.since > currentUser.seq_counter) {
    return { status: 400, body: { error: "invalid_cursor" } };
  }

  let pageToken: PageToken | null = null;
  if (request.page !== undefined) {
    pageToken = decodePageToken(request.page);
    if (
      !pageToken ||
      pageToken.since !== request.since ||
      (request.upto !== undefined && request.upto !== pageToken.upto) ||
      pageToken.upto > currentUser.seq_counter ||
      request.changes.length > 0
    ) {
      return { status: 400, body: { error: "invalid_page" } };
    }
  } else if (request.upto !== undefined) {
    return { status: 400, body: { error: "invalid_page" } };
  }

  const rejected: RejectedChange[] = [];
  const immediateTombstones: Tombstone[] = [];
  let upto: number;
  let fullResync: boolean;
  if (pageToken) {
    upto = pageToken.upto;
    fullResync = pageToken.full;
  } else {
    for (const change of request.changes) {
      const result = await applyChange(env, user, change);
      if (result.rejected) rejected.push(result.rejected);
      if (result.tombstone) immediateTombstones.push(result.tombstone);
    }
    const updatedUser = await env.DB.prepare("SELECT seq_counter, tombstone_floor_seq FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ seq_counter: number; tombstone_floor_seq: number }>();
    if (!updatedUser) throw new Error("Authenticated user missing from database");
    upto = updatedUser.seq_counter;
    // shortcut: Tombstones older than 180 days no longer block stale writes; upgrade if long-offline devices must never resurrect purged IDs.
    fullResync = request.since < updatedUser.tombstone_floor_seq;
  }

  const cursor = pageToken?.cursor;
  const baseFilter = fullResync ? "seq >= 0" : "seq > ?";
  const baseParams: unknown[] = fullResync ? [] : [request.since];
  let cursorFilter = "";
  const cursorParams: unknown[] = [];
  if (cursor) {
    cursorFilter = ` AND (seq > ? OR (seq = ? AND (entity > ? COLLATE BINARY OR (entity = ? AND id > ? COLLATE BINARY))))`;
    cursorParams.push(cursor.seq, cursor.seq, cursor.entity, cursor.entity, cursor.id);
  }
  const tombstoneSelect = fullResync
    ? ""
    : ` UNION ALL
       SELECT entity, 'tombstone' AS kind, id, seq, NULL AS payload, purged_at
       FROM tombstones WHERE user_id = ?`;
  const tombstoneParams = fullResync ? [] : [user.id];
  const sql = `SELECT entity, kind, id, seq, payload, purged_at FROM (
    SELECT * FROM (
      SELECT 'task' AS entity, 'row' AS kind, id, seq,
        json_object('id', id, 'project_id', project_id, 'parent_task_id', parent_task_id,
          'recurrence', json(recurrence), 'title', title, 'note', note, 'done', done,
          'due_date', due_date, 'due_time', due_time, 'priority', priority, 'created_at', created_at,
          'deleted_at', deleted_at, 'deleted_batch_id', deleted_batch_id, 'field_ts', json(field_ts), 'seq', seq) AS payload,
        NULL AS purged_at
      FROM tasks WHERE user_id = ?
      UNION ALL
      SELECT 'project' AS entity, 'row' AS kind, id, seq,
        json_object('id', id, 'parent_id', parent_id, 'name', name, 'deleted_at', deleted_at,
          'deleted_batch_id', deleted_batch_id, 'field_ts', json(field_ts), 'seq', seq) AS payload,
        NULL AS purged_at
      FROM projects WHERE user_id = ?
      UNION ALL
      SELECT 'tag' AS entity, 'row' AS kind, id, seq,
        json_object('id', id, 'name', name, 'deleted_at', deleted_at, 'field_ts', json(field_ts), 'seq', seq) AS payload,
        NULL AS purged_at
      FROM tags WHERE user_id = ?
      UNION ALL
      SELECT 'task_tag' AS entity, 'row' AS kind, id, seq,
        json_object('id', id, 'task_id', task_id, 'tag_id', tag_id, 'active', active,
          'field_ts', json(field_ts), 'seq', seq) AS payload,
        NULL AS purged_at
      FROM task_tags WHERE user_id = ?
      UNION ALL
      SELECT 'settings' AS entity, 'row' AS kind, id, settings_seq AS seq,
        json_object('timezone', timezone, 'locale', locale, 'digest_time', digest_time,
          'field_ts', json(field_ts), 'seq', settings_seq) AS payload,
        NULL AS purged_at
      FROM users WHERE id = ?
    )
    ${tombstoneSelect}
    ) WHERE ${baseFilter} AND seq <= ?${cursorFilter}
    ORDER BY seq, entity COLLATE BINARY, id COLLATE BINARY LIMIT ?`;
  const pageRows = await env.DB.prepare(sql)
    .bind(
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      ...tombstoneParams,
      ...baseParams,
      upto,
      ...cursorParams,
      PAGE_SIZE + 1,
    )
    .all<VersionedPageRow>();
  const hasMore = pageRows.results.length > PAGE_SIZE;
  const selected = pageRows.results.slice(0, PAGE_SIZE);
  const rows: SyncRow[] = [];
  const pulledTombstones: Tombstone[] = [];
  for (const item of selected) {
    if (item.kind === "tombstone") {
      if (item.purged_at !== null) {
        pulledTombstones.push({ entity: item.entity as Tombstone["entity"], id: item.id, seq: item.seq, purged_at: item.purged_at });
      }
      continue;
    }
    if (!item.payload) continue;
    const value: unknown = JSON.parse(item.payload);
    if (!isRecord(value)) continue;
    if (item.entity === "task") rows.push({ entity: "task", ...(value as unknown as Task), done: value.done === 1 });
    else if (item.entity === "project") rows.push({ entity: "project", ...(value as unknown as Project) });
    else if (item.entity === "tag") rows.push({ entity: "tag", ...(value as unknown as Tag) });
    else if (item.entity === "task_tag") rows.push({ entity: "task_tag", ...(value as unknown as TaskTag), active: value.active === 1 });
    else if (item.entity === "settings") rows.push({ entity: "settings", ...(value as unknown as UserSettingsState) });
  }
  const tombstoneMap = new Map<string, Tombstone>();
  for (const tombstone of [...pulledTombstones, ...immediateTombstones]) {
    tombstoneMap.set(`${tombstone.entity}:${tombstone.id}`, tombstone);
  }
  const last = selected.at(-1);
  const nextPage = hasMore && last
    ? encodePageToken({
        since: request.since,
        upto,
        full: fullResync,
        cursor: { seq: last.seq, entity: last.entity, id: last.id },
      })
    : undefined;
  return {
    status: 200,
    body: {
      upto,
      ...(nextPage ? { next_page: nextPage } : {}),
      rows,
      tombstones: [...tombstoneMap.values()],
      rejected,
      ...(fullResync ? { full_resync: true } : {}),
    },
  };
}

export async function updateSettings(
  env: SyncEnv,
  user: UserRow,
  body: unknown,
): Promise<{ status: 200 | 400 | 409; body: unknown }> {
  if (!isRecord(body)) return { status: 400, body: { error: "invalid_request" } };
  let change: LooseChange;
  try {
    change = parseChange({
      change_id: body.change_id,
      entity: "settings",
      id: SETTINGS_ID,
      fields: body.fields,
    });
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const result = await applyChange(env, user, change);
  if (result.rejected) return { status: 409, body: { error: "change_rejected", rejected: result.rejected } };
  return { status: 200, body: await readSettings(env, user) };
}

export async function readUserSettings(env: SyncEnv, user: UserRow): Promise<UserSettingsState> {
  return readSettings(env, user);
}

async function taskTagDeactivationStatements(
  env: SyncEnv,
  userId: string,
  target: { entity: "task" | "project" | "tag"; id: string },
  now: string,
): Promise<D1PreparedStatement[]> {
  if (target.entity === "project") return [];
  const column = target.entity === "task" ? "task_id" : "tag_id";
  const rows = await env.DB.prepare(
    `SELECT id, active, field_ts FROM task_tags WHERE user_id = ? AND ${column} = ? AND active = 1`,
  ).bind(userId, target.id).all<{ id: string; active: number; field_ts: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const current = parseFieldTs<TaskTagFields>(row.field_ts).active;
    const hlc = nextHlc("server", Date.parse(now), current ?? null);
    statements.push(env.DB.prepare("UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ?").bind(userId));
    statements.push(updateVersionedRow(env, "task_tags", userId, row.id, { active: { v: false, hlc } }));
  }
  return statements;
}

export async function purgeTrashEntity(
  env: SyncEnv,
  user: UserRow,
  body: unknown,
): Promise<{ status: 200 | 400 | 409; body: { ok: true } | { error: string } }> {
  if (
    !isRecord(body) ||
    !isUuid(body.change_id) ||
    (body.entity !== "task" && body.entity !== "project" && body.entity !== "tag") ||
    !isUuid(body.id) ||
    (body.batch_id !== undefined && body.batch_id !== null && !isUuid(body.batch_id)) ||
    (body.entity !== "project" && body.batch_id !== undefined)
  ) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const entity = body.entity;
  const table = entity === "task" ? "tasks" : entity === "project" ? "projects" : "tags";
  const changeId = body.change_id;
  const id = body.id;
  const requestedBatchId = entity === "project" ? body.batch_id as string | null | undefined : undefined;
  if (await wasApplied(env, user.id, changeId)) return { status: 200, body: { ok: true } };

  const selected = await env.DB.prepare(
    `SELECT deleted_at, ${entity === "tag" ? "NULL" : "deleted_batch_id"} AS deleted_batch_id FROM ${table} WHERE user_id = ? AND id = ?`,
  ).bind(user.id, id).first<{ deleted_at: string | null; deleted_batch_id: string | null }>();
  if (selected?.deleted_at === null) return { status: 409, body: { error: "not_in_trash" } };
  if (selected && requestedBatchId !== undefined && requestedBatchId !== selected.deleted_batch_id) {
    return { status: 409, body: { error: "trash_batch_changed" } };
  }
  if (!selected && (entity !== "project" || !requestedBatchId || !(await getTombstone(env, user.id, "project", id)))) {
    await env.DB.batch([appliedChangeStatement(env, user.id, changeId, new Date().toISOString())]);
    return { status: 200, body: { ok: true } };
  }
  const batchId = selected?.deleted_batch_id ?? requestedBatchId ?? null;
  const targetRows: { entity: "task" | "project" | "tag"; id: string; batchId: string | null }[] = [];
  if (entity === "project" && batchId !== null) {
    for (const target of ["project", "task"] as const) {
      const targetTable = target === "project" ? "projects" : "tasks";
      const rows = await env.DB.prepare(
        `SELECT id FROM ${targetTable} WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_batch_id = ? ORDER BY id`,
      ).bind(user.id, batchId).all<{ id: string }>();
      targetRows.push(...rows.results.map((row) => ({ entity: target, id: row.id, batchId })));
    }
  } else {
    targetRows.push({ entity, id, batchId });
    if (entity === "task" && batchId !== null) {
      const children = await env.DB.prepare(
        "SELECT id FROM tasks WHERE user_id = ? AND parent_task_id = ? AND deleted_at IS NOT NULL AND deleted_batch_id = ? ORDER BY id",
      ).bind(user.id, id, batchId).all<{ id: string }>();
      targetRows.push(...children.results.map((row) => ({ entity: "task" as const, id: row.id, batchId })));
    }
  }

  const purgedAt = new Date().toISOString();
  for (let offset = 0; offset < targetRows.length; offset += 30) {
    const chunk = targetRows.slice(offset, offset + 30);
    const statements: D1PreparedStatement[] = [];
    for (const target of chunk) {
      statements.push(...await taskTagDeactivationStatements(env, user.id, target, purgedAt));
      const targetTable = target.entity === "task" ? "tasks" : target.entity === "project" ? "projects" : "tags";
      const trashCondition = target.entity === "tag" ? "deleted_at IS NOT NULL" : "deleted_at IS NOT NULL AND deleted_batch_id IS ?";
      const trashValues = target.entity === "tag" ? [] : [target.batchId];
      statements.push(env.DB.prepare(
        `UPDATE users SET seq_counter = seq_counter + 1 WHERE id = ? AND EXISTS (
          SELECT 1 FROM ${targetTable} WHERE user_id = ? AND id = ? AND ${trashCondition}
        )`,
      ).bind(user.id, user.id, target.id, ...trashValues));
      statements.push(env.DB.prepare(
        `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
         SELECT ?, ?, ?, ?, seq_counter FROM users WHERE id = ? AND EXISTS (
           SELECT 1 FROM ${targetTable} WHERE user_id = ? AND id = ? AND ${trashCondition}
         ) ON CONFLICT(user_id, entity, id) DO UPDATE SET purged_at = excluded.purged_at, seq = excluded.seq`,
      ).bind(user.id, target.entity, target.id, purgedAt, user.id, user.id, target.id, ...trashValues));
      statements.push(env.DB.prepare(
        `DELETE FROM ${targetTable} WHERE user_id = ? AND id = ? AND ${trashCondition}`,
      ).bind(user.id, target.id, ...trashValues));
    }
    if (offset + chunk.length === targetRows.length) statements.push(appliedChangeStatement(env, user.id, changeId, purgedAt));
    await env.DB.batch(statements);
  }
  if (targetRows.length === 0) await env.DB.batch([appliedChangeStatement(env, user.id, changeId, purgedAt)]);
  return { status: 200, body: { ok: true } };
}

export async function purgeExpiredData(env: SyncEnv, now = new Date()): Promise<void> {
  const purgedAt = now.toISOString();
  const deletedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const tombstoneCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const changesCutoff = deletedCutoff;

  for (const entity of ["task", "project", "tag"] as const) {
    const table = entity === "task" ? "tasks" : entity === "project" ? "projects" : "tags";
    const expired = await env.DB.prepare(
      `SELECT user_id, id FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY user_id, id`,
    )
      .bind(deletedCutoff)
      .all<{ user_id: string; id: string }>();
    for (let offset = 0; offset < expired.results.length; offset += 30) {
      const chunk = expired.results.slice(offset, offset + 30);
      const statements: D1PreparedStatement[] = [];
      for (const row of chunk) {
        statements.push(...await taskTagDeactivationStatements(env, row.user_id, { entity, id: row.id }, purgedAt));
        statements.push(
          env.DB.prepare(
            `UPDATE users SET seq_counter = seq_counter + 1
             WHERE id = ? AND EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at < ?)`,
          ).bind(row.user_id, row.user_id, row.id, deletedCutoff),
        );
        statements.push(
          env.DB.prepare(
            `INSERT INTO tombstones (user_id, entity, id, purged_at, seq)
             SELECT ?, ?, ?, ?, seq_counter FROM users WHERE id = ?
               AND EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at < ?)
             ON CONFLICT(user_id, entity, id) DO UPDATE SET purged_at = excluded.purged_at, seq = excluded.seq`,
          ).bind(row.user_id, entity, row.id, purgedAt, row.user_id, row.user_id, row.id, deletedCutoff),
        );
        statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ? AND deleted_at < ?`).bind(row.user_id, row.id, deletedCutoff));
      }
      await env.DB.batch(statements);
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET tombstone_floor_seq = MAX(tombstone_floor_seq, seq_counter + 1),
        seq_counter = seq_counter + 1
       WHERE EXISTS (SELECT 1 FROM tombstones WHERE user_id = users.id AND purged_at < ?)`,
    ).bind(tombstoneCutoff),
    env.DB.prepare("DELETE FROM tombstones WHERE purged_at < ?").bind(tombstoneCutoff),
    env.DB.prepare("DELETE FROM applied_changes WHERE applied_at < ?").bind(changesCutoff),
  ]);
}

export async function requestBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    throw new RangeError("request too large");
  }

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("") as unknown;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size limit still takes precedence if cancellation fails.
        }
        throw new RangeError("request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function asSyncChange(change: LooseChange): SyncChange {
  return change as unknown as SyncChange;
}
