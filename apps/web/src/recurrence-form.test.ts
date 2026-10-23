import { describe, expect, it } from "vitest";
import { sameRecurrence, weeklyRecurrenceNeedsWeekday } from "./recurrence-form";

describe("weekly recurrence form validation", () => {
  it("requires at least one weekday only for weekly recurrence", () => {
    expect(weeklyRecurrenceNeedsWeekday("weekly", [])).toBe(true);
    expect(weeklyRecurrenceNeedsWeekday("weekly", [1])).toBe(false);
    expect(weeklyRecurrenceNeedsWeekday("daily", [])).toBe(false);
    expect(weeklyRecurrenceNeedsWeekday("none", [])).toBe(false);
  });

  it("compares recurrence rules independent of weekday and object key order", () => {
    expect(
      sameRecurrence(
        { frequency: "weekly", weekdays: [3, 1] },
        { weekdays: [1, 3], frequency: "weekly" },
      ),
    ).toBe(true);
    expect(
      sameRecurrence(
        { frequency: "weekly", weekdays: [1, 3] },
        { frequency: "weekly", weekdays: [1, 2] },
      ),
    ).toBe(false);
  });
});
