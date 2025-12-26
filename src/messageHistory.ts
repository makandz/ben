import { config } from "./config.js";

const TTL_MINUTES = 5;

export type HistoryMessage = {
  username: string;
  content: string;
  timestamp: number;
};

const history: HistoryMessage[] = [];

export const addMessage = (username: string, content: string): void => {
  history.push({ username, content, timestamp: Date.now() });

  // FIFO
  while (history.length > config.maxHistorySize) {
    history.shift();
  }
};

export const getHistory = (): HistoryMessage[] => {
  const now = Date.now();
  const ttlMs = TTL_MINUTES * 60 * 1000;

  // Remove expired messages
  while (history.length > 0 && now - history[0].timestamp > ttlMs) {
    history.shift();
  }

  return history;
};
