import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";

const MAX_CONVERSATION_SUMMARIES = 5;

export type ConversationSummary = {
  sleptAt: string;
  summary: string;
};

/** Persists the bounded conversation summaries shown when Ben next wakes. */
export class ConversationSummaryStore {
  /**
   * @param filePath - JSON file compatible with the production summary store.
   * @param logger - Logger used for contained read failures.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /** @returns Up to five valid summaries in stored order. */
  async list(): Promise<ConversationSummary[]> {
    return this.readSummaries();
  }

  /**
   * Adds one non-empty summary and atomically persists the newest five.
   *
   * @param summary - Model-authored sleep summary.
   * @param now - Sleep time, replaceable for deterministic tests.
   * @returns The summaries remaining after the bounded append.
   */
  async add(summary: string, now = new Date()): Promise<ConversationSummary[]> {
    const trimmed = summary.trim();
    if (trimmed.length === 0) throw new Error("Conversation summary must be non-empty.");

    const conversations = [
      ...(await this.readSummaries()),
      { sleptAt: now.toISOString(), summary: trimmed },
    ].slice(-MAX_CONVERSATION_SUMMARIES);
    await this.writeSummaries(conversations);
    return conversations;
  }

  /** Reads valid entries while containing missing, malformed, or unreadable files. */
  private async readSummaries(): Promise<ConversationSummary[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        this.logger.warn("conversation_summaries.invalid", { path: this.filePath });
        return [];
      }
      if (!Array.isArray(parsed.conversations)) return [];
      return parsed.conversations
        .map(parseConversationSummary)
        .filter((summary): summary is ConversationSummary => summary !== undefined)
        .slice(-MAX_CONVERSATION_SUMMARIES);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      this.logger.warn("conversation_summaries.read_failed", {
        path: this.filePath,
        error: String(error),
      });
      return [];
    }
  }

  /** Writes through a sibling temporary file before replacing the destination. */
  private async writeSummaries(conversations: readonly ConversationSummary[]): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

/** Parses one compatible stored summary. */
function parseConversationSummary(value: unknown): ConversationSummary | undefined {
  if (!isRecord(value) || typeof value.sleptAt !== "string" || typeof value.summary !== "string") {
    return undefined;
  }
  const summary = value.summary.trim();
  return summary.length === 0 ? undefined : { sleptAt: value.sleptAt, summary };
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Identifies a missing filesystem entry without relying on an Error subclass. */
function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
