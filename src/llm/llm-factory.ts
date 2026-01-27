// src/llm/llm-factory.ts
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';

export type AgentType = 'login' | 'search';

// Agent -> Model mapping
const AGENT_MODELS: Record<AgentType, string> = {
  login: 'dev/gemini-3-pro-preview',
  search: 'dev/gpt-5.2-chat',
};

export function createLLMForAgent(agentType: AgentType): BaseChatModel {
  const model = process.env[`AGENT_${agentType.toUpperCase()}_MODEL`] || AGENT_MODELS[agentType];

  console.log(`  [LLM] ${agentType}: ${model}`);

  return new ChatOpenAI({
    model,
    apiKey: process.env.INTERNAL_AI_KEY,
    maxTokens: -1,
    configuration: {
      baseURL: process.env.INTERNAL_AI_URL,
    },
  });
}
