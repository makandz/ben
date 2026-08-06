export type GenerateResponseInput = {
	message: string;
};

export type GenerateResponseOutput = {
	text: string;
};

export interface LanguageModelClient {
	/**
	 * Generates a response for an application message.
	 *
	 * @param input - The provider-neutral response request.
	 * @returns The generated response in the application's format.
	 */
	generateResponse(input: GenerateResponseInput): Promise<GenerateResponseOutput>;
}
