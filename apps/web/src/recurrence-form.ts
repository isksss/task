export function weeklyRecurrenceNeedsWeekday(frequency: string, weekdays: number[]): boolean {
  return frequency === "weekly" && weekdays.length === 0;
}
