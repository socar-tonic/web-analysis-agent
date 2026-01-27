import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent, modelCallLimitMiddleware } from 'langchain';
import { SpecStore, SpecChanges } from '../specs/index.js';
import { SearchSpec, SearchResult, VendorHints } from '../schemas/index.js';

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
  mcpClient?: Client;  // 외부 주입 시 브라우저 세션 공유
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
  private config: SearchAgentConfig & { maxIterations: number };
  private mcpClient: Client | null = null;
  private externalMcp: boolean = false;  // 외부 주입 여부

  constructor(config: SearchAgentConfig) {
    this.config = { maxIterations: 15, ...config };
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
      this.externalMcp = true;
    }
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
      // Start MCP server (skip if external MCP provided)
      if (!this.externalMcp) {
        const transport = new StdioClientTransport({
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless', '--isolated'],
        });

        this.mcpClient = new Client({ name: 'search-agent', version: '1.0.0' });
        await this.mcpClient.connect(transport);
        console.log('  [SearchAgent] MCP connected');
      } else {
        console.log('  [SearchAgent] Using shared MCP client (browser already logged in)');
      }

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

      // 공유 MCP인 경우 다른 초기 메시지 사용
      const initialMessage = this.externalMcp
        ? 'Browser is already logged in. Start by taking a snapshot to see the current page, then use keypad_input_vehicle to enter the vehicle number, click the search button, and report results.'
        : 'Start: Navigate to the URL and search for the vehicle.';

      // Run agent
      const agentResult = await agent.invoke(
        { messages: [new HumanMessage(initialMessage)] },
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
      // Only close MCP if we created it (not external)
      if (this.mcpClient && !this.externalMcp) {
        await this.mcpClient.close().catch(() => {});
        console.log('  [SearchAgent] MCP closed');
      } else if (this.externalMcp) {
        console.log('  [SearchAgent] Keeping shared MCP open');
      }
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
    langchainTools.push(this.createKeypadInputTool());
    langchainTools.push(this.createInjectSessionTool());

    return langchainTools;
  }

  private createSecureSearchTool() {
    return tool(
      async ({ element, useLastDigits }) => {
        let carNum = this.config.carNum;
        // 힌트에서 뒤 4자리만 사용하도록 지정된 경우
        if (useLastDigits) {
          carNum = carNum.replace(/[^0-9]/g, '').slice(-4);
        }
        try {
          console.log(`      [secure_search] element=${element}, carNum=${carNum}, useLastDigits=${useLastDigits}`);
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
          return `Filled vehicle number (${carNum}) successfully`;
        } catch (e) {
          console.log(`      [secure_search error] ${(e as Error).message}`);
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'secure_search_vehicle',
        description: 'Fill vehicle number search field securely. Set useLastDigits=true for keypad systems that only accept last 4 digits.',
        schema: z.object({
          element: z.string().describe('Element reference from snapshot for search input'),
          useLastDigits: z.boolean().optional().describe('If true, only use last 4 digits of vehicle number'),
        }),
      }
    );
  }

  // 키패드 입력용 도구 - 버튼을 하나씩 클릭 후 검색 버튼도 자동 클릭
  private createKeypadInputTool() {
    // 힌트에서 검색 버튼 텍스트 가져오기
    const spec = this.config.specStore.load(this.config.systemCode);
    const searchButtonText = spec?.hints?.search?.searchButtonText || '조회';

    return tool(
      async ({}) => {
        // 차량번호 뒤 4자리 숫자만 추출
        const digits = this.config.carNum.replace(/[^0-9]/g, '').slice(-4);
        console.log(`      [keypad_input] Entering digits: ${digits}`);

        const results: string[] = [];

        try {
          // 각 숫자에 대해 버튼 클릭 (browser_evaluate로 직접 클릭)
          for (const digit of digits) {
            console.log(`      [keypad_input] Clicking digit: ${digit}`);

            // JavaScript로 버튼 찾아서 클릭
            const clickResult = await this.mcpClient!.callTool({
              name: 'browser_evaluate',
              arguments: {
                function: `
                  (function() {
                    const digit = '${digit}';
                    // 모든 클릭 가능 요소에서 숫자만 있는 것 찾기
                    const clickables = document.querySelectorAll('button, input[type="button"], a, td, span, div');
                    for (const el of clickables) {
                      const text = (el.textContent || el.value || '').trim();
                      // 정확히 숫자 하나만 있는 요소
                      if (text === digit) {
                        el.click();
                        return 'clicked: ' + digit;
                      }
                    }
                    // onclick 속성이 있는 모든 요소
                    const onclickElements = document.querySelectorAll('[onclick]');
                    for (const el of onclickElements) {
                      const text = (el.textContent || '').trim();
                      if (text === digit) {
                        el.click();
                        return 'clicked onclick: ' + digit;
                      }
                    }
                    // img alt나 title로 찾기
                    const images = document.querySelectorAll('img, input[type="image"]');
                    for (const img of images) {
                      const alt = img.alt || img.title || '';
                      if (alt.includes(digit)) {
                        img.click();
                        return 'clicked img: ' + digit;
                      }
                    }
                    // href에 숫자가 포함된 링크 (예: javascript:fn('8'))
                    const links = document.querySelectorAll('a[href*="' + digit + '"]');
                    for (const link of links) {
                      const text = (link.textContent || '').trim();
                      if (text === digit || text === '') {
                        link.click();
                        return 'clicked link: ' + digit;
                      }
                    }
                    return 'not found: ' + digit + ' (searched ' + clickables.length + ' elements)';
                  })()
                `,
              },
            });

            const clickContent = (clickResult.content as any[])?.map(c => c.text || '').join('\n') || '';
            console.log(`      [keypad_input] Result: ${clickContent.slice(0, 100)}`);
            results.push(clickContent);

            // 각 클릭 사이에 짧은 대기
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          const allClicked = results.every(r => r.includes('clicked'));

          // 숫자 입력 후 검색 버튼 자동 클릭
          console.log(`      [keypad_input] Clicking search button: ${searchButtonText}`);
          await new Promise(resolve => setTimeout(resolve, 300));

          const searchClickResult = await this.mcpClient!.callTool({
            name: 'browser_evaluate',
            arguments: {
              function: `
                (function() {
                  const searchText = '${searchButtonText}';
                  // 버튼이나 링크에서 검색 텍스트 찾기
                  const clickables = document.querySelectorAll('button, input[type="button"], input[type="submit"], a, div, span');
                  for (const el of clickables) {
                    const text = (el.textContent || el.value || '').trim();
                    if (text === searchText || text.includes(searchText)) {
                      el.click();
                      return 'clicked search: ' + text;
                    }
                  }
                  // onclick이 있는 요소에서 찾기
                  const onclickElements = document.querySelectorAll('[onclick]');
                  for (const el of onclickElements) {
                    const text = (el.textContent || '').trim();
                    if (text === searchText || text.includes(searchText)) {
                      el.click();
                      return 'clicked onclick search: ' + text;
                    }
                  }
                  // img에서 검색 버튼 찾기 (alt나 src에 search, 조회 등 포함)
                  const images = document.querySelectorAll('img, input[type="image"]');
                  for (const img of images) {
                    const alt = (img.alt || img.title || img.src || '').toLowerCase();
                    if (alt.includes('search') || alt.includes('조회') || alt.includes('find')) {
                      img.click();
                      return 'clicked search img: ' + alt;
                    }
                  }
                  // form submit 시도
                  const forms = document.querySelectorAll('form');
                  if (forms.length === 1) {
                    forms[0].submit();
                    return 'submitted form';
                  }
                  return 'search button not found: ' + searchText;
                })()
              `,
            },
          });

          const searchContent = (searchClickResult.content as any[])?.map(c => c.text || '').join('\n') || '';
          console.log(`      [keypad_input] Search button result: ${searchContent}`);

          if (allClicked && searchContent.includes('clicked')) {
            return `Successfully entered ${digits.length} digits via keypad (${digits}) and clicked search button. Wait for results.`;
          } else if (allClicked) {
            return `Entered digits (${digits}) but search button not found: ${searchContent}. Results: ${results.join(', ')}`;
          } else {
            return `Partial success - entered digits: ${digits}. Results: ${results.join(', ')}. Search: ${searchContent}`;
          }
        } catch (e) {
          console.log(`      [keypad_input error] ${(e as Error).message}`);
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'keypad_input_vehicle',
        description: 'Enter vehicle number via numeric keypad by clicking digit buttons, then automatically click search button. Uses last 4 digits. Use this for sites with keypad input instead of text fields.',
        schema: z.object({}),
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
                arguments: { expression: `document.cookie = ${JSON.stringify(cookie)}` },
              });
            }
            console.log(`      [inject_session] Injected ${session.cookies.length} cookies`);
          }

          // Inject localStorage if available
          if (session.localStorage) {
            for (const [key, value] of Object.entries(session.localStorage)) {
              await this.mcpClient!.callTool({
                name: 'browser_evaluate',
                arguments: { expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})` },
              });
            }
            console.log(`      [inject_session] Injected localStorage keys`);
          }

          // Inject sessionStorage if available
          if (session.sessionStorage) {
            for (const [key, value] of Object.entries(session.sessionStorage)) {
              await this.mcpClient!.callTool({
                name: 'browser_evaluate',
                arguments: { expression: `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})` },
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

    // Load hints from spec if available
    const spec = this.config.specStore.load(this.config.systemCode);
    const hints: VendorHints | undefined = spec?.hints;

    // 힌트는 간단한 참고사항으로만 전달
    let hintSection = '';
    if (hints?.search) {
      const parts: string[] = [];
      if (hints.search.description) parts.push(hints.search.description);
      if (hints.search.inputMethod) parts.push(`입력방식: ${hints.search.inputMethod}`);
      if (hints.search.searchButtonText) parts.push(`검색버튼: ${hints.search.searchButtonText}`);

      if (parts.length > 0) {
        hintSection = `\n**참고:** ${parts.join(' | ')}`;
      }
    }

    // 공유 MCP (이미 로그인된 상태)인지 여부
    const isSharedSession = this.externalMcp;

    // 키패드 입력 방식 여부
    const isKeypadInput = hints?.search?.inputMethod === 'keypad';

    const taskSection = isSharedSession
      ? `**TASK (Browser already logged in):**
1. Take snapshot to see current page
2. ${isKeypadInput
  ? `Use keypad_input_vehicle (enters last 4 digits via keypad + clicks search)`
  : `Use secure_search_vehicle to fill vehicle number, then click search button`}
3. Wait for results
4. Take screenshot
5. Report: current URL, page content summary, any vehicle info found

**NOTE:** Do NOT navigate away - browser is already logged in.`
      : `**TASK:**
1. Navigate to URL
2. Call inject_session to restore auth
3. Find and fill search form using secure_search_vehicle
4. Submit search
5. Capture results (screenshot + network)
6. Report findings`;

    const toolsSection = isSharedSession
      ? `**TOOLS:**
- browser_snapshot, browser_click, browser_wait_for, browser_take_screenshot
- browser_network_requests, browser_evaluate
- keypad_input_vehicle - for keypad input (clicks digit buttons + search)
- secure_search_vehicle - for text input fields`
      : `**TOOLS:**
- browser_navigate, browser_snapshot, browser_click, browser_wait_for
- browser_take_screenshot, browser_network_requests, browser_evaluate
- inject_session - restore auth state after navigate
- secure_search_vehicle - fill vehicle number securely`;

    return `You are a vehicle search analyzer for: ${this.config.url}
SystemCode: ${this.config.systemCode}
${sessionDesc}
${hintSection}

${taskSection}

${toolsSection}

**FINAL RESPONSE (JSON):**
{
  "status": "SUCCESS|NOT_FOUND|FORM_CHANGED|API_CHANGED|SESSION_EXPIRED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "searchType": "dom|api|hybrid",
  "vehicle": {
    "id": "vehicle entry id if found",
    "plateNumber": "plate number",
    "inTime": "entry time"
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
