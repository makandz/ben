import { User } from "discord.js";

const channelHistory: {
  author: User;
  content: string;
}[] = [];

/**
 * Adds a message to the channel history. Maintains a maximum length of 20 messages.
 * @param message - The message to add to the history.
 */
const addToChannelHistory = (message: { author: User; content: string }) => {
  channelHistory.push(message);
  if (channelHistory.length > 20) {
    channelHistory.shift();
  }
};

export { addToChannelHistory, channelHistory };
