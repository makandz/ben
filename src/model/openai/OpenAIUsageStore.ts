import path from "node:path";

import type { TokenUsage } from "../../app/types.js";
import {
  isRecord,
  readJsonFile,
  UpdateQueue,
  writeJsonFileAtomic,
} from "../../storage/JsonFile.js";
import { calculateCostUsd, getModelPricing } from "../pricing.js";

export type UsageDay = TokenUsage & {
  requests: number;
  costUsd: number;
};

export type UsageBudgetStatus = {
  limited: boolean;
  day: string;
  costUsd: number;
  budgetUsd: number;
};

export type UsageSummary = UsageDay & {
  day: string;
  model: string;
  budgetUsd: number;
  remainingBudgetUsd: number | undefined;
};

export type RecordedUsage = TokenUsage & {
  day: string;
  costUsd: number;
  totalCostUsd: number;
};

type UsageMonthFile = {
  month: string;
  days: Record<string, UsageDay>;
};

type UsageLogger = {
  warn(event: string, data?: Record<string, unknown>): void;
};

const silentLogger: UsageLogger = { warn: () => undefined };

/** Persists compatible monthly OpenAI usage totals using atomic file replacement. */
export class OpenAIUsageStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a usage store for one displayed model and shared daily budget.
   *
   * @param directory - Directory containing compatible monthly JSON files.
   * @param summaryModel - Model name displayed by daily usage summaries.
   * @param budgetUsd - Shared daily limit, or zero for unlimited usage.
   * @param logger - Narrow warning logger used for read failures.
   * @throws When the model lacks configured pricing or the budget is invalid.
   */
  constructor(
    private readonly directory: string,
    private readonly summaryModel: string,
    private readonly budgetUsd: number,
    private readonly logger: UsageLogger = silentLogger,
  ) {
    getModelPricing(summaryModel);

    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      throw new Error("budgetUsd must be a non-negative number");
    }
  }

  /**
   * Reports whether the configured daily cost limit has been reached.
   *
   * @param now - Local date used to select the usage day.
   * @returns Current cost and budget state for that day.
   */
  async getBudgetStatus(now = new Date()): Promise<UsageBudgetStatus> {
    const day = formatDay(now);
    const monthFile = await this.readMonthFile(formatMonth(now));
    const costUsd = monthFile.days[day]?.costUsd ?? 0;

    return {
      limited: this.budgetUsd > 0 && costUsd >= this.budgetUsd,
      day,
      costUsd,
      budgetUsd: this.budgetUsd,
    };
  }

  /**
   * Returns today's persisted token and cost totals.
   *
   * @param now - Local date used to select the usage day.
   * @returns Compatible aggregate usage and remaining budget.
   */
  async getTodaySummary(now = new Date()): Promise<UsageSummary> {
    const day = formatDay(now);
    const monthFile = await this.readMonthFile(formatMonth(now));
    const usage = monthFile.days[day] ?? emptyUsageDay();

    return {
      day,
      model: this.summaryModel,
      ...usage,
      budgetUsd: this.budgetUsd,
      remainingBudgetUsd:
        this.budgetUsd > 0 ? Math.max(this.budgetUsd - usage.costUsd, 0) : undefined,
    };
  }

  /**
   * Records one model request and returns its cost and updated daily cost.
   *
   * @param model - Exact model whose pricing applies to this request.
   * @param usage - Provider-neutral token counts to aggregate.
   * @param now - Local date used to select the usage day.
   * @returns The request cost and updated daily total.
   */
  async record(model: string, usage: TokenUsage, now = new Date()): Promise<RecordedUsage> {
    const day = formatDay(now);
    const costUsd = calculateCostUsd(usage, getModelPricing(model));
    return this.updates.run(async () => {
      const monthFile = await this.readMonthFile(formatMonth(now));
      const dayUsage = monthFile.days[day] ?? emptyUsageDay();
      dayUsage.requests += 1;
      dayUsage.inputTokens += usage.inputTokens;
      dayUsage.cachedInputTokens += usage.cachedInputTokens;
      dayUsage.outputTokens += usage.outputTokens;
      dayUsage.totalTokens += usage.totalTokens;
      dayUsage.costUsd += costUsd;
      monthFile.days[day] = dayUsage;
      await writeJsonFileAtomic(this.monthFilePath(monthFile.month), monthFile);
      return { day, costUsd, totalCostUsd: dayUsage.costUsd, ...usage };
    });
  }

  /** Reads one compatible usage month or returns an empty month when absent. */
  private async readMonthFile(month: string): Promise<UsageMonthFile> {
    const filePath = this.monthFilePath(month);
    try {
      const parsed = await readJsonFile(filePath);
      return parsed === undefined ? { month, days: {} } : parseMonthFile(parsed, month);
    } catch (error) {
      this.logger.warn("openai.usage_read_failed", { path: filePath, error: String(error) });
      throw error;
    }
  }

  /** Resolves the JSON path for one compact year-month key. */
  private monthFilePath(month: string): string {
    return path.join(this.directory, `${month}.json`);
  }
}

/** Creates an independent zero-valued daily usage record. */
function emptyUsageDay(): UsageDay {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

/** Validates the persisted shape instead of silently accepting corrupt totals. */
function parseMonthFile(value: unknown, expectedMonth: string): UsageMonthFile {
  if (!isRecord(value) || value.month !== expectedMonth || !isRecord(value.days)) {
    throw new Error(`Invalid OpenAI usage file for month ${expectedMonth}`);
  }

  const days: Record<string, UsageDay> = {};

  for (const [day, usage] of Object.entries(value.days)) {
    if (!/^\d{6}$/.test(day) || !isUsageDay(usage)) {
      throw new Error(`Invalid OpenAI usage entry for day ${day}`);
    }

    days[day] = usage;
  }

  return { month: expectedMonth, days };
}

/** Checks that a persisted daily entry contains valid non-negative totals. */
function isUsageDay(value: unknown): value is UsageDay {
  return (
    isRecord(value) &&
    isNonNegativeFinite(value.requests) &&
    Number.isInteger(value.requests) &&
    isNonNegativeFinite(value.inputTokens) &&
    Number.isInteger(value.inputTokens) &&
    isNonNegativeFinite(value.cachedInputTokens) &&
    Number.isInteger(value.cachedInputTokens) &&
    isNonNegativeFinite(value.outputTokens) &&
    Number.isInteger(value.outputTokens) &&
    isNonNegativeFinite(value.totalTokens) &&
    Number.isInteger(value.totalTokens) &&
    isNonNegativeFinite(value.costUsd)
  );
}

/** Checks that a value is a finite non-negative number. */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Formats a local date as the persisted YYMMDD key. */
function formatDay(date: Date): string {
  return `${formatMonth(date)}${date.getDate().toString().padStart(2, "0")}`;
}

/** Formats a local date as the persisted YYMM month key. */
function formatMonth(date: Date): string {
  const year = (date.getFullYear() % 100).toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${year}${month}`;
}
