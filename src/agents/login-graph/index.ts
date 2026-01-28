// src/agents/login-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildLoginGraph } from './graph.js';
import { CredentialManager } from '../../security/index.js';
import { SpecStore } from '../../specs/index.js';
import type { LoginGraphStateType, SessionInfo, LoginStatus } from './state.js';
import type { LoginResult, LoginSpec } from '../../schemas/index.js';

export interface LoginGraphConfig {
  systemCode: string;
  url: string;
  credentialManager: CredentialManager;
  specStore: SpecStore;
  llm: BaseChatModel;
  mcpClient?: Client; // External MCP client for session sharing
}

// Global context for nodes to access MCP and other dependencies
export interface NodeContext {
  mcpClient: Client;
  credentialManager: CredentialManager;
  specStore: SpecStore;
  llm: BaseChatModel;
  systemCode: string;
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

export class LoginGraph {
  private config: LoginGraphConfig;
  private mcpClient: Client | null = null;
  private externalMcp: boolean = false;

  constructor(config: LoginGraphConfig) {
    this.config = config;
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
      this.externalMcp = true;
    }
  }

  async run(): Promise<{ result: LoginResult; spec: LoginSpec }> {
    const timestamp = new Date().toISOString();

    try {
      // Start MCP server if not external
      if (!this.externalMcp) {
        const transport = new StdioClientTransport({
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless', '--isolated'],
        });

        this.mcpClient = new Client({ name: 'login-graph', version: '1.0.0' });
        await this.mcpClient.connect(transport);
        console.log('  [LoginGraph] MCP connected');
      } else {
        console.log('  [LoginGraph] Using shared MCP client');
      }

      // Set node context for all nodes to access
      setNodeContext({
        mcpClient: this.mcpClient!,
        credentialManager: this.config.credentialManager,
        specStore: this.config.specStore,
        llm: this.config.llm,
        systemCode: this.config.systemCode,
      });

      // Build and run graph
      const graph = buildLoginGraph();
      console.log('  [LoginGraph] Graph compiled, starting execution...');

      const initialState: Partial<LoginGraphStateType> = {
        systemCode: this.config.systemCode,
        url: this.config.url,
      };

      const finalState = await graph.invoke(initialState);

      console.log(`  [LoginGraph] Execution complete. Status: ${finalState.status}`);

      // Build result
      const result: LoginResult = {
        status: finalState.status as LoginResult['status'],
        confidence: finalState.confidence,
        details: {
          urlBefore: this.config.url,
          urlAfter: finalState.currentUrl,
          urlChanged: this.config.url !== finalState.currentUrl,
          errorMessage: finalState.errorMessage || undefined,
        },
        session: finalState.session || undefined,
        // Include spec changes in result
        changes: finalState.specChanges?.hasChanges
          ? {
              hasChanges: true,
              codeWillBreak: true, // Spec changes indicate potential code breakage
              breakingChanges: finalState.specChanges.changes,
              summary: `[${finalState.specChanges.changeType}] ${finalState.specChanges.changes.join(', ')}`,
            }
          : undefined,
        timestamp,
      };

      // Build spec
      const spec: LoginSpec = {
        systemCode: this.config.systemCode,
        url: this.config.url,
        capturedAt: timestamp,
        version: 1,
        loginType: 'dom', // Will be updated based on analysis
        form: finalState.formElements?.usernameRef
          ? {
              usernameSelector: finalState.formElements.usernameRef,
              passwordSelector: finalState.formElements.passwordRef || '',
              submitSelector: finalState.formElements.submitRef || '',
            }
          : undefined,
        successIndicators: {
          urlPattern: finalState.currentUrl,
        },
      };

      return { result, spec };
    } finally {
      // Clean up MCP if we created it
      if (this.mcpClient && !this.externalMcp) {
        await this.mcpClient.close().catch(() => {});
        console.log('  [LoginGraph] MCP closed');
      }
      _nodeContext = null;
    }
  }
}

// Re-export types
export type { LoginGraphStateType, SessionInfo, LoginStatus } from './state.js';
