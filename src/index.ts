import { Client, Events, GatewayIntentBits } from "discord.js";

import { env } from "./env.js";

const bot = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

bot.once(Events.ClientReady, (client) => {
	console.log(`Logged in as ${client.user.tag}`);
});

bot.on(Events.MessageCreate, async (message) => {
	if (message.author.bot || !bot.user || !message.mentions.users.has(bot.user.id)) {
		return;
	}

	try {
		await message.reply("pong");
	} catch (error: unknown) {
		console.error("Failed to reply to mention", error);
	}
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => bot.destroy());
}

bot.login(env.DISCORD_BOT_TOKEN).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
