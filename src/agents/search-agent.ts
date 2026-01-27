import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent, modelCallLimitMiddleware } from 'langchain';
import { SpecStore, SpecChanges } from '../specs/index.js';
import { SearchSpec, SearchResult } from '../schemas/index.js';

interface SessionInfo {
  type?: 'jwt' | 'cookie' | 'session' | 'mixed';
  accessToken?: string;
  cookies?: string[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface SearchAgentConfig {
  systemCode: string;
  url: string;
  carNum: string;
  session: SessionInfo;
  specStore: SpecStore;
  llm: BaseChatModel;
  maxIterations?: number;
}

interface ParsedAnalysis {
  status?: SearchResult['status'];
  confidence?: number;
  searchType?: SearchSpec['searchType'];
  form?: SearchSpec['form'];
  api?: SearchSpec['api'];
  resultIndicators?: SearchSpec['resultIndicators'];
  vehicle?: SearchResult['vehicle'];
  resultCount?: number;
  errorMessage?: string;
}

export class SearchAgent {
  private config: Required<SearchAgentConfig>;
  private mcpClient: Client | null = null;

  constructor(config: SearchAgentConfig) {
    this.config = { maxIterations: 15, ...config };
  }

  async run(): Promise<{ result: SearchResult; spec: SearchSpec }> {
    const timestamp = new Date().toISOString();
    let capturedSpec: Partial<SearchSpec> = {
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

      this.mcpClient = new Client({ name: 'search-agent', version: '1.0.0' });
      await this.mcpClient.connect(transport);
      console.log('  [SearchAgent] MCP connected');

      // Build tools
      const tools = await this.buildTools();
      console.log(`  [SearchAgent] ${tools.length} tools ready`);

      // Create LangChain agent
      const systemPrompt = this.buildSystemPrompt();
      const agent = createAgent({
        model: this.config.llm,
        tools: tools,
        systemPrompt: systemPrompt,
        middleware: [
          modelCallLimitMiddleware({
            runLimit: this.config.maxIterations,
            exitBehavior: 'end',
          }),
        ],
      });

      console.log('\n  [LangChain Agent] Starting search...');

      // Run agent
      const agentResult = await agent.invoke(
        { messages: [new HumanMessage('Start: Navigate and search for the vehicle.')] },
        { recursionLimit: this.config.maxIterations * 3 }
      );

      // Extract final response
      const messages = agentResult.messages as BaseMessage[];
      let finalResponse = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg instanceof AIMessage && typeof msg.content === 'string' && msg.content.trim()) {
          finalResponse = msg.content;
          break;
        }
      }

      console.log(`  [LangChain Agent] Completed with ${messages.length} messages`);

      // Parse analysis
      const analysis = this.parseAnalysis(finalResponse);

      // Build spec
      const spec: SearchSpec = {
        ...capturedSpec,
        searchType: analysis.searchType || 'dom',
        form: analysis.form,
        api: analysis.api,
        resultIndicators: analysis.resultIndicators || {},
      } as SearchSpec;

      // Compare with existing spec
      const changes: SpecChanges = await this.config.specStore.compare(
        `${this.config.systemCode}-search`,
        spec,
        this.config.llm
      );

      const searchResult: SearchResult = {
        status: analysis.status || 'UNKNOWN_ERROR',
        confidence: analysis.confidence || 0.5,
        details: {
          vehicleFound: !!analysis.vehicle,
          searchMethod: analysis.searchType || 'dom',
          resultCount: analysis.resultCount || 0,
          errorMessage: analysis.errorMessage,
        },
        vehicle: analysis.vehicle,
        changes,
        timestamp,
      };

      return { result: searchResult, spec };

    } catch (error) {
      return {
        result: {
          status: 'UNKNOWN_ERROR',
          confidence: 0,
          details: {
            vehicleFound: false,
            searchMethod: 'dom',
            resultCount: 0,
            errorMessage: (error as Error).message,
          },
          timestamp,
        },
        spec: capturedSpec as SearchSpec,
      };
    } finally {
      if (this.mcpClient) await this.mcpClient.close().catch(() => {});
      console.log('  [SearchAgent] MCP closed');
    }
  }

  private async buildTools(): Promise<any[]> {
    const { tools: mcpTools } = await this.mcpClient!.listTools();

    console.log('  [MCP Tools Available]');
    mcpTools.forEach(t => console.log(`    - ${t.name}`));

    // Filter tools - exclude browser_type (use secure_search_vehicle instead)
    const allowedTools = [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_wait_for',
      'browser_press_key',
      'browser_take_screenshot',
      'browser_network_requests',
      'browser_evaluate',
    ];
    const filtered = mcpTools.filter(t => {
      const schema = t.inputSchema as any;
      const hasParams = schema?.properties && Object.keys(schema.properties).length > 0;
      return hasParams || allowedTools.includes(t.name);
    }).filter(t => t.name !== 'browser_type');

    const langchainTools: any[] = filtered.map(t => this.convertMcpTool(t));

    // Add secure tools
    langchainTools.push(this.createSecureSearchTool());
    langchainTools.push(this.createInjectSessionTool());

    return langchainTools;
  }

  private createSecureSearchTool() {
    return tool(
      async ({ element }) => {
        const carNum = this.config.carNum;
        try {
          console.log(`      [secure_search] element=${element}, carNumLen=${carNum.length}`);
          const mcpResult = await this.mcpClient!.callTool({
            name: 'browser_type',
            arguments: { ref: element, text: carNum, submit: false },
          });
          const content = mcpResult.content as any[];
          const resultText = content?.map(c => c.text || '').join('\n') || '';
          console.log(`      [secure_search result] ${resultText.slice(0, 200)}`);
          if (resultText.toLowerCase().includes('error')) {
            return `Error filling search field: ${resultText}`;
          }
          return `Filled vehicle number successfully`;
        } catch (e) {
          console.log(`      [secure_search error] ${(e as Error).message}`);
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'secure_search_vehicle',
        description: 'Fill vehicle number search field securely. Actual carNum is injected internally.',
        schema: z.object({
          element: z.string().describe('Element reference from snapshot for search input'),
        }),
      }
    );
  }

  private createInjectSessionTool() {
    return tool(
      async () => {
        const session = this.config.session;
        try {
          // Inject cookies if available
          if (session.cookies && session.cookies.length > 0) {
            for (const cookie of session.cookies) {
              await this.mcpClient!.callTool({
                name: 'browser_evaluate',
                arguments: { expression: `document.cookie = "${cookie}"` },
              });
            }
            console.log(`      [inject_session] Injected ${session.cookies.length} cookies`);
          }

          // Inject localStorage if available
          if (session.localStorage) {
            for (const [key, value] of Object.entries(session.localStorage)) {
              await this.mcpClient!.callTool({
                name: 'browser_evaluate',
                arguments: { expression: `localStorage.setItem("${key}", "${value}")` },
              });
            }
            console.log(`      [inject_session] Injected localStorage keys`);
          }

          // Inject sessionStorage if available
          if (session.sessionStorage) {
            for (const [key, value] of Object.entries(session.sessionStorage)) {
              await this.mcpClient!.callTool({
                name: 'browser_evaluate',
                arguments: { expression: `sessionStorage.setItem("${key}", "${value}")` },
              });
            }
            console.log(`      [inject_session] Injected sessionStorage keys`);
          }

          return 'Session injected successfully. You can now navigate to pages that require authentication.';
        } catch (e) {
          console.log(`      [inject_session error] ${(e as Error).message}`);
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'inject_session',
        description: 'Inject stored session (cookies, localStorage, sessionStorage) into the browser. Call this FIRST after navigating to the site.',
        schema: z.object({}),
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
          const toolResult = await this.mcpClient!.callTool({ name: mcpTool.name, arguments: params });
          const contents = toolResult.content as any[];

          if (mcpTool.name === 'browser_take_screenshot') {
            for (const c of contents) {
              if (c.type === 'image' && c.data) {
                const filename = `debug-screenshot-${Date.now()}.png`;
                writeFileSync(filename, Buffer.from(c.data, 'base64'));
                console.log(`      [screenshot saved] ${filename}`);
                return `Screenshot saved to ${filename}`;
              }
            }
          }

          const text = contents?.map(c => c.text || '').join('\n') || 'Done';
          return text.slice(0, 5000);
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
      { name: mcpTool.name, description: mcpTool.description || mcpTool.name, schema: zodSchema }
    );
  }

  private buildSystemPrompt(): string {
    const sessionDesc = this.config.session.type
      ? `Session type: ${this.config.session.type}`
      : 'Session: provided';

    return `You are a vehicle search analyzer for: ${this.config.url}
SystemCode: ${this.config.systemCode}
${sessionDesc}

**TASK:**
1. Navigate to URL
2. Call inject_session to restore authentication state
3. Take snapshot to find search form or navigate to search page
4. Find vehicle search input field
5. Use secure_search_vehicle to fill the vehicle number
6. Click search button or submit
7. Wait for results, take screenshot
8. Use browser_network_requests to capture API calls
9. Analyze search results (found/not found/error)
10. Take final snapshot

**TOOLS:**
- browser_navigate, browser_snapshot, browser_click, browser_wait_for
- browser_take_screenshot (capture search results)
- browser_network_requests (capture search API calls)
- browser_evaluate (check page state)
- inject_session (CALL FIRST after navigate - restores auth state)
- secure_search_vehicle(element: "ref from snapshot") - fills vehicle number securely

**IMPORTANT:**
- Call inject_session IMMEDIATELY after first navigation
- Use secure_search_vehicle for vehicle number input - NEVER type it directly
- Capture network requests to identify search API endpoints
- Determine if search is DOM-based or API-based

**FINAL RESPONSE (JSON):**
{
  "status": "SUCCESS|NOT_FOUND|FORM_CHANGED|API_CHANGED|SESSION_EXPIRED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "searchType": "dom|api|hybrid",
  "form": {
    "searchInputSelector": "selector for vehicle number input",
    "searchButtonSelector": "selector for search button",
    "resultTableSelector": "selector for results table",
    "resultRowSelector": "selector for result rows"
  },
  "api": {
    "endpoint": "captured search API endpoint",
    "method": "GET|POST",
    "params": ["param names"],
    "responseFields": ["response field names"]
  },
  "resultIndicators": {
    "successField": "field indicating success",
    "noResultText": "text shown when no results"
  },
  "vehicle": {
    "id": "vehicle entry id",
    "plateNumber": "plate number",
    "inTime": "entry time",
    "outTime": "exit time if any",
    "lastOrderId": "order id if any"
  },
  "resultCount": 0,
  "errorMessage": "if any error"
}`;
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
