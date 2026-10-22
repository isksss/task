import { describe, expect, it } from "vitest";
import { weeklyRecurrenceNeedsWeekday } from "./recurrence-form";

describe("weekly recurrence form validation", () => {
  it("requires at least one weekday only for weekly recurrence", () => {
    expect(weeklyRecurrenceNeedsWeekday("weekly", [])).toBe(true);
    expect(weeklyRecurrenceNeedsWeekday("weekly", [1])).toBe(false);
    expect(weeklyRecurrenceNeedsWeekday("daily", [])).toBe(false);
    expect(weeklyRecurrenceNeedsWeekday("none", [])).toBe(false);
  });
});
