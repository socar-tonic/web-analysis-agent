// src/agents/search-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SpecStore } from '../../specs/index.js';
import type { SessionInfo } from '../login-graph/state.js';

export interface SearchGraphConfig {
  systemCode: string;
  url: string;
  carNum: string;
  session: SessionInfo;
  specStore: SpecStore;
  llm: BaseChatModel; // SearchGraph 전용 LLM (별도 모델 가능)
  mcpClient: Client; // LoginGraph에서 전달받은 MCP 클라이언트 (필수)
}

// Global context for nodes to access MCP and other dependencies
export interface NodeContext {
  mcpClient: Client;
  specStore: SpecStore;
  llm: BaseChatModel;
  systemCode: string;
  carNum: string;
}

// This will be set before graph execution
let _nodeContext: NodeContext | null = null;

export function getNodeContext(): NodeContext {
  if (!_nodeContext) {
    throw new Error('Node context not initialized. Call setNodeContext first.');
  }
  return _nodeContext;
}

export function setNodeContext(ctx: NodeContext): void {
  _nodeContext = ctx;
}

export function clearNodeContext(): void {
  _nodeContext = null;
}
