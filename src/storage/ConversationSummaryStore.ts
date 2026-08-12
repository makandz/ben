import type { Logger } from "../logger.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

const MAX_CONVERSATION_SUMMARIES = 25;

export type ConversationSummary = {
  sleptAt: string;
  summary: string;
};

/** Persists the bounded conversation summaries shown when Ben next wakes. */
export class ConversationSummaryStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a store over a production-compatible conversation-summary file.
   *
   * @param filePath - JSON file compatible with the production summary store.
   * @param logger - Logger used for contained read failures.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Lists the valid summaries retained for future prompt context.
   *
   * @returns Up to 25 valid summaries in stored order.
   */
  async list(): Promise<ConversationSummary[]> {
    return this.readSummaries();
  }

  /**
   * Adds one non-empty summary and atomically persists the newest five.
   *
   * @param summary - Model-authored sleep summary.
   * @param now - Sleep time, replaceable for deterministic tests.
   * @returns The summaries remaining after the bounded append.
   * @throws When `summary` is empty after trimming.
   */
  async add(summary: string, now = new Date()): Promise<ConversationSummary[]> {
    const trimmed = summary.trim();
    if (trimmed.length === 0) throw new Error("Conversation summary must be non-empty.");

    return this.updates.run(async () => {
      const conversations = [
        ...(await this.readSummaries()),
        { sleptAt: now.toISOString(), summary: trimmed },
      ].slice(-MAX_CONVERSATION_SUMMARIES);
      await writeJsonFileAtomic(this.filePath, { version: 1, conversations });
      return conversations;
    });
  }

  /** Clears all summaries after successful long-term consolidation. */
  async clear(): Promise<void> {
    await this.updates.run(() =>
      writeJsonFileAtomic(this.filePath, { version: 1, conversations: [] }),
    );
  }

  /** Reads valid entries while containing missing, malformed, or unreadable files. */
  private async readSummaries(): Promise<ConversationSummary[]> {
    try {
      const parsed = await readJsonFile(this.filePath);
      if (parsed === undefined) return [];
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
      this.logger.warn("conversation_summaries.read_failed", {
        path: this.filePath,
        error: String(error),
      });
      return [];
    }
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
