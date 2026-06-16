export type ScheduleRepeat = "none" | "daily" | "weekly";

export interface ScheduledLocalTime {
  runDate: string;
  runTime: string;
  timeZone: string;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

export function validateRunDate(runDate: string): boolean {
  if (!datePattern.test(runDate)) {
    return false;
  }

  const [year, month, day] = runDate.split("-").map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validateRunTime(runTime: string): boolean {
  if (!timePattern.test(runTime)) {
    return false;
  }

  const [hour, minute] = runTime.split(":").map(Number);

  return (
    hour !== undefined &&
    minute !== undefined &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

export function localScheduleToDate(input: ScheduledLocalTime): Date {
  if (!validateRunDate(input.runDate)) {
    throw new Error("run_date must be YYYY-MM-DD.");
  }

  if (!validateRunTime(input.runTime)) {
    throw new Error("run_time must be HH:mm.");
  }

  const [year, month, day] = input.runDate.split("-").map(Number);
  const [hour, minute] = input.runTime.split(":").map(Number);

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error("Invalid local schedule.");
  }

  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guessedInstant = new Date(localAsUtc);
  const offsetMs = getTimeZoneOffsetMs(guessedInstant, input.timeZone);
  const instant = new Date(localAsUtc - offsetMs);
  const actual = getTimeZoneParts(instant, input.timeZone);

  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  ) {
    throw new Error("run_date and run_time do not exist in the configured timezone.");
  }

  return instant;
}

export function computeNextRunAt(
  lastRunAt: Date,
  repeat: ScheduleRepeat,
  timeZone: string,
): Date | undefined {
  if (repeat === "none") {
    return undefined;
  }

  const parts = getTimeZoneParts(lastRunAt, timeZone);
  const nextLocalDate =
    repeat === "daily"
      ? addDays(parts.year, parts.month, parts.day, 1)
      : addDays(parts.year, parts.month, parts.day, 7);

  return localScheduleToDate({
    runDate: formatDate(nextLocalDate.year, nextLocalDate.month, nextLocalDate.day),
    runTime: formatTime(parts.hour, parts.minute),
    timeZone,
  });
}

export function formatBotTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
}

function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = getTimeZoneParts(instant, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  return localAsUtc - instant.getTime();
}

function getTimeZoneParts(
  instant: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(instant);

  return {
    year: requirePart(parts, "year"),
    month: requirePart(parts, "month"),
    day: requirePart(parts, "day"),
    hour: requirePart(parts, "hour"),
    minute: requirePart(parts, "minute"),
  };
}

function requirePart(parts: Intl.DateTimeFormatPart[], type: string): number {
  const value = parts.find((part) => part.type === type)?.value;

  if (value === undefined) {
    throw new Error(`Missing ${type} from timezone formatter.`);
  }

  return Number(value);
}

function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
