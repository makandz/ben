import { Client, TextChannel } from "discord.js";
import { convertUsernamesToMentions } from "../discord/mentions.js";
import { addToChannelHistory } from "./history.js";
import { setLastInvolved } from "./state.js";
import { calculateTypingSpeed } from "./typing.js";

type QueuedMessage = {
  content: string;
  channel: TextChannel;
};

const messageQueue: QueuedMessage[] = [];

let clientRef: Client | null = null;
let isRunning = false;
let generation = 0;
let currentAbortController: AbortController | null = null;

const setQueueClient = (client: Client) => {
  clientRef = client;
};

const cancelQueue = () => {
  generation += 1;
  messageQueue.length = 0;

  if (currentAbortController && !currentAbortController.signal.aborted) {
    currentAbortController.abort();
  }
};

const cancellableSleep = (duration: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      return reject(new Error("aborted"));
    }

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);

    signal.addEventListener("abort", onAbort);
  });

const runQueue = async () => {
  if (isRunning) {
    return;
  }

  isRunning = true;
  const runGeneration = generation;

  try {
    while (messageQueue.length > 0 && generation === runGeneration) {
      const message = messageQueue.shift()!;
      const controller = new AbortController();
      currentAbortController = controller;

      await message.channel.sendTyping();

      const typingDuration = calculateTypingSpeed(message.content);
      console.log(
        `Simulating typing for "${message.content}" in ${typingDuration}ms`
      );

      try {
        await cancellableSleep(typingDuration, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Typing delay failed:", error);
        }
        break;
      }

      if (controller.signal.aborted || generation !== runGeneration) {
        break;
      }

      const convertedContent = await convertUsernamesToMentions(
        message.channel.guild,
        message.content
      );

      if (controller.signal.aborted || generation !== runGeneration) {
        break;
      }

      addToChannelHistory({
        author: clientRef!.user!,
        content: message.content, // Store original content in history
      });

      setLastInvolved(new Date().getTime());
      await message.channel.send(convertedContent);

      currentAbortController = null;
    }
  } finally {
    currentAbortController = null;
    isRunning = false;

    if (messageQueue.length > 0) {
      processQueue();
    }
  }
};

const processQueue = () => {
  if (isRunning || messageQueue.length === 0) {
    return;
  }

  runQueue().catch((error) =>
    console.error("Error processing message queue:", error)
  );
};

export {
  cancelQueue as clearConversationTimeout,
  messageQueue,
  processQueue,
  setQueueClient,
};
