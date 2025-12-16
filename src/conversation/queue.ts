import { Client, TextChannel } from "discord.js";
import { convertUsernamesToMentions } from "../discord/mentions.js";
import { addToChannelHistory } from "./history.js";
import { setLastInvolved } from "./state.js";
import { calculateTypingSpeed } from "./typing.js";

const messageQueue: {
  content: string;
  channel: TextChannel;
}[] = [];

let conversationTimeout: NodeJS.Timeout | null = null;
let typingMessage: string | null = null;
let clientRef: Client | null = null;

const setQueueClient = (client: Client) => {
  clientRef = client;
};

const clearConversationTimeout = () => {
  if (conversationTimeout) {
    clearTimeout(conversationTimeout);
    conversationTimeout = null;
  }
};

const processQueue = () => {
  typingMessage = null;
  if (conversationTimeout) {
    clearTimeout(conversationTimeout);
    conversationTimeout = null;
  }

  if (messageQueue.length === 0) {
    return;
  }

  const message = messageQueue.shift()!;
  message.channel.sendTyping();

  const typingDuration = calculateTypingSpeed(message.content);
  console.log(
    `Simulating typing for "${message.content}" in ${typingDuration}ms`
  );

  // Simulate typing
  conversationTimeout = setTimeout(async () => {
    typingMessage = message.content;

    // Convert any @username mentions to proper Discord mentions
    const convertedContent = await convertUsernamesToMentions(
      message.channel.guild,
      message.content
    );

    // Adds the bot's own message to the channel history
    addToChannelHistory({
      author: clientRef!.user!,
      content: message.content, // Store original content in history
    });

    setLastInvolved(new Date().getTime());
    await message.channel.send(convertedContent);

    // Process the next message in the queue
    processQueue();
  }, calculateTypingSpeed(message.content));
};

export { clearConversationTimeout, messageQueue, processQueue, setQueueClient };
