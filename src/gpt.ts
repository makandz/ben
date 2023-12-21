import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import gptConfig from './gpt.config.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env['OPENAI_KEY'], // This is the default and can be omitted
});

const SYSTEM_MESSAGE = {
  role: 'system',
  content: gptConfig.systemMessage,
};

const messageHistory = [];

export async function generateMessageMemory(userMessage: string) {
  const message = (await openai.chat.completions.create({
    messages: [SYSTEM_MESSAGE, ...messageHistory, { role: 'user', content: userMessage }],
    model: 'gpt-4-1106-preview',
  })).choices[0].message;

  return message.content.split(/[.!\n]+/);
}