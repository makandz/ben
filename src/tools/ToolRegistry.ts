import type { Tool, ToolDefinition } from "./Tool.js";

/** Stores uniquely named tools and exposes their model-facing definitions. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * Creates a registry containing the provided tools.
   *
   * @param tools - Tools to register in their exposed order.
   */
  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Registers a uniquely named tool.
   *
   * @param tool - Tool to expose to the orchestrator and model.
   * @throws When another tool with the same name is already registered.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * Resolves a registered tool by name.
   *
   * @param name - Exact tool name emitted by the model.
   * @returns The registered tool, or undefined when the name is unknown.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Lists definitions exposed to a model.
   *
   * @returns Tool definitions in registration order.
   */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }
}
