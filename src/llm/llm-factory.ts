// src/llm/llm-factory.ts
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';

export type ModelTier = 'fast' | 'balanced' | 'powerful';
export type AgentType = 'login' | 'search';

// Available models
const MODELS = {
  gemini: 'dev/gemini-3.0-pro',
  gpt: 'dev/gpt-5.2-chat',
};

// Model mappings by tier
const TIER_MODELS: Record<ModelTier, string> = {
  fast: MODELS.gemini,
  balanced: MODELS.gpt,
  powerful: MODELS.gpt,
};

// Default tiers per agent (cost optimization)
const AGENT_DEFAULT_TIERS: Record<AgentType, ModelTier> = {
  login: 'balanced',  // Form detection needs reasoning
  search: 'fast',     // Simpler task after login
};

/**
 * Create LLM using internal AI router
 */
export function createLLM(model?: string): BaseChatModel {
  const finalModel = model || process.env.INTERNAL_AI_MODEL || MODELS.gpt;

  if (!process.env.INTERNAL_AI_URL || !process.env.INTERNAL_AI_KEY) {
    throw new Error('INTERNAL_AI_URL and INTERNAL_AI_KEY must be set');
  }

  console.log(`  [LLM] Model: ${finalModel}`);

  return new ChatOpenAI({
    model: finalModel,
    apiKey: process.env.INTERNAL_AI_KEY,
    maxTokens: -1,
    configuration: {
      baseURL: process.env.INTERNAL_AI_URL,
    },
  });
}

/**
 * Create LLM for specific agent with default tier
 * Supports environment variable overrides: AGENT_{TYPE}_TIER, AGENT_{TYPE}_MODEL
 */
export function createLLMForAgent(agentType: AgentType): BaseChatModel {
  const envPrefix = `AGENT_${agentType.toUpperCase()}`;

  // Check for env overrides
  const modelOverride = process.env[`${envPrefix}_MODEL`];
  if (modelOverride) {
    return createLLM(modelOverride);
  }

  const tierOverride = process.env[`${envPrefix}_TIER`] as ModelTier | undefined;
  const tier = tierOverride || AGENT_DEFAULT_TIERS[agentType];
  const model = TIER_MODELS[tier];

  return createLLM(model);
}
