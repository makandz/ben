/** Provider-neutral presence state displayed by the chat platform. */
export type ActivityPresence = {
  status: "idle" | "online";
  activity?: string;
};

/** Applies availability and activity state to the chat platform. */
export type PresenceTransport = {
  /**
   * Applies Ben's availability and optional custom activity.
   *
   * @param presence - Provider-neutral presence state to display.
   */
  setPresence(presence: ActivityPresence): void;
};
