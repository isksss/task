import type { Locale } from "@task/shared";

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Expected date YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return date;
}

function formatDate(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftDays(date: Date, amount: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + amount);
  return shifted;
}

export function firstDayOfWeek(locale: Locale): number {
  const info = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 7;
  return firstDay % 7;
}

export function getMonthGridDates(month: string, weekStartsOn = 0): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError("Expected month YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    !Number.isInteger(weekStartsOn) ||
    weekStartsOn < 0 ||
    weekStartsOn > 6
  ) {
    throw new RangeError("Invalid calendar month or week start");
  }
  const first = new Date(0);
  first.setUTCFullYear(year, monthNumber - 1, 1);
  const last = new Date(0);
  last.setUTCFullYear(year, monthNumber, 0);
  const leadingDays = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const count = Math.ceil((leadingDays + last.getUTCDate()) / 7) * 7;
  return Array.from({ length: count }, (_, index) =>
    formatDate(shiftDays(first, index - leadingDays)),
  );
}

export function getWeekDates(date: string, weekStartsOn = 0): string[] {
  const selected = parseDate(date);
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("Invalid week start");
  }
  const leadingDays = (selected.getUTCDay() - weekStartsOn + 7) % 7;
  const first = shiftDays(selected, -leadingDays);
  return Array.from({ length: 7 }, (_, index) => formatDate(shiftDays(first, index)));
}

export function shiftCalendarDate(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("Day offset must be an integer");
  return formatDate(shiftDays(parseDate(date), days));
}

export function shiftCalendarMonth(date: string, months: number): string {
  if (!Number.isInteger(months)) throw new RangeError("Month offset must be an integer");
  const selected = parseDate(date);
  const targetMonth = new Date(0);
  targetMonth.setUTCFullYear(selected.getUTCFullYear(), selected.getUTCMonth() + months, 1);
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0);
  targetMonth.setUTCDate(Math.min(selected.getUTCDate(), lastDay.getUTCDate()));
  return formatDate(targetMonth);
}
