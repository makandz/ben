import { Client, Events, TextChannel } from "discord.js";
import { TARGET_CHANNEL_ID } from "../../config.js";
import {
  addToChannelHistory,
  channelHistory,
} from "../../conversation/history.js";
import {
  processMessage,
  setProcessMessageArgs,
} from "../../conversation/process-message.js";
import { clearConversationTimeout } from "../../conversation/queue.js";
import { getLastInvolved, setLastInvolved } from "../../conversation/state.js";
import {
  clearWaitingTimeout,
  setWaitingTimeout,
} from "../../conversation/timeouts.js";
import { memoryStore } from "../../memory.js";
import { getEmbedding } from "../../query-gemini.js";
import { isTextChannel } from "../../utils/is-text-channel.js";
import { convertMentionsToUsernames } from "../mentions.js";

const registerMessageCreate = (client: Client) => {
  /**
   * Listen for messages in the target channel.
   */
  client.on(Events.MessageCreate, async (message) => {
    if (
      message.author.bot ||
      message.channel.id !== TARGET_CHANNEL_ID ||
      !client.user ||
      !isTextChannel(message.channel)
    ) {
      return;
    }

    // Clear all timers, we starting again here.
    clearWaitingTimeout();
    clearConversationTimeout();

    // Convert mentions to usernames before adding to history
    const convertedContent = convertMentionsToUsernames(
      message.content,
      message
    );
    addToChannelHistory({
      author: message.author,
      content: convertedContent,
    });

    const isMentioned = message.mentions.has(client.user.id);
    const lastInvolved = getLastInvolved();
    if (
      !isMentioned &&
      (!lastInvolved || lastInvolved <= new Date().getTime() - 60000)
    ) {
      console.log(
        "Not mentioned and last ping was longer than a minute, ignoring message: ",
        message.content
      );
      return;
    }

    if (isMentioned) {
      setLastInvolved(new Date().getTime());
    }

    let content = message.content
      .replace(new RegExp(`<@!?${client?.user?.id}>`, "g"), "")
      .trim();

    if (!content) {
      console.log("No content after mention, ignoring message.");
      return;
    }

    // Handle memory commands
    if (content.startsWith("remember: ")) {
      const memoryContent = content.substring("remember: ".length).trim();
      try {
        const embedding = await getEmbedding(memoryContent);
        memoryStore.add(Date.now().toString(), embedding, memoryContent, {
          author: message.author.id,
          timestamp: Date.now(),
        });
        await message.channel.send("got it, i'll remember that");
      } catch (error) {
        console.error("Error storing memory:", error);
        await message.channel.send("sorry, couldn't store that in my memory");
      }
      return;
    }

    if (content.startsWith("query: ")) {
      const queryContent = content.substring("query: ".length).trim();
      try {
        const queryEmbedding = await getEmbedding(queryContent);
        const results = memoryStore.query(queryEmbedding, 1);

        if (results.length > 0 && results[0].score > 0.7) {
          await message.channel.send(
            `this reminds me of: ${results[0].content}`
          );
        } else {
          await message.channel.send(
            "hmm, nothing quite like that comes to mind"
          );
        }
      } catch (error) {
        console.error("Error querying memory:", error);
        await message.channel.send("sorry, had trouble searching my memories");
      }
      return;
    }

    let prompt: string = `Conversation:\n`;

    channelHistory.forEach((msg) => {
      prompt += `${msg.author.username}: ${msg.content}\n`;
    });

    setProcessMessageArgs({
      prompt,
      channel: message.channel as TextChannel,
    });

    setWaitingTimeout(setTimeout(processMessage, 3000));
  });
};

export { registerMessageCreate };
