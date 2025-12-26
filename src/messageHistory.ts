import { config } from "./config.js";

export type HistoryMessage = {
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
};

export const getHistory = (): HistoryMessage[] => {
  return history;
};
