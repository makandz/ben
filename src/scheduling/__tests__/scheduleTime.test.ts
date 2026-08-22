import assert from "node:assert/strict";
import test from "node:test";

import {
  computeNextRunAt,
  formatBotTime,
  localScheduleToDate,
  validateRunDate,
  validateRunTime,
} from "../scheduleTime.js";

test("validates calendar dates and 24-hour times", () => {
  assert.equal(validateRunDate("2024-02-29"), true);
  assert.equal(validateRunDate("2023-02-29"), false);
  assert.equal(validateRunDate("2026-2-01"), false);
  assert.equal(validateRunTime("23:59"), true);
  assert.equal(validateRunTime("24:00"), false);
  assert.equal(validateRunTime("9:00"), false);
});

test("rejects invalid local schedule input", () => {
  assert.throws(
    () => localScheduleToDate({ runDate: "bad", runTime: "09:00", timeZone: "UTC" }),
    /run_date/,
  );
  assert.throws(
    () => localScheduleToDate({ runDate: "2026-01-01", runTime: "bad", timeZone: "UTC" }),
    /run_time/,
  );
});

test("converts local time to an absolute instant", () => {
  const instant = localScheduleToDate({
    runDate: "2026-03-07",
    runTime: "09:00",
    timeZone: "America/Toronto",
  });

  assert.equal(instant.toISOString(), "2026-03-07T14:00:00.000Z");
});

test("preserves local wall time for daily and weekly recurrence", () => {
  const instant = new Date("2026-03-07T14:00:00.000Z");

  assert.equal(
    computeNextRunAt(instant, "daily", "America/Toronto")?.toISOString(),
    "2026-03-08T13:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(instant, "weekly", "America/Toronto")?.toISOString(),
    "2026-03-14T13:00:00.000Z",
  );
  assert.equal(computeNextRunAt(instant, "none", "America/Toronto"), undefined);
});

test("rejects a nonexistent daylight-saving wall time", () => {
  assert.throws(() => {
    localScheduleToDate({
      runDate: "2026-03-08",
      runTime: "02:30",
      timeZone: "America/Toronto",
    });
  });
});

test("daily recurrence skips a nonexistent daylight-saving occurrence", () => {
  assert.equal(
    computeNextRunAt(
      new Date("2026-03-07T07:30:00.000Z"),
      "daily",
      "America/Toronto",
    )?.toISOString(),
    "2026-03-09T06:30:00.000Z",
  );
});

test("formats bot-local prompt time", () => {
  const formatted = formatBotTime(new Date("2026-08-10T16:30:00.000Z"), "America/Toronto");

  assert.match(formatted, /Monday, August 10, 2026/);
  assert.match(formatted, /12:30 PM/);
});
