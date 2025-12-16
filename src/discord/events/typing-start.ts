import { Client } from "discord.js";
import {
  processMessage,
  getProcessMessageArgs,
} from "../../conversation/process-message.js";
import {
  clearWaitingTimeout,
  setWaitingTimeout,
} from "../../conversation/timeouts.js";

const registerTypingStart = (client: Client) => {
  client.on("typingStart", (typing) => {
    if (typing.user.id === client.user?.id || !getProcessMessageArgs()) {
      return;
    }

    if (clearWaitingTimeout) {
      clearWaitingTimeout();
    }

    setWaitingTimeout(setTimeout(processMessage, 3000));
  });
};

export { registerTypingStart };
