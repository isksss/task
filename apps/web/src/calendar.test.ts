import { describe, expect, it } from "vitest";
import { todayInTimeZone } from "@task/shared";
import {
  firstDayOfWeek,
  getMonthGridDates,
  getWeekDates,
  shiftCalendarDate,
  shiftCalendarMonth,
} from "./calendar";

describe("calendar date grids", () => {
  it("builds a complete Sunday-first month grid across month boundaries", () => {
    const dates = getMonthGridDates("2024-02", 0);
    expect(dates).toHaveLength(35);
    expect(dates[0]).toBe("2024-01-28");
    expect(dates.at(-1)).toBe("2024-03-02");
    expect(dates[4]).toBe("2024-02-01");
  });

  it("builds locale-start weeks and shifts across month ends safely", () => {
    expect(firstDayOfWeek("ja")).toBe(0);
    expect(getWeekDates("2024-01-01", 0)).toEqual([
      "2023-12-31",
      "2024-01-01",
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-06",
    ]);
    expect(shiftCalendarDate("2024-02-28", 2)).toBe("2024-03-01");
    expect(shiftCalendarMonth("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("uses the configured timezone to select the calendar month", () => {
    const date = todayInTimeZone(new Date("2024-03-31T23:30:00.000Z"), "Asia/Tokyo");
    expect(date).toBe("2024-04-01");
    expect(getMonthGridDates(date.slice(0, 7), 0)).toContain(date);
  });
});
