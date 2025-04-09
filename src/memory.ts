import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "../data/memory.json");
const MAX_MEMORIES = 5;

export type Memory = {
  id: string;
  embedding: number[];
  content: string;
  metadata?: Record<string, any>;
  queryCount: number;
  lastQueried: number;
};

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

export class MemoryStore {
  private memories: Memory[];

  constructor() {
    this.memories = [];
  }

  private enforceMemoryLimit(): void {
    if (this.memories.length <= MAX_MEMORIES) return;

    // Sort by query count (descending) and then by last queried time (most recent first)
    this.memories.sort((a, b) => {
      if (b.queryCount !== a.queryCount) {
        return b.queryCount - a.queryCount;
      }
      return b.lastQueried - a.lastQueried;
    });

    // Keep only the top MAX_MEMORIES memories
    this.memories = this.memories.slice(0, MAX_MEMORIES);

    console.log(
      `Memory limit exceeded. Retained top ${MAX_MEMORIES} memories.`
    );
  }

  add(
    id: string,
    embedding: number[],
    content: string,
    metadata: Record<string, any> = {}
  ): void {
    const newMemory: Memory = {
      id,
      embedding,
      content,
      metadata,
      queryCount: 0,
      lastQueried: Date.now(),
    };

    this.memories.push(newMemory);
    this.enforceMemoryLimit();
  }

  query(
    queryEmbedding: number[],
    topK: number = 3,
    filterFn?: (mem: Memory) => boolean
  ): (Memory & { score: number })[] {
    let results = this.memories.map((mem) => {
      const score = cosineSimilarity(queryEmbedding, mem.embedding);
      // Update query stats for memories that match well (score > 0.5)
      if (score > 0.5) {
        mem.queryCount++;
        mem.lastQueried = Date.now();
      }
      return { ...mem, score };
    });

    if (filterFn) {
      results = results.filter(filterFn);
    }

    // Sort by similarity score
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  saveToFile(path: string): void {
    fs.writeFileSync(path, JSON.stringify(this.memories, null, 2));
  }

  loadFromFile(path: string): void {
    if (!fs.existsSync(path)) return;
    const loadedMemories = JSON.parse(fs.readFileSync(path, "utf8"));

    // Ensure loaded memories have the required fields
    this.memories = loadedMemories.map((mem: any) => ({
      ...mem,
      queryCount: mem.queryCount ?? 0,
      lastQueried: mem.lastQueried ?? Date.now(),
    }));

    this.enforceMemoryLimit();
  }

  clear(): void {
    this.memories = [];
  }

  getStats(): {
    total: number;
    mostQueried: { content: string; count: number } | null;
  } {
    const mostQueried =
      this.memories.length > 0
        ? this.memories.reduce((prev, current) =>
            prev.queryCount > current.queryCount ? prev : current
          )
        : null;

    return {
      total: this.memories.length,
      mostQueried: mostQueried
        ? { content: mostQueried.content, count: mostQueried.queryCount }
        : null,
    };
  }
}

// Create singleton instance
const memoryStore = new MemoryStore();

// Ensure data directory exists
const dataDir = path.dirname(MEMORY_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load existing memories
try {
  memoryStore.loadFromFile(MEMORY_FILE);
} catch (error) {
  console.error("Error loading memories:", error);
}

// Save memories on process exit and SIGINT (Ctrl+C)
function saveMemories() {
  try {
    memoryStore.saveToFile(MEMORY_FILE);
    console.log("Memories saved successfully");
  } catch (error) {
    console.error("Error saving memories:", error);
  }
}

process.on("exit", saveMemories);
process.on("SIGINT", () => {
  console.log("\nGracefully shutting down...");
  saveMemories();
  process.exit(0);
});

export { memoryStore };
