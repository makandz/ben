import { Client, Events } from "discord.js";
import { TARGET_CHANNEL_ID } from "../../config.js";
import { DEBUG } from "../../config/runtime.js";
import { isTextChannel } from "../../utils/is-text-channel.js";

const registerReady = (client: Client) => {
  /**
   * Once the client is ready, we're alive!
   */
  client.once(Events.ClientReady, async (readyClient) => {
    const channel = await readyClient.channels.fetch(TARGET_CHANNEL_ID);

    if (!isTextChannel(channel)) {
      return console.error(
        "Target channel is not text-based, not found, or is a PartialGroupDMChannel."
      );
    }

    console.log(`Logged in as ${readyClient.user.tag}`);
    await channel.send(`hello world! (debug: ${DEBUG.toString()})`);
  });
};

export { registerReady };
