import type { HumanMessage } from "./types.js";

export function formatGroupedMessages(messages: readonly HumanMessage[]): string {
  const lines: string[] = [];
  let currentUsername: string | undefined;
  let currentContent: string[] = [];

  for (const message of messages) {
    const content = message.content.trim();

    if (content.length === 0) {
      continue;
    }

    if (message.username !== currentUsername) {
      if (currentUsername !== undefined && currentContent.length > 0) {
        lines.push(`${currentUsername}: ${currentContent.join(" ")}`);
      }

      currentUsername = message.username;
      currentContent = [content];
      continue;
    }

    currentContent.push(content);
  }

  if (currentUsername !== undefined && currentContent.length > 0) {
    lines.push(`${currentUsername}: ${currentContent.join(" ")}`);
  }

  return lines.join("\n");
}

export function buildUserPrompt(options: {
  recentContext: readonly HumanMessage[];
  messages: readonly HumanMessage[];
}): string {
  const sections: string[] = [];

  if (options.recentContext.length > 0) {
    sections.push(`Recent context:\n${formatGroupedMessages(options.recentContext)}`);
  }

  sections.push(`New messages:\n${formatGroupedMessages(options.messages)}`);

  return sections.join("\n\n");
}
