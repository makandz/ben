import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type ReminderRow = {
  id: number;
  user_id: string;
  reminder_text: string;
  due_at_ms: number;
  created_at_ms: number;
};

export type Reminder = {
  id: number;
  userId: string;
  reminderText: string;
  dueAtMs: number;
  createdAtMs: number;
};

export type ScheduleReminderInput = {
  userId: string;
  reminderText: string;
  dueAtMs: number;
  createdAtMs?: number;
};

export type ReminderService = {
  scheduleReminder(input: ScheduleReminderInput): Reminder;
  start(): Promise<void>;
  stop(): void;
};

type ReminderServiceOptions = {
  databasePath: string;
  deliverReminder: (reminder: Reminder) => Promise<void>;
  now?: () => number;
  retryDelayMs?: number;
};

/**
 * Creates the persistent reminder store and scheduler used by the bot.
 *
 * @param options - Database location, delivery callback, and timing overrides.
 * @returns Reminder service with start, stop, and schedule helpers.
 */
export function createReminderService(
  options: ReminderServiceOptions,
): ReminderService {
  const now = options.now ?? (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  mkdirSync(dirname(options.databasePath), { recursive: true });

  const database = new Database(options.databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      due_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS reminders_due_at_ms_idx
      ON reminders (due_at_ms);
  `);

  const insertReminder = database.prepare<[string, string, number, number]>(`
    INSERT INTO reminders (user_id, reminder_text, due_at_ms, created_at_ms)
    VALUES (?, ?, ?, ?)
  `);
  const selectEarliestReminder = database.prepare<[], ReminderRow>(`
    SELECT id, user_id, reminder_text, due_at_ms, created_at_ms
    FROM reminders
    ORDER BY due_at_ms ASC, id ASC
    LIMIT 1
  `);
  const selectDueReminders = database.prepare<[number], ReminderRow>(`
    SELECT id, user_id, reminder_text, due_at_ms, created_at_ms
    FROM reminders
    WHERE due_at_ms <= ?
    ORDER BY due_at_ms ASC, id ASC
  `);
  const deleteReminder = database.prepare<[number]>(`
    DELETE FROM reminders
    WHERE id = ?
  `);

  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let isDelivering = false;
  let retryNotBeforeMs: number | null = null;

  /**
   * Clears the active scheduler timer when one exists.
   *
   * @returns Nothing.
   */
  function clearTimer(): void {
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    timer = undefined;
  }

  /**
   * Loads the next reminder and arms the scheduler timeout.
   *
   * @returns Nothing.
   */
  function scheduleNextTick(): void {
    if (!started) {
      return;
    }

    clearTimer();

    const earliestReminder = selectEarliestReminder.get();

    if (!earliestReminder) {
      return;
    }

    const currentTimeMs = now();
    let delayMs = Math.max(0, earliestReminder.due_at_ms - currentTimeMs);

    if (
      delayMs === 0 &&
      retryNotBeforeMs !== null &&
      retryNotBeforeMs > currentTimeMs
    ) {
      delayMs = retryNotBeforeMs - currentTimeMs;
    }

    timer = setTimeout(() => {
      void deliverDueReminders();
    }, Math.min(delayMs, MAX_TIMEOUT_MS));
  }

  /**
   * Sends every reminder that is currently due, leaving failed deliveries for retry.
   *
   * @returns Nothing.
   */
  async function deliverDueReminders(): Promise<void> {
    if (!started || isDelivering) {
      return;
    }

    isDelivering = true;
    clearTimer();

    try {
      while (started) {
        const dueReminders = selectDueReminders
          .all(now())
          .map(mapReminderRow);

        if (dueReminders.length === 0) {
          retryNotBeforeMs = null;
          break;
        }

        let deliveryFailed = false;

        for (const reminder of dueReminders) {
          try {
            await options.deliverReminder(reminder);
            deleteReminder.run(reminder.id);
          } catch (error) {
            retryNotBeforeMs = now() + retryDelayMs;
            deliveryFailed = true;
            console.error(`Failed to deliver reminder ${reminder.id}:`, error);
            break;
          }
        }

        if (deliveryFailed) {
          break;
        }
      }
    } finally {
      isDelivering = false;
      scheduleNextTick();
    }
  }

  return {
    scheduleReminder(input: ScheduleReminderInput): Reminder {
      const reminderText = input.reminderText.trim();
      const createdAtMs = Math.trunc(input.createdAtMs ?? now());
      const dueAtMs = Math.trunc(input.dueAtMs);

      if (!input.userId.trim()) {
        throw new Error("userId is required when scheduling a reminder.");
      }

      if (!reminderText) {
        throw new Error("reminderText must not be empty.");
      }

      if (!Number.isFinite(dueAtMs)) {
        throw new Error("dueAtMs must be a finite Unix timestamp in milliseconds.");
      }

      if (dueAtMs <= now()) {
        throw new Error("Reminder time must be in the future.");
      }

      const result = insertReminder.run(
        input.userId,
        reminderText,
        dueAtMs,
        createdAtMs,
      );

      retryNotBeforeMs = null;
      scheduleNextTick();

      return {
        id: Number(result.lastInsertRowid),
        userId: input.userId,
        reminderText,
        dueAtMs,
        createdAtMs,
      };
    },

    async start(): Promise<void> {
      if (started) {
        return;
      }

      started = true;
      await deliverDueReminders();
    },

    stop(): void {
      started = false;
      clearTimer();
      database.close();
    },
  };
}

/**
 * Converts a raw SQLite result row into the reminder shape used elsewhere.
 *
 * @param row - SQLite row fetched from the reminders table.
 * @returns Reminder record with camel-cased property names.
 */
function mapReminderRow(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    reminderText: row.reminder_text,
    dueAtMs: row.due_at_ms,
    createdAtMs: row.created_at_ms,
  };
}
