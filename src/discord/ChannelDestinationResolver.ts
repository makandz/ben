import { ChannelMentionDirectory, findMatchingChannel } from "./DiscordDirectory.js";
import type { DiscordChannel, DiscordGateway } from "./DiscordGateway.js";

export type ChannelDestinationKind = "current" | "named" | "own";

export type ResolvedChannelDestination = {
  kind: ChannelDestinationKind;
  channel: DiscordChannel;
};

export type ChannelDestinationDependencies = {
  gateway: DiscordGateway;
  channels: ChannelMentionDirectory;
  currentChannelId: string | undefined;
  ownChannelId: string | undefined;
};

/**
 * Resolves a model-facing channel destination to a verified Discord channel.
 *
 * @param destination - `current` for the active channel, a readable channel name, or null for Ben's own channel.
 * @param dependencies - Discord lookup state and the exact current and configured own-channel identifiers.
 * @returns The verified channel together with the destination kind used to select it.
 * @throws When the requested destination is unavailable, ambiguous, outside a server, or not sendable.
 */
export async function resolveChannelDestination(
  destination: string | null,
  dependencies: ChannelDestinationDependencies,
): Promise<ResolvedChannelDestination> {
  if (destination === null) {
    return resolveById("own", dependencies.ownChannelId, dependencies);
  }

  const requested = destination.trim();
  if (requested.toLowerCase() === "current") {
    return resolveById("current", dependencies.currentChannelId, dependencies);
  }
  if (requested.length === 0) throw new Error("channel destination must not be empty");

  const current = await fetchSendableChannel(
    dependencies.currentChannelId,
    "current Discord channel is unavailable",
    dependencies.gateway,
  );
  if (current.guildId === undefined) {
    throw new Error("current Discord channel is not in a server");
  }

  const channel = findMatchingChannel(
    requested,
    await dependencies.gateway.fetchGuildChannels(current.guildId),
  );
  if (channel === undefined || channel.sendable === false) {
    throw new Error(
      `channel ${JSON.stringify(formatChannelName(requested))} was not found uniquely or is not sendable`,
    );
  }

  dependencies.channels.rememberChannel(channel);
  return { kind: "named", channel };
}

/** Resolves one exact configured channel identifier without a guild-wide name lookup. */
async function resolveById(
  kind: "current" | "own",
  channelId: string | undefined,
  dependencies: ChannelDestinationDependencies,
): Promise<ResolvedChannelDestination> {
  const label = kind === "current" ? "current Discord channel" : "Ben's own channel";
  const channel = await fetchSendableChannel(
    channelId,
    `${label} is unavailable`,
    dependencies.gateway,
  );
  dependencies.channels.rememberChannel(channel);
  return { kind, channel };
}

/** Fetches an exact destination and rejects channels that cannot accept messages. */
async function fetchSendableChannel(
  channelId: string | undefined,
  unavailableMessage: string,
  gateway: DiscordGateway,
): Promise<DiscordChannel> {
  if (channelId === undefined || channelId.trim().length === 0) {
    throw new Error(unavailableMessage);
  }
  const channel = await gateway.fetchChannel(channelId);
  if (channel === undefined || channel.sendable === false) throw new Error(unavailableMessage);
  return channel;
}

/** Formats a readable channel name consistently for resolution errors. */
function formatChannelName(value: string): string {
  return `#${value.replace(/^#+/, "").trim()}`;
}
