import { config } from "./config.js";

type HistoryMessage = {
  username: string;
  content: string;
};

const history: HistoryMessage[] = [];

export const addMessage = (username: string, content: string): void => {
  history.push({ username, content });

  // FIFO
  while (history.length > config.maxHistorySize) {
    history.shift();
  }

  if (config.debug) {
    console.log(`[DEBUG] 📔 Added message from ${username}: ${content}`);
  }
};

export const getHistory = (): HistoryMessage[] => {
  return history;
};
