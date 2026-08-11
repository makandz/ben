export type ActivityPresence = {
  status: "idle" | "online";
  activity?: string;
};

export type PresenceTransport = {
  setPresence(presence: ActivityPresence): void;
};
