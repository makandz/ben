export type PresenceState = {
  status: "idle" | "online";
};

export type PresenceTransport = {
  setPresence(presence: PresenceState): void;
};
