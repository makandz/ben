import { Client } from "discord.js";
import {
  processMessage,
  getProcessMessageArgs,
} from "../../conversation/process-message.js";
import {
  clearWaitingTimeout,
  setWaitingTimeout,
} from "../../conversation/timeouts.js";
import { clearConversationTimeout } from "../../conversation/queue.js";

const registerTypingStart = (client: Client) => {
  client.on("typingStart", (typing) => {
    if (typing.user.id === client.user?.id) {
      return;
    }

    clearConversationTimeout();

    if (!getProcessMessageArgs()) {
      return;
    }

    clearWaitingTimeout();
    setWaitingTimeout(setTimeout(processMessage, 3000));
  });
};

export { registerTypingStart };
