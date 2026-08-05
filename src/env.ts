import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
	DISCORD_BOT_TOKEN: z.string().trim().min(1),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
	throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
}

export const env = result.data;
