// src/agents/pr-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CapturedApiSchema } from '../search-graph/state.js';

export interface PRGraphConfig {
  systemCode: string;
  changeType: 'dom' | 'api';
  changes: string[];
  capturedApiSchema?: CapturedApiSchema;
  mcpClient: Client;  // GitHub MCP client
  llm: BaseChatModel;
}

export interface NodeContext {
  mcpClient: Client;
  llm: BaseChatModel;
  systemCode: string;
  repoOwner: string;
  repoName: string;
}

let _nodeContext: NodeContext | null = null;

export function getNodeContext(): NodeContext {
  if (!_nodeContext) {
    throw new Error('PRGraph node context not initialized');
  }
  return _nodeContext;
}

export function setNodeContext(ctx: NodeContext): void {
  _nodeContext = ctx;
}

export function clearNodeContext(): void {
  _nodeContext = null;
}

// Re-export state types
export type { PRGraphStateType } from './state.js';
