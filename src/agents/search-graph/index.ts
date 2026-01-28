// src/agents/search-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SpecStore } from '../../specs/index.js';
import { buildSearchGraph } from './graph.js';
import type { SessionInfo } from '../login-graph/state.js';
import type { SearchGraphStateType } from './state.js';
import type { SearchResult, SearchSpec } from '../../schemas/index.js';

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

export class SearchGraph {
  private config: SearchGraphConfig;

  constructor(config: SearchGraphConfig) {
    this.config = config;
  }

  async run(): Promise<{
    result: SearchResult;
    spec: SearchSpec;
    readyForDiscount: boolean;
  }> {
    const timestamp = new Date().toISOString();

    try {
      // Set node context (MCP is passed from LoginGraph, no lifecycle management here)
      setNodeContext({
        mcpClient: this.config.mcpClient,
        specStore: this.config.specStore,
        llm: this.config.llm,
        systemCode: this.config.systemCode,
        carNum: this.config.carNum,
      });

      const graph = buildSearchGraph();
      console.log('  [SearchGraph] Starting search workflow...');

      const initialState: Partial<SearchGraphStateType> = {
        systemCode: this.config.systemCode,
        url: this.config.url,
        carNum: this.config.carNum,
        session: this.config.session,
      };

      const finalState = await graph.invoke(initialState);

      console.log(`  [SearchGraph] Complete. Status: ${finalState.status}`);

      // Build SearchResult from final state
      const result: SearchResult = {
        status: finalState.status as SearchResult['status'],
        confidence: finalState.confidence,
        details: {
          vehicleFound: !!finalState.vehicle,
          searchMethod: finalState.searchMethod === 'api' ? 'api' : 'dom',
          resultCount: finalState.resultCount,
          errorMessage: finalState.errorMessage || undefined,
        },
        vehicle: finalState.vehicle
          ? {
              id: finalState.vehicle.id || '',
              plateNumber: finalState.vehicle.plateNumber,
              inTime: finalState.vehicle.inTime,
              outTime: finalState.vehicle.outTime,
            }
          : undefined,
        changes: finalState.specChanges?.hasChanges
          ? {
              hasChanges: true,
              codeWillBreak: finalState.specChanges.codeWillBreak,
              breakingChanges: finalState.specChanges.changes,
              summary: finalState.specChanges.changes.join(', '),
            }
          : undefined,
        timestamp,
      };

      // Build SearchSpec from final state
      const spec: SearchSpec = {
        systemCode: this.config.systemCode,
        url: this.config.url,
        capturedAt: timestamp,
        searchType: finalState.searchMethod === 'api' ? 'api' : 'dom',
        form: finalState.formElements?.searchInputSelector
          ? {
              searchInputSelector: finalState.formElements.searchInputSelector,
              searchButtonSelector: finalState.formElements.searchButtonSelector || '',
            }
          : undefined,
        resultIndicators: {},
        version: 1,
      };

      return {
        result,
        spec,
        readyForDiscount: finalState.readyForDiscount,
      };
    } finally {
      // Always clear node context
      clearNodeContext();
    }
  }
}

// Re-export types
export type { SearchGraphStateType } from './state.js';
