import { describe, expect, it } from "vitest";
import {
  clampFutureHlc,
  compareHlc,
  compareTasksByCreated,
  compareTasksByDue,
  compareTasksByPriority,
  decodeHlc,
  encodeHlc,
  isTaskDueToday,
  isTaskOverdue,
  isValidRecurrence,
  mergeLww,
  nextHlc,
  nextRecurrenceDate,
  recurringTaskId,
  type Hlc,
  type Task,
  type TaskFields,
  wallClockToInstant,
} from "./index";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task",
  project_id: null,
  parent_task_id: null,
  recurrence: null,
  title: "Task",
  note: "",
  done: false,
  due_date: null,
  due_time: null,
  priority: 0,
  created_at: "2024-01-01T00:00:00.000Z",
  deleted_at: null,
  deleted_batch_id: null,
  field_ts: {},
  seq: 1,
  ...overrides,
});

const hlc = (ts: number, counter: number, device_id: string): Hlc => ({
  ts,
  counter,
  device_id,
});

describe("HLC", () => {
  it("merges local and received clocks and preserves tuple order when encoded", () => {
    const local = hlc(100, 3, "a");
    const received = hlc(100, 5, "z");
    expect(nextHlc("b", 90, local, received)).toEqual(hlc(100, 6, "b"));

    const earlier = hlc(100, 5, "a");
    const later = hlc(100, 5, "b");
    expect(compareHlc(earlier, later)).toBeLessThan(0);
    expect(encodeHlc(earlier) < encodeHlc(later)).toBe(true);
    expect(encodeHlc(hlc(99, 10, "a")) < encodeHlc(hlc(100, 0, "a"))).toBe(true);
    expect(encodeHlc(hlc(100, 9, "a")) < encodeHlc(hlc(100, 10, "a"))).toBe(true);
    expect(decodeHlc(encodeHlc(later))).toEqual(later);
  });

  it("rejects non-ASCII device IDs", () => {
    expect(() => encodeHlc(hlc(1, 0, "端末"))).toThrow(RangeError);
    expect(() => nextHlc("端末")).toThrow(RangeError);
  });

  it("clamps only clocks more than five minutes ahead to server time", () => {
    expect(clampFutureHlc(hlc(400_001, 2, "a"), 100_000)).toEqual(hlc(100_000, 2, "a"));
    expect(clampFutureHlc(hlc(400_000, 2, "a"), 100_000)).toEqual(hlc(400_000, 2, "a"));
  });

  it("advances repeated clamped updates past the existing field version", () => {
    const serverNow = 100_000;
    const futureClock = hlc(400_001, 2, "a");
    const first = clampFutureHlc(futureClock, serverNow);
    const afterFirst = mergeLww({ title: "before" }, {}, { title: { v: "first", hlc: first } });
    const second = clampFutureHlc(futureClock, serverNow, afterFirst.field_ts.title);
    const afterSecond = mergeLww(afterFirst.value, afterFirst.field_ts, {
      title: { v: "second", hlc: second },
    });

    expect(second).toEqual(hlc(serverNow, 3, "a"));
    expect(afterSecond.value.title).toBe("second");
  });
});

describe("field-level LWW", () => {
  it("resolves same-field conflicts by HLC and preserves concurrent fields", () => {
    const current: Pick<TaskFields, "title" | "done"> = { title: "old", done: false };
    const merged = mergeLww(
      current,
      { title: hlc(10, 0, "a") },
      {
        title: { v: "new", hlc: hlc(10, 0, "b") },
        done: { v: true, hlc: hlc(9, 0, "c") },
      },
    );

    expect(merged).toEqual({
      value: { title: "new", done: true },
      field_ts: { title: hlc(10, 0, "b"), done: hlc(9, 0, "c") },
    });
  });

  it("keeps deletion independent from edits and rejects an older deletion", () => {
    const current: { title: string; deleted_at: string | null } = {
      title: "current",
      deleted_at: "2024-01-02T00:00:00Z",
    };
    const merged = mergeLww(
      current,
      { title: hlc(20, 0, "a"), deleted_at: hlc(30, 0, "a") },
      {
        title: { v: "edited after delete", hlc: hlc(21, 0, "b") },
        deleted_at: { v: null, hlc: hlc(29, 0, "b") },
      },
    );

    expect(merged.value).toEqual({
      title: "edited after delete",
      deleted_at: "2024-01-02T00:00:00Z",
    });
    expect(merged.field_ts.deleted_at).toEqual(hlc(30, 0, "a"));
  });
});

describe("wall-clock date helpers", () => {
  const now = new Date("2024-01-01T15:30:00.000Z");

  it("calculates today and overdue in the configured timezone", () => {
    expect(isTaskDueToday({ due_date: "2024-01-02" }, now, "Asia/Tokyo")).toBe(true);
    expect(isTaskDueToday({ due_date: "2024-01-02" }, now, "UTC")).toBe(false);
    expect(isTaskOverdue({ due_date: "2024-01-01", due_time: null }, now, "Asia/Tokyo")).toBe(true);
    expect(isTaskOverdue({ due_date: "2024-01-02", due_time: "00:00" }, now, "Asia/Tokyo")).toBe(
      true,
    );
    expect(isTaskOverdue({ due_date: "2024-01-02", due_time: "01:00" }, now, "Asia/Tokyo")).toBe(
      false,
    );
    expect(isTaskOverdue({ due_date: null, due_time: null }, now, "Asia/Tokyo")).toBe(false);
  });

  it("moves nonexistent DST times to the next valid minute", () => {
    expect(
      new Date(wallClockToInstant("2024-03-10", "02:30", "America/New_York")).toISOString(),
    ).toBe("2024-03-10T07:00:00.000Z");
  });

  it("chooses the earlier instant for repeated DST times", () => {
    expect(
      new Date(wallClockToInstant("2024-11-03", "01:30", "America/New_York")).toISOString(),
    ).toBe("2024-11-03T05:30:00.000Z");
  });
});

describe("recurrence helpers", () => {
  it("computes daily and multi-weekday occurrences from the task's due date", () => {
    expect(nextRecurrenceDate("2024-12-31", { frequency: "daily" })).toBe("2025-01-01");
    expect(nextRecurrenceDate("2024-01-01", { frequency: "weekly", weekdays: [1, 3] })).toBe(
      "2024-01-03",
    );
    expect(nextRecurrenceDate("2024-01-03", { frequency: "weekly", weekdays: [1, 3] })).toBe(
      "2024-01-08",
    );
  });

  it("clamps monthly and yearly occurrences to the corresponding month end", () => {
    expect(nextRecurrenceDate("2024-01-31", { frequency: "monthly", day: 31 })).toBe("2024-02-29");
    expect(nextRecurrenceDate("2024-01-10", { frequency: "yearly" })).toBe("2025-01-10");
    expect(nextRecurrenceDate("2024-02-29", { frequency: "yearly" })).toBe("2025-02-28");
    expect(nextRecurrenceDate("2028-02-29", { frequency: "yearly" })).toBe("2029-02-28");
  });

  it("validates recurrence shapes and produces the same occurrence ID deterministically", async () => {
    expect(isValidRecurrence({ frequency: "weekly", weekdays: [1, 7] })).toBe(true);
    expect(isValidRecurrence({ frequency: "weekly", weekdays: [1, 1] })).toBe(false);
    expect(isValidRecurrence({ frequency: "yearly" })).toBe(true);
    expect(isValidRecurrence({ frequency: "yearly", month: 2, day: 29 })).toBe(false);
    const id = await recurringTaskId("7fe3d260-64dc-4db4-83cd-3c4d32b98b1a", "2024-02-29");
    expect(id).toBe(await recurringTaskId("7fe3d260-64dc-4db4-83cd-3c4d32b98b1a", "2024-02-29"));
  });
});

describe("task sorting", () => {
  it("sorts due dates first, places undated tasks last, and breaks ties by creation", () => {
    const tasks = [
      task({ id: "none" }),
      task({ id: "later", due_date: "2024-02-02" }),
      task({ id: "early-late", due_date: "2024-02-01", due_time: "10:00" }),
      task({ id: "early", due_date: "2024-02-01", created_at: "2023-12-01T00:00:00.000Z" }),
    ];
    expect(tasks.sort(compareTasksByDue).map(({ id }) => id)).toEqual([
      "early",
      "early-late",
      "later",
      "none",
    ]);
  });

  it("sorts priority descending and uses stable creation/id tie-breakers", () => {
    const tasks = [
      task({ id: "b", priority: 3, created_at: "2024-01-02T00:00:00.000Z" }),
      task({ id: "a", priority: 3, created_at: "2024-01-01T00:00:00.000Z" }),
      task({ id: "c", priority: 1 }),
    ];
    expect(tasks.sort(compareTasksByPriority).map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(compareTasksByCreated(task({ id: "a" }), task({ id: "b" }))).toBeLessThan(0);
  });
});
