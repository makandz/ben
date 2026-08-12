import type { Model } from "../model/Model.js";

type Summary = { summary: string };
type ShortTermMemory = { id: number; memory: string };

type MemoryConsolidatorDependencies = {
  summaries: {
    list(): Promise<readonly Summary[]>;
    clear(): Promise<void>;
  };
  shortTermMemories: {
    list(): Promise<readonly ShortTermMemory[]>;
    clear(): Promise<void>;
  };
  longTermMemory: {
    get(): Promise<string | undefined>;
    set(memory: string): Promise<void>;
  };
};

/** Consolidates Ben's pending short-term context into one long-term memory document. */
export class MemoryConsolidator {
  /**
   * Creates a tool-free memory consolidation service.
   *
   * @param model - Model used only for consolidation turns.
   * @param instructions - Dedicated dreaming-phase system prompt.
   * @param dependencies - Short- and long-term persistence boundaries.
   */
  constructor(
    private readonly model: Model,
    private readonly instructions: string,
    private readonly dependencies: MemoryConsolidatorDependencies,
  ) {}

  /**
   * Checks whether consolidation has any new input.
   *
   * @returns Whether summaries or active short-term memories currently exist.
   */
  async hasPendingMemory(): Promise<boolean> {
    const [summaries, memories] = await Promise.all([
      this.dependencies.summaries.list(),
      this.dependencies.shortTermMemories.list(),
    ]);
    return summaries.length > 0 || memories.length > 0;
  }

  /**
   * Rewrites long-term memory from a stable short-term snapshot.
   *
   * @returns Whether consolidation was performed or skipped for lack of input.
   * @throws When reading, model generation, validation, writing, or clearing fails.
   */
  async consolidate(): Promise<"consolidated" | "skipped"> {
    const [summaries, memories, longTermMemory] = await Promise.all([
      this.dependencies.summaries.list(),
      this.dependencies.shortTermMemories.list(),
      this.dependencies.longTermMemory.get(),
    ]);
    if (summaries.length === 0 && memories.length === 0) return "skipped";

    const turn = await this.model.invoke({
      instructions: this.instructions,
      history: [
        {
          type: "message",
          role: "user",
          text: formatConsolidationInput(longTermMemory, summaries, memories),
        },
      ],
      tools: [],
    });
    const consolidated = turn.items
      .flatMap((item) =>
        item.type === "message" && item.role === "assistant" ? [item.text.trim()] : [],
      )
      .filter((text) => text.length > 0)
      .join("\n\n");
    if (consolidated.length === 0) {
      throw new Error("Memory consolidation returned no text.");
    }

    await this.dependencies.longTermMemory.set(consolidated);
    await Promise.all([
      this.dependencies.summaries.clear(),
      this.dependencies.shortTermMemories.clear(),
    ]);
    return "consolidated";
  }
}

/** Builds a plainly delimited, data-only consolidation input. */
function formatConsolidationInput(
  longTermMemory: string | undefined,
  summaries: readonly Summary[],
  memories: readonly ShortTermMemory[],
): string {
  const existing = longTermMemory ?? "(none yet)";
  const shortTerm =
    memories.length === 0 ? "(none)" : memories.map(({ memory }) => `- ${memory}`).join("\n");
  const conversations =
    summaries.length === 0 ? "(none)" : summaries.map(({ summary }) => `- ${summary}`).join("\n");
  return [
    `Existing long-term memory:\n${existing}`,
    `Short-term memories:\n${shortTerm}`,
    `Conversation summaries:\n${conversations}`,
  ].join("\n\n");
}
