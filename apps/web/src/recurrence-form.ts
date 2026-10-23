import type { Recurrence } from "@task/shared";

export function weeklyRecurrenceNeedsWeekday(frequency: string, weekdays: number[]): boolean {
  return frequency === "weekly" && weekdays.length === 0;
}

function normalizeRecurrence(recurrence: Recurrence | null): Recurrence | null {
  if (!recurrence) return null;
  if (recurrence.frequency === "weekly") {
    return { frequency: "weekly", weekdays: [...recurrence.weekdays].sort((a, b) => a - b) };
  }
  if (recurrence.frequency === "monthly") {
    return { frequency: "monthly", day: recurrence.day };
  }
  return { frequency: recurrence.frequency };
}

export function sameRecurrence(left: Recurrence | null, right: Recurrence | null): boolean {
  return JSON.stringify(normalizeRecurrence(left)) === JSON.stringify(normalizeRecurrence(right));
}
