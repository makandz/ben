import type { ActivityPresence, PresenceTransport } from "../app/PresenceTransport.js";
import type { DiscordGateway } from "./DiscordGateway.js";

/** Applies application presence without exposing discord.js activity types. */
export class DiscordPresence implements PresenceTransport {
  /**
   * Creates a Discord presence transport.
   *
   * @param gateway - Discord boundary that applies presence changes.
   */
  constructor(private readonly gateway: DiscordGateway) {}

  /**
   * Applies Ben's online/idle state and optional activity text.
   *
   * @param presence - Provider-neutral presence state to display.
   */
  setPresence(presence: ActivityPresence): void {
    this.gateway.setPresence(presence.status, presence.activity);
  }
}
