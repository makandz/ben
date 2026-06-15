import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ResponseUsage } from "openai/resources/responses/responses";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { getModelPricing } from "./pricing.js";

interface UsageDay {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface UsageMonthFile {
  month: string;
  days: Record<string, UsageDay>;
}

export interface UsageBudgetStatus {
  limited: boolean;
  day: string;
  costUsd: number;
  budgetUsd: number;
}

export interface UsageSummary extends UsageDay {
  day: string;
  model: string;
  budgetUsd: number;
  remainingBudgetUsd: number | undefined;
}

export interface RecordedUsage {
  day: string;
  costUsd: number;
  totalCostUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const emptyUsageDay = (): UsageDay => ({
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});

export class OpenAIUsageStore {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async getBudgetStatus(now = new Date()): Promise<UsageBudgetStatus> {
    const budgetUsd = this.config.openaiDailyBudgetUsd;
    const day = formatDay(now);
    const costUsd = await this.getDailyCost(day);

    return {
      limited: budgetUsd > 0 && costUsd >= budgetUsd,
      day,
      costUsd,
      budgetUsd,
    };
  }

  async getTodaySummary(now = new Date()): Promise<UsageSummary> {
    const day = formatDay(now);
    const monthFile = await this.readMonthFile(day.slice(0, 4));
    const dayUsage = monthFile.days[day] ?? emptyUsageDay();
    const budgetUsd = this.config.openaiDailyBudgetUsd;

    return {
      day,
      model: this.config.openaiModel,
      ...dayUsage,
      budgetUsd,
      remainingBudgetUsd: budgetUsd > 0 ? Math.max(budgetUsd - dayUsage.costUsd, 0) : undefined,
    };
  }

  async record(model: string, usage: ResponseUsage, now = new Date()): Promise<RecordedUsage> {
    const pricing = getModelPricing(model);
    const day = formatDay(now);
    const month = formatMonth(now);
    const monthFile = await this.readMonthFile(month);
    const dayUsage = monthFile.days[day] ?? emptyUsageDay();
    const inputTokens = usage.input_tokens;
    const cachedInputTokens = usage.input_tokens_details.cached_tokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = usage.total_tokens;
    const uncachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0);
    const costUsd =
      (uncachedInputTokens / 1_000_000) * pricing.inputUsdPer1M +
      (cachedInputTokens / 1_000_000) * pricing.cachedInputUsdPer1M +
      (outputTokens / 1_000_000) * pricing.outputUsdPer1M;

    dayUsage.requests += 1;
    dayUsage.inputTokens += inputTokens;
    dayUsage.cachedInputTokens += cachedInputTokens;
    dayUsage.outputTokens += outputTokens;
    dayUsage.totalTokens += totalTokens;
    dayUsage.costUsd += costUsd;

    monthFile.days[day] = dayUsage;
    await this.writeMonthFile(monthFile);

    return {
      day,
      costUsd,
      totalCostUsd: dayUsage.costUsd,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
    };
  }

  private async getDailyCost(day: string): Promise<number> {
    const month = day.slice(0, 4);
    const monthFile = await this.readMonthFile(month);

    return monthFile.days[day]?.costUsd ?? 0;
  }

  private async readMonthFile(month: string): Promise<UsageMonthFile> {
    const filePath = this.monthFilePath(month);

    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<UsageMonthFile>;

      return {
        month,
        days: parsed.days ?? {},
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return { month, days: {} };
      }

      this.logger.warn("openai.usage_read_failed", {
        path: filePath,
        error: String(error),
      });
      throw error;
    }
  }

  private async writeMonthFile(monthFile: UsageMonthFile): Promise<void> {
    const filePath = this.monthFilePath(monthFile.month);
    const tempPath = `${filePath}.tmp`;

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(monthFile, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  private monthFilePath(month: string): string {
    return path.join(this.config.openaiUsageLogDir, `${month}.json`);
  }
}

function formatDay(date: Date): string {
  return `${formatMonth(date)}${pad2(date.getDate())}`;
}

function formatMonth(date: Date): string {
  const year = date.getFullYear() % 100;
  return `${pad2(year)}${pad2(date.getMonth() + 1)}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
