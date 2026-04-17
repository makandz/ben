import type { AgentInputItem } from "@openai/agents";

/**
 * Holds per-thread runtime state so event handlers do not manage raw maps directly.
 *
 * @returns Helpers for managing cached history, managed threads, and queued work.
 */
export function createThreadRuntime() {
  const threadHistories = new Map<string, AgentInputItem[]>();
  const threadQueues = new Map<string, Promise<void>>();
  const managedThreadIds = new Set<string>();

  return {
    getHistory(threadId: string): AgentInputItem[] | undefined {
      return threadHistories.get(threadId);
    },

    setHistory(threadId: string, history: AgentInputItem[]): void {
      threadHistories.set(threadId, history);
    },

    hasManagedThread(threadId: string): boolean {
      return managedThreadIds.has(threadId);
    },

    markManagedThread(threadId: string): void {
      managedThreadIds.add(threadId);
    },

    /**
     * Serializes work per thread so replies stay ordered even when Discord events race.
     *
     * @param threadId - Thread id used as the serialization key.
     * @param work - Async work to run after earlier work for the same thread.
     * @returns Nothing.
     */
    queueWork(threadId: string, work: () => Promise<void>): void {
      const previous = threadQueues.get(threadId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(work)
        .finally(() => {
          if (threadQueues.get(threadId) === next) {
            threadQueues.delete(threadId);
          }
        });

      threadQueues.set(threadId, next);
    },
  };
}
