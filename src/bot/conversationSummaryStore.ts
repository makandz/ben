import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";

export interface ConversationSummary {
  sleptAt: string;
  summary: string;
}

interface ConversationSummaryFile {
  version?: number;
  conversations?: unknown;
}

const maxConversationSummaries = 5;

export class ConversationSummaryStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async list(): Promise<ConversationSummary[]> {
    return this.readSummaries();
  }

  async add(summary: string, now = new Date()): Promise<ConversationSummary[]> {
    const trimmedSummary = summary.trim();

    if (trimmedSummary.length === 0) {
      throw new Error("Conversation summary must be non-empty.");
    }

    const conversations = [
      ...(await this.readSummaries()),
      {
        sleptAt: now.toISOString(),
        summary: trimmedSummary,
      },
    ].slice(-maxConversationSummaries);

    await this.writeSummaries(conversations);
    return conversations;
  }

  private async readSummaries(): Promise<ConversationSummary[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        this.logger.warn("conversation_summaries.invalid", { path: this.filePath });
        return [];
      }

      const summaryFile = parsed as ConversationSummaryFile;

      if (!Array.isArray(summaryFile.conversations)) {
        return [];
      }

      return summaryFile.conversations
        .map(parseConversationSummary)
        .filter((summary): summary is ConversationSummary => summary !== undefined)
        .slice(-maxConversationSummaries);
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }

      this.logger.warn("conversation_summaries.read_failed", {
        path: this.filePath,
        error: String(error),
      });
      return [];
    }
  }

  private async writeSummaries(conversations: readonly ConversationSummary[]): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      tempPath,
      `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.filePath);
  }
}

function parseConversationSummary(value: unknown): ConversationSummary | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.sleptAt !== "string" || typeof record.summary !== "string") {
    return undefined;
  }

  const summary = record.summary.trim();

  if (summary.length === 0) {
    return undefined;
  }

  return {
    sleptAt: record.sleptAt,
    summary,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
