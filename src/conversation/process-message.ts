import { Type } from "@google/genai";
import { TextChannel } from "discord.js";
import { DEBUG } from "../config/runtime.js";
import { queryGemini } from "../query-gemini.js";
import { messageQueue, processQueue } from "./queue.js";

let processMessageArgs: {
  prompt: string;
  channel: TextChannel;
} | null = null;

const getProcessMessageArgs = () => processMessageArgs;
const setProcessMessageArgs = (
  args: {
    prompt: string;
    channel: TextChannel;
  } | null
) => {
  processMessageArgs = args;
};

const processMessage = async () => {
  if (!processMessageArgs) {
    return;
  }

  const { prompt, channel } = processMessageArgs;

  const thinkingRaw = await queryGemini(
    prompt,
    "think-should-respond",
    {
      type: Type.OBJECT,
      properties: {
        shouldRespond: {
          type: Type.BOOLEAN,
        },
        thinking: {
          type: Type.STRING,
        },
      },
      required: ["thinking", "shouldRespond"],
    },
    100
  );

  let shouldRespond: {
    shouldRespond: boolean;
    thinking: string;
  } | null = null;
  try {
    shouldRespond = JSON.parse(thinkingRaw);
  } catch (error) {
    console.error("Error parsing JSON response:", error);
  }

  if (!shouldRespond) {
    channel.send("my brain has shut down, please try again in a moment");
    return;
  }

  if (DEBUG) {
    await channel.send(`> 🤔 ${shouldRespond.thinking}`);
  }

  if (!shouldRespond || !shouldRespond.shouldRespond) {
    console.log("Not responding to the message.");
    processMessageArgs = null;
    return;
  }

  const response = await queryGemini(prompt, "conversation");

  response.split("\n\n").forEach((part) => {
    const partParsed = part.replaceAll(/\n/g, " ").trim();
    if (!partParsed || partParsed === "N/A") {
      return;
    }

    messageQueue.push({
      content: partParsed,
      channel: channel,
    });
  });

  // Clear the processMessageArgs before processing the queue
  processMessageArgs = null;
  processQueue();
};

export { getProcessMessageArgs, processMessage, setProcessMessageArgs };
