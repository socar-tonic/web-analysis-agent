// src/llm/llm-factory.ts
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

export type ModelTier = 'fast' | 'balanced' | 'powerful';
export type AgentType = 'login' | 'search';

export interface LLMConfig {
  tier?: ModelTier;
  provider?: 'internal' | 'google' | 'openai' | 'anthropic';
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// Provider preference order
type Provider = 'internal' | 'google' | 'openai' | 'anthropic';

// Model mappings by tier and provider
const TIER_MODELS: Record<ModelTier, Record<Provider, string>> = {
  fast: {
    internal: 'gpt-4o-mini',
    google: 'gemini-2.0-flash-lite',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022',
  },
  balanced: {
    internal: 'gpt-4o',
    google: 'gemini-2.5-flash',
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
  },
  powerful: {
    internal: 'gpt-4.1',
    google: 'gemini-2.5-pro',
    openai: 'gpt-4.1',
    anthropic: 'claude-opus-4-20250514',
  },
};

// Default tiers per agent (cost optimization)
const AGENT_DEFAULT_TIERS: Record<AgentType, ModelTier> = {
  login: 'balanced',  // Form detection needs reasoning
  search: 'fast',     // Simpler task after login
};

/**
 * Detect available provider from environment
 */
function detectProvider(): Provider {
  if (process.env.INTERNAL_AI_URL && process.env.INTERNAL_AI_KEY) {
    return 'internal';
  }
  if (process.env.GOOGLE_API_KEY) {
    return 'google';
  }
  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return 'anthropic';
  }
  throw new Error('No API key found. Set INTERNAL_AI_URL+INTERNAL_AI_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY');
}

/**
 * Create LLM instance with given config
 */
export function createLLM(config?: LLMConfig): BaseChatModel {
  const provider = config?.provider || detectProvider();
  const tier = config?.tier || 'balanced';
  const model = config?.model || TIER_MODELS[tier][provider];
  const temperature = config?.temperature ?? 0;
  const maxTokens = config?.maxTokens ?? 16384;

  console.log(`  [LLM] Provider: ${provider}, Model: ${model}, Tier: ${tier}`);

  switch (provider) {
    case 'internal':
      return new ChatOpenAI({
        model,
        apiKey: process.env.INTERNAL_AI_KEY,
        maxTokens: -1,
        configuration: {
          baseURL: process.env.INTERNAL_AI_URL,
        },
      });

    case 'google':
      return new ChatGoogleGenerativeAI({
        model,
        temperature,
        maxOutputTokens: maxTokens,
        apiKey: process.env.GOOGLE_API_KEY,
      });

    case 'openai':
      return new ChatOpenAI({
        model,
        temperature,
        maxTokens,
      });

    case 'anthropic':
      return new ChatAnthropic({
        model,
        temperature,
        maxTokens,
      });

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Create LLM for specific agent with default tier
 * Supports environment variable overrides: AGENT_{TYPE}_TIER, AGENT_{TYPE}_MODEL
 */
export function createLLMForAgent(agentType: AgentType): BaseChatModel {
  const envPrefix = `AGENT_${agentType.toUpperCase()}`;

  // Check for env overrides
  const tierOverride = process.env[`${envPrefix}_TIER`] as ModelTier | undefined;
  const modelOverride = process.env[`${envPrefix}_MODEL`];

  const tier = tierOverride || AGENT_DEFAULT_TIERS[agentType];

  return createLLM({
    tier,
    model: modelOverride,
  });
}
