import { Client, Events, GatewayIntentBits, type Message } from "discord.js";

import { env } from "./env.js";
import { createOpenAILanguageModelClient } from "./llm/providers/openai.js";

const FAILURE_MESSAGE = "Sorry, I couldn't generate a response right now.";

const languageModelClient = await createOpenAILanguageModelClient({
	apiKey: env.OPENAI_API_KEY,
	model: env.OPENAI_MODEL,
	reasoningEffort: env.OPENAI_REASONING_EFFORT,
});

const bot = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

/** Logs the connected bot identity when Discord reports it ready. */
function handleReady(client: Client<true>): void {
	console.log(`Logged in as ${client.user.tag}`);
}

/** Removes the bot's Discord mention tokens from a message. */
function removeBotMention(content: string, botUserId: string): string {
	return content
		.replaceAll(`<@${botUserId}>`, "")
		.replaceAll(`<@!${botUserId}>`, "")
		.trim();
}

/** Attempts to tell the user that their response could not be generated. */
async function replyWithFailure(message: Message): Promise<void> {
	try {
		await message.reply(FAILURE_MESSAGE);
	} catch (error: unknown) {
		console.error("Failed to send generation failure reply", error);
	}
}

/** Replies to Discord messages that mention the bot. */
async function handleMessage(message: Message): Promise<void> {
	if (message.author.bot || !bot.user || !message.mentions.users.has(bot.user.id)) {
		return;
	}

	const content = removeBotMention(message.content, bot.user.id);

	if (!content) {
		return;
	}

	try {
		if ("sendTyping" in message.channel) {
			await message.channel.sendTyping();
		}

		const response = await languageModelClient.generateResponse({ message: content });
		await message.reply(response.text);
	} catch (error: unknown) {
		console.error("Failed to generate reply to mention", error);
		await replyWithFailure(message);
	}
}

/** Shuts down the Discord client during process termination. */
function destroyBot(): void {
	bot.destroy();
}

/** Records a Discord login failure without forcing an abrupt process exit. */
function handleLoginError(error: unknown): void {
	console.error(error);
	process.exitCode = 1;
}

bot.once(Events.ClientReady, handleReady);

bot.on(Events.MessageCreate, handleMessage);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, destroyBot);
}

bot.login(env.DISCORD_BOT_TOKEN).catch(handleLoginError);
