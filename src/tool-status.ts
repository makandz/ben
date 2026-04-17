const TOOL_STATUS_PREFIX = "> Running tool ";
const STATUS_UPDATE_PREFIX = "\u2063";

/**
 * Returns true when a Discord message is one of the bot's tool-status updates.
 *
 * @param text - Discord message content.
 * @returns `true` when the message is an operational status update.
 */
export function isOperationalStatusMessage(text: string): boolean {
  return (
    text.startsWith(TOOL_STATUS_PREFIX) || text.startsWith(STATUS_UPDATE_PREFIX)
  );
}

/**
 * Formats a compact user-facing status line for a tool execution.
 *
 * @param toolName - Tool name to show in Discord.
 * @returns Human-readable Discord status message.
 */
export function formatToolExecutionMessage(toolName: string): string {
  return `${TOOL_STATUS_PREFIX}\`${toolName}\``;
}

/**
 * Formats a plain-looking in-thread progress message sent via the status tool.
 *
 * @param message - Model-authored progress update.
 * @returns Human-readable Discord message content.
 */
export function formatStatusUpdateMessage(message: string): string {
  return `${STATUS_UPDATE_PREFIX}${formatStatusBody(message)}`;
}

function formatStatusBody(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const shortened =
    compact.length > 400 ? `${compact.slice(0, 397).trimEnd()}...` : compact;

  return shortened || "Working on it.";
}
