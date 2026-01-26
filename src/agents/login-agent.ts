// src/agents/login-agent.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { CredentialManager } from '../security/index.js';
import { SpecStore, SpecChanges } from '../specs/index.js';
import { LoginSpec, LoginResult } from '../schemas/index.js';

interface LoginAgentConfig {
  systemCode: string;
  url: string;
  credentialManager: CredentialManager;
  specStore: SpecStore;
  llm: BaseChatModel;
  maxIterations?: number;
}

interface ParsedAnalysis {
  status?: LoginResult['status'];
  confidence?: number;
  loginType?: LoginSpec['loginType'];
  form?: LoginSpec['form'];
  api?: LoginSpec['api'];
  successIndicators?: LoginSpec['successIndicators'];
  errorMessage?: string;
}

export class LoginAgent {
  private config: Required<LoginAgentConfig>;
  private mcpClient: Client | null = null;
  private networkLogs: { url: string; method: string; status?: number; body?: string }[] = [];

  constructor(config: LoginAgentConfig) {
    this.config = { maxIterations: 15, ...config };
  }

  async run(): Promise<{ result: LoginResult; spec: LoginSpec }> {
    const timestamp = new Date().toISOString();
    let urlBefore = this.config.url;
    let urlAfter = this.config.url;
    let capturedSpec: Partial<LoginSpec> = {
      systemCode: this.config.systemCode,
      url: this.config.url,
      capturedAt: timestamp,
      version: 1,
    };

    try {
      // Start MCP server
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
      });

      this.mcpClient = new Client({ name: 'login-agent', version: '1.0.0' });
      await this.mcpClient.connect(transport);
      console.log('  [LoginAgent] MCP connected');

      // Build tools
      const tools = await this.buildTools();
      console.log(`  [LoginAgent] ${tools.length} tools ready`);

      // Run agent loop
      const messages = this.buildInitialMessages();
      let iteration = 0;
      let finalResponse = '';

      console.log('\n  [Agent Loop]');
      const maxIter = this.config.maxIterations;
      while (iteration < maxIter) {
        iteration++;
        console.log(`  --- Iteration ${iteration}/${maxIter} ---`);

        const llmWithTools = this.config.llm.bindTools!(tools);
        const response = await llmWithTools.invoke(messages);
        messages.push(response);

        const toolCalls = response.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          finalResponse = response.content as string;
          break;
        }

        for (const tc of toolCalls) {
          console.log(`    -> ${tc.name}`);
          const result = await this.executeTool(tc, tools);
          messages.push(new ToolMessage({ tool_call_id: tc.id!, content: result }));

          // Update URL tracking
          if (tc.name === 'browser_navigate') urlBefore = tc.args.url;
          if (result.includes('Page URL:')) {
            const match = result.match(/Page URL: ([^\n]+)/);
            if (match) urlAfter = match[1];
          }
        }
      }

      // Parse LLM's final analysis
      const analysis = this.parseAnalysis(finalResponse);

      // Build final spec
      const spec: LoginSpec = {
        ...capturedSpec,
        loginType: analysis.loginType || 'dom',
        form: analysis.form,
        api: analysis.api,
        successIndicators: analysis.successIndicators || { urlPattern: urlAfter },
      } as LoginSpec;

      // Compare with existing spec
      const changes: SpecChanges = this.config.specStore.compare(this.config.systemCode, spec);

      // Save new spec
      this.config.specStore.save(spec);

      const result: LoginResult = {
        status: analysis.status || 'UNKNOWN_ERROR',
        confidence: analysis.confidence || 0.5,
        details: {
          urlBefore,
          urlAfter,
          urlChanged: urlBefore !== urlAfter,
          errorMessage: analysis.errorMessage,
        },
        changes,
        timestamp,
      };

      return { result, spec };

    } catch (error) {
      return {
        result: {
          status: 'UNKNOWN_ERROR',
          confidence: 0,
          details: { urlBefore, urlAfter, urlChanged: false, errorMessage: (error as Error).message },
          timestamp,
        },
        spec: capturedSpec as LoginSpec,
      };
    } finally {
      if (this.mcpClient) await this.mcpClient.close().catch(() => {});
      console.log('  [LoginAgent] MCP closed');
    }
  }

  private async buildTools(): Promise<any[]> {
    const { tools: mcpTools } = await this.mcpClient!.listTools();

    // Filter MCP tools - exclude browser_type (we use secure_fill instead)
    const allowedTools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_wait_for', 'browser_press_key'];
    const filtered = mcpTools.filter(t => {
      const schema = t.inputSchema as any;
      const hasParams = schema?.properties && Object.keys(schema.properties).length > 0;
      return hasParams || allowedTools.includes(t.name);
    }).filter(t => t.name !== 'browser_type'); // Use secure_fill instead

    const langchainTools: any[] = filtered.map(t => this.convertMcpTool(t));

    // Add secure_fill_credential
    langchainTools.push(this.createSecureFillTool());

    return langchainTools;
  }

  private createSecureFillTool() {
    return tool(
      async ({ field, element }) => {
        if (field !== 'username' && field !== 'password') {
          return `Error: Invalid field "${field}"`;
        }
        const value = this.config.credentialManager.getField(this.config.systemCode, field);
        if (!value) return `Error: No credential for ${this.config.systemCode}`;

        try {
          await this.mcpClient!.callTool({
            name: 'browser_type',
            arguments: { element, text: value, submit: false },
          });
          return `Filled ${field} field`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'secure_fill_credential',
        description: 'Fill username or password field securely. Actual value is injected internally.',
        schema: z.object({
          field: z.enum(['username', 'password']),
          element: z.string().describe('Element reference from snapshot'),
        }),
      }
    );
  }

  private convertMcpTool(mcpTool: any) {
    const inputSchema = mcpTool.inputSchema as any;
    const shape: Record<string, z.ZodTypeAny> = {};

    if (inputSchema?.properties) {
      for (const [key, val] of Object.entries(inputSchema.properties)) {
        const prop = val as any;
        const isRequired = inputSchema.required?.includes(key);
        if (prop.type === 'string') {
          shape[key] = isRequired ? z.string() : z.string().optional();
        } else if (prop.type === 'number') {
          shape[key] = isRequired ? z.number() : z.number().optional();
        } else if (prop.type === 'boolean') {
          shape[key] = isRequired ? z.boolean() : z.boolean().optional();
        } else {
          shape[key] = z.any();
        }
      }
    }

    const zodSchema = Object.keys(shape).length > 0
      ? z.object(shape)
      : z.object({ _unused: z.string().optional() });

    return tool(
      async (params) => {
        try {
          const result = await this.mcpClient!.callTool({ name: mcpTool.name, arguments: params });
          const text = (result.content as any[])?.map(c => c.text || '').join('\n') || 'Done';
          return text.slice(0, 5000);
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
      { name: mcpTool.name, description: mcpTool.description || mcpTool.name, schema: zodSchema }
    );
  }

  private buildInitialMessages() {
    const systemPrompt = `You are a login flow analyzer for: ${this.config.url}
SystemCode: ${this.config.systemCode}

**TASK:**
1. Navigate to URL, take snapshot
2. Find login form (username, password, submit button)
3. Fill credentials using secure_fill_credential
4. Click submit
5. Analyze result

**TOOLS:**
- browser_navigate, browser_snapshot, browser_click, browser_wait_for
- secure_fill_credential(field: "username"|"password", element: "ref from snapshot")

**IMPORTANT:**
- Use secure_fill_credential for ALL credential inputs
- NEVER type passwords directly
- After login, determine: SUCCESS / INVALID_CREDENTIALS / FORM_CHANGED

**FINAL RESPONSE (JSON):**
{
  "status": "SUCCESS|INVALID_CREDENTIALS|FORM_CHANGED|API_CHANGED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "loginType": "dom|api|hybrid",
  "form": {
    "usernameSelector": "actual selector used",
    "passwordSelector": "actual selector used",
    "submitSelector": "actual selector used"
  },
  "successIndicators": { "urlPattern": "..." },
  "errorMessage": "if any"
}`;

    return [
      new SystemMessage(systemPrompt),
      new HumanMessage('Start: Navigate to the login page.'),
    ] as (SystemMessage | HumanMessage | AIMessage | ToolMessage)[];
  }

  private async executeTool(tc: any, tools: any[]): Promise<string> {
    const t = tools.find(x => x.name === tc.name);
    if (!t) return `Error: Tool not found`;
    try {
      return await t.invoke(tc.args);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  private parseAnalysis(response: string): ParsedAnalysis {
    try {
      const match = response.match(/```json\s*([\s\S]*?)\s*```/) || [null, response];
      return JSON.parse(match[1] || response);
    } catch {
      return { status: 'UNKNOWN_ERROR', confidence: 0 };
    }
  }
}
