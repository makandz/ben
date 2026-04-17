const TOOL_STATUS_PREFIX = "> Running tool ";

/**
 * Returns true when a Discord message is one of the bot's tool-status updates.
 *
 * @param text - Discord message content.
 * @returns `true` when the message is an operational status update.
 */
export function isOperationalStatusMessage(text: string): boolean {
  return text.startsWith(TOOL_STATUS_PREFIX);
}

/**
 * Extracts the tool call id from a streamed run item when one is available.
 *
 * @param rawItem - Streamed tool call item from the Agents SDK.
 * @returns Tool call id, or `null` when none is available.
 */
export function getToolCallId(rawItem: unknown): string | null {
  if (typeof rawItem !== "object" || rawItem === null || !("callId" in rawItem)) {
    return null;
  }

  return typeof rawItem.callId === "string" ? rawItem.callId : null;
}

/**
 * Formats a compact user-facing status line for a streamed tool invocation.
 *
 * @param rawItem - Streamed tool call item from the Agents SDK.
 * @returns Human-readable Discord status message.
 */
export function buildToolStatusMessage(rawItem: unknown): string {
  const toolName = buildToolName(rawItem);
  const details = buildToolCallDetails(rawItem);

  if (!details) {
    return `${TOOL_STATUS_PREFIX}\`${toolName}\``;
  }

  return `${TOOL_STATUS_PREFIX}\`${toolName}\` with ${details}`;
}

function buildToolName(rawItem: unknown): string {
  if (typeof rawItem !== "object" || rawItem === null) {
    return "unknown_tool";
  }

  const name =
    "name" in rawItem && typeof rawItem.name === "string"
      ? rawItem.name
      : undefined;
  const namespace =
    "namespace" in rawItem && typeof rawItem.namespace === "string"
      ? rawItem.namespace
      : undefined;

  if (name && namespace) {
    return `${namespace}.${name}`;
  }

  if (name) {
    return name;
  }

  if ("type" in rawItem && rawItem.type === "shell_call") {
    return "shell";
  }

  if ("type" in rawItem && rawItem.type === "computer_call") {
    return "computer";
  }

  if ("type" in rawItem && rawItem.type === "apply_patch_call") {
    return "apply_patch";
  }

  return "unknown_tool";
}

function buildToolCallDetails(rawItem: unknown): string | null {
  if (typeof rawItem !== "object" || rawItem === null) {
    return null;
  }

  if (
    "arguments" in rawItem &&
    typeof rawItem.arguments === "string" &&
    rawItem.arguments.trim()
  ) {
    return `args ${formatInlineValue(rawItem.arguments)}`;
  }

  if (
    "type" in rawItem &&
    rawItem.type === "shell_call" &&
    "action" in rawItem &&
    isShellAction(rawItem.action)
  ) {
    return `commands ${formatInlineValue(rawItem.action.commands.join(" && "))}`;
  }

  if (
    "type" in rawItem &&
    rawItem.type === "computer_call" &&
    "action" in rawItem &&
    isComputerAction(rawItem.action)
  ) {
    return `action ${formatInlineValue(JSON.stringify(rawItem.action))}`;
  }

  return null;
}

function formatInlineValue(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const shortened =
    compact.length > 160 ? `${compact.slice(0, 157).trimEnd()}...` : compact;

  return `\`${shortened.replaceAll("`", "'")}\``;
}

function isShellAction(value: unknown): value is { commands: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "commands" in value &&
    Array.isArray(value.commands) &&
    value.commands.every((command) => typeof command === "string")
  );
}

function isComputerAction(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
