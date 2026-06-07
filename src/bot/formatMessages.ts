import type { HumanMessage } from "./types.js";
import type { KnownPerson } from "../config.js";

type KnownPeople = Readonly<Record<string, KnownPerson>>;

export function formatGroupedMessages(
  messages: readonly HumanMessage[],
  knownPeople: KnownPeople = {},
): string {
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
        lines.push(`${formatSpeaker(currentUsername, knownPeople)}: ${currentContent.join(" ")}`);
      }

      currentUsername = message.username;
      currentContent = [content];
      continue;
    }

    currentContent.push(content);
  }

  if (currentUsername !== undefined && currentContent.length > 0) {
    lines.push(`${formatSpeaker(currentUsername, knownPeople)}: ${currentContent.join(" ")}`);
  }

  return lines.join("\n");
}

export function buildUserPrompt(options: {
  recentContext: readonly HumanMessage[];
  messages: readonly HumanMessage[];
  knownPeople?: KnownPeople;
  includeKnownPeople?: boolean;
}): string {
  const sections: string[] = [];
  const knownPeople = options.knownPeople ?? {};

  if (options.includeKnownPeople === true) {
    const knownPeopleText = formatKnownPeople(knownPeople);

    if (knownPeopleText.length > 0) {
      sections.push(`Known people:\n${knownPeopleText}`);
    }
  }

  if (options.recentContext.length > 0) {
    sections.push(`Recent context:\n${formatGroupedMessages(options.recentContext, knownPeople)}`);
  }

  sections.push(`New messages:\n${formatGroupedMessages(options.messages, knownPeople)}`);

  return sections.join("\n\n");
}

function formatSpeaker(username: string, knownPeople: KnownPeople): string {
  const person = knownPeople[username.toLowerCase()];

  return person === undefined ? username : `${username} (${person.name})`;
}

function formatKnownPeople(knownPeople: KnownPeople): string {
  return Object.entries(knownPeople)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, person]) => `- ${username} is ${person.name}`)
    .join("\n");
}
