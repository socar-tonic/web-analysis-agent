// src/agents/pr-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CapturedApiSchema } from '../search-graph/state.js';
import { buildPRGraph } from './graph.js';
import type { PRGraphStateType } from './state.js';

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

export interface PRGraphResult {
  status: 'success' | 'failed';
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  errorMessage?: string;
}

export class PRGraph {
  private config: PRGraphConfig;

  constructor(config: PRGraphConfig) {
    this.config = config;
  }

  async run(): Promise<PRGraphResult> {
    const repoOwner = process.env.BATCH_REPO_OWNER || 'socar-inc';
    const repoName = process.env.BATCH_REPO_NAME || 'modu-batch-webdc';

    try {
      setNodeContext({
        mcpClient: this.config.mcpClient,
        llm: this.config.llm,
        systemCode: this.config.systemCode,
        repoOwner,
        repoName,
      });

      const graph = buildPRGraph();

      console.log(`[PRGraph] Starting PR generation for ${this.config.systemCode}...`);

      const initialState: Partial<PRGraphStateType> = {
        systemCode: this.config.systemCode,
        changeType: this.config.changeType,
        changes: this.config.changes,
        capturedApiSchema: this.config.capturedApiSchema || null,
      };

      const finalState = await graph.invoke(initialState);

      console.log(`[PRGraph] Complete. Status: ${finalState.status}`);

      // Map status: pending should not happen after completion, treat as failed
      const resultStatus: 'success' | 'failed' = finalState.status === 'success' ? 'success' : 'failed';

      return {
        status: resultStatus,
        prUrl: finalState.prUrl || undefined,
        prNumber: finalState.prNumber || undefined,
        branchName: finalState.branchName || undefined,
        errorMessage: finalState.errorMessage || undefined,
      };
    } finally {
      clearNodeContext();
    }
  }
}
