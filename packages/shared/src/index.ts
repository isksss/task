export type Priority = 0 | 1 | 2 | 3;
export type Locale = "ja" | "en";
export type SyncEntity = "task" | "project" | "settings";

export interface Hlc {
  ts: number;
  counter: number;
  device_id: string;
}

export type FieldTimestamps<T extends object> = Partial<{ [K in keyof T]: Hlc }>;
export type VersionedFields<T extends object> = Partial<{
  [K in keyof T]: { v: T[K]; hlc: Hlc };
}>;

export interface TaskFields {
  project_id: string | null;
  title: string;
  note: string;
  done: boolean;
  due_date: string | null;
  due_time: string | null;
  priority: Priority;
  created_at: string;
  deleted_at: string | null;
  deleted_batch_id: string | null;
}

export interface Task extends TaskFields {
  id: string;
  field_ts: FieldTimestamps<TaskFields>;
  seq: number;
}

export interface ProjectFields {
  parent_id: string | null;
  name: string;
  deleted_at: string | null;
  deleted_batch_id: string | null;
}

export interface Project extends ProjectFields {
  id: string;
  field_ts: FieldTimestamps<ProjectFields>;
  seq: number;
}

export interface UserSettings {
  timezone: string;
  locale: Locale;
  digest_time: string;
}

export interface UserSettingsState extends UserSettings {
  field_ts: FieldTimestamps<UserSettings>;
  seq: number;
}

export type TaskChange = {
  change_id: string;
  entity: "task";
  id: string;
  fields: VersionedFields<TaskFields>;
};

export type ProjectChange = {
  change_id: string;
  entity: "project";
  id: string;
  fields: VersionedFields<ProjectFields>;
};

export type SettingsChange = {
  change_id: string;
  entity: "settings";
  id: string;
  fields: VersionedFields<UserSettings>;
};

export type SyncChange = TaskChange | ProjectChange | SettingsChange;

export interface SyncRequest {
  since: number;
  upto?: number;
  page?: string;
  changes: SyncChange[];
}

export type SyncRow =
  | ({ entity: "task" } & Task)
  | ({ entity: "project" } & Project)
  | ({ entity: "settings" } & UserSettingsState);

export interface Tombstone {
  entity: "task" | "project";
  id: string;
  purged_at: string;
  seq: number;
}

export type RejectedChange = {
  change_id: string;
  id: string;
  reason: string;
} & (
  | { entity: "task"; current: Extract<SyncRow, { entity: "task" }> }
  | { entity: "project"; current: Extract<SyncRow, { entity: "project" }> }
  | { entity: "settings"; current: Extract<SyncRow, { entity: "settings" }> }
);

export interface SyncResponse {
  upto: number;
  next_page?: string;
  rows: SyncRow[];
  tombstones: Tombstone[];
  rejected: RejectedChange[];
  full_resync?: boolean;
}

export const MAX_TITLE_LENGTH = 500;
export const MAX_NOTE_LENGTH = 20_000;
export const MAX_PROJECT_DEPTH = 3;
export const MAX_SYNC_CHANGES_PER_REQUEST = 100;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const HLC_NUMBER_WIDTH = String(MAX_SAFE_INTEGER).length;

function assertHlc(hlc: Hlc): void {
  if (
    !Number.isSafeInteger(hlc.ts) ||
    hlc.ts < 0 ||
    !Number.isSafeInteger(hlc.counter) ||
    hlc.counter < 0 ||
    typeof hlc.device_id !== "string" ||
    hlc.device_id.length === 0
  ) {
    throw new RangeError("Invalid HLC");
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("Timestamp must be a non-negative safe integer");
  }
}

/** Generate the next local HLC, incorporating the local and received clocks. */
export function nextHlc(
  deviceId: string,
  now = Date.now(),
  local: Hlc | null = null,
  received: Hlc | null = null,
): Hlc {
  assertTimestamp(now);
  if (deviceId.length === 0) throw new RangeError("deviceId must not be empty");
  if (local) assertHlc(local);
  if (received) assertHlc(received);

  const ts = Math.max(now, local?.ts ?? 0, received?.ts ?? 0);
  let counter = 0;
  if (local?.ts === ts && received?.ts === ts) {
    counter = Math.max(local.counter, received.counter) + 1;
  } else if (local?.ts === ts) {
    counter = local.counter + 1;
  } else if (received?.ts === ts) {
    counter = received.counter + 1;
  }
  if (!Number.isSafeInteger(counter)) throw new RangeError("HLC counter overflow");
  return { ts, counter, device_id: deviceId };
}

/** Compare by (ts, counter, device_id), without locale-dependent ordering. */
export function compareHlc(a: Hlc, b: Hlc): number {
  assertHlc(a);
  assertHlc(b);
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.device_id === b.device_id ? 0 : a.device_id < b.device_id ? -1 : 1;
}

/** Encode an HLC so ordinary string comparison preserves tuple ordering. */
export function encodeHlc(hlc: Hlc): string {
  assertHlc(hlc);
  const pad = (value: number) => String(value).padStart(HLC_NUMBER_WIDTH, "0");
  return `${pad(hlc.ts)}:${pad(hlc.counter)}:${hlc.device_id}`;
}

export function decodeHlc(encoded: string): Hlc {
  const match = /^(\d{16}):(\d{16}):([\s\S]+)$/.exec(encoded);
  if (!match) throw new RangeError("Invalid encoded HLC");
  const hlc = { ts: Number(match[1]), counter: Number(match[2]), device_id: match[3] };
  assertHlc(hlc);
  if (encodeHlc(hlc) !== encoded) throw new RangeError("Invalid encoded HLC");
  return hlc;
}

export const HLC_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Clamp future clocks; pass the field's current HLC so clamped updates advance past it. */
export function clampFutureHlc(hlc: Hlc, serverNow = Date.now(), existing?: Hlc): Hlc {
  assertHlc(hlc);
  assertTimestamp(serverNow);
  if (hlc.ts - serverNow <= HLC_FUTURE_TOLERANCE_MS) return { ...hlc };
  return existing ? nextHlc(hlc.device_id, serverNow, existing) : { ...hlc, ts: serverNow };
}

/** Apply incoming fields independently; fields with equal HLC retain the current value. */
export function mergeLww<T extends object>(
  current: T,
  fieldTs: FieldTimestamps<T>,
  incoming: VersionedFields<T>,
): { value: T; field_ts: FieldTimestamps<T> } {
  const value = { ...current };
  const field_ts = { ...fieldTs };
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (!Object.hasOwn(current, key)) continue;
    const update = incoming[key];
    if (!update) continue;
    const existing = field_ts[key];
    if (!existing || compareHlc(update.hlc, existing) > 0) {
      value[key] = update.v;
      field_ts[key] = update.hlc;
    }
  }
  return { value, field_ts };
}

export type ClockInput = Date | number;

function epochOf(value: ClockInput): number {
  const epoch = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(epoch) || !Number.isFinite(new Date(epoch).getTime())) {
    throw new RangeError("Invalid clock value");
  }
  return epoch;
}

function makeUtcEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function dateParts(formatter: Intl.DateTimeFormat, epoch: number): {
  year: number;
  month: number;
  day: number;
} {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epoch)).map(({ type, value }) => [type, value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function wallParts(formatter: Intl.DateTimeFormat, epoch: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epoch)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function formatDate(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function todayInTimeZone(now: ClockInput, timeZone: string): string {
  return formatDate(dateParts(dateFormatter(timeZone), epochOf(now)));
}

function parseWallClock(date: string, time: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  epoch: number;
} {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) throw new RangeError("Expected date YYYY-MM-DD and time HH:mm");
  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const epoch = makeUtcEpoch(year, month, day, hour, minute);
  const check = new Date(epoch);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw new RangeError("Invalid wall-clock date or time");
  }
  return { year, month, day, hour, minute, epoch };
}

function sameWallMinute(
  formatter: Intl.DateTimeFormat,
  epoch: number,
  wanted: { year: number; month: number; day: number; hour: number; minute: number },
): boolean {
  const actual = wallParts(formatter, epoch);
  return (
    actual.year === wanted.year &&
    actual.month === wanted.month &&
    actual.day === wanted.day &&
    actual.hour === wanted.hour &&
    actual.minute === wanted.minute
  );
}

/**
 * Convert a local wall-clock minute to an instant. Gaps move to the next valid
 * minute; overlaps choose the earlier instant.
 */
export function wallClockToInstant(date: string, time: string, timeZone: string): Date {
  const wanted = parseWallClock(date, time);
  const formatter = clockFormatter(timeZone);
  const offsets = new Set<number>();
  // shortcut: search is bounded to 48 hours; extend if timezone data adds longer jumps.
  const SEARCH_RADIUS = 48 * 60 * 60 * 1000;
  const OFFSET_SAMPLE_STEP = 3 * 60 * 60 * 1000;
  for (let delta = -SEARCH_RADIUS; delta <= SEARCH_RADIUS; delta += OFFSET_SAMPLE_STEP) {
    const sample = wanted.epoch + delta;
    const local = wallParts(formatter, sample);
    const localAsUtc = makeUtcEpoch(
      local.year,
      local.month,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    offsets.add(localAsUtc - sample);
  }

  for (let delta = 0; delta <= SEARCH_RADIUS; delta += 60_000) {
    const target = wanted.epoch + delta;
    const nextWall = new Date(target);
    const candidateWall = {
      year: nextWall.getUTCFullYear(),
      month: nextWall.getUTCMonth() + 1,
      day: nextWall.getUTCDate(),
      hour: nextWall.getUTCHours(),
      minute: nextWall.getUTCMinutes(),
    };
    let earliest: number | undefined;
    for (const offset of offsets) {
      const candidate = target - offset;
      if (sameWallMinute(formatter, candidate, candidateWall)) {
        earliest = earliest === undefined ? candidate : Math.min(earliest, candidate);
      }
    }
    if (earliest !== undefined) return new Date(earliest);
  }
  throw new RangeError("No valid wall-clock time found within 48 hours");
}

export function isTaskDueToday(
  task: Pick<TaskFields, "due_date">,
  now: ClockInput,
  timeZone: string,
): boolean {
  return task.due_date !== null && task.due_date === todayInTimeZone(now, timeZone);
}

export function isTaskOverdue(
  task: Pick<TaskFields, "due_date" | "due_time">,
  now: ClockInput,
  timeZone: string,
): boolean {
  if (task.due_date === null) return false;
  const today = todayInTimeZone(now, timeZone);
  if (task.due_date < today) return true;
  if (task.due_date > today || task.due_time === null) return false;
  return wallClockToInstant(task.due_date, task.due_time, timeZone).getTime() < epochOf(now);
}

export type TaskSort = "due" | "priority" | "created";

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareCreated(a: Task, b: Task): number {
  return compareText(a.created_at, b.created_at) || compareText(a.id, b.id);
}

export function compareTasksByDue(a: Task, b: Task): number {
  if (a.due_date === null || b.due_date === null) {
    if (a.due_date !== b.due_date) return a.due_date === null ? 1 : -1;
  } else {
    const dateOrder = compareText(a.due_date, b.due_date);
    if (dateOrder !== 0) return dateOrder;
    const timeOrder = compareText(a.due_time ?? "", b.due_time ?? "");
    if (timeOrder !== 0) return timeOrder;
  }
  return compareCreated(a, b);
}

export function compareTasksByPriority(a: Task, b: Task): number {
  return b.priority - a.priority || compareCreated(a, b);
}

export function compareTasksByCreated(a: Task, b: Task): number {
  return compareCreated(a, b);
}

export function compareTasks(a: Task, b: Task, sort: TaskSort): number {
  switch (sort) {
    case "due":
      return compareTasksByDue(a, b);
    case "priority":
      return compareTasksByPriority(a, b);
    case "created":
      return compareTasksByCreated(a, b);
  }
}
