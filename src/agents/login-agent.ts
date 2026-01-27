// src/agents/login-agent.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent, modelCallLimitMiddleware } from 'langchain';
import { CredentialManager } from '../security/index.js';
import { SpecStore, SpecChanges } from '../specs/index.js';
import { LoginSpec, LoginResult, VendorHints } from '../schemas/index.js';

// Connection error classification
export interface ConnectionErrorInfo {
  isConnectionError: boolean;
  errorType: 'timeout' | 'connection_refused' | 'dns_failed' | 'ssl_error' | 'network_error' | 'server_error' | 'unknown';
  confidence: number;
  summary: string;
}

export function classifyConnectionError(error: Error): ConnectionErrorInfo {
  const message = error.message.toLowerCase();

  // Timeout (Analyzer pattern)
  if (message.includes('timeout') || error.message.includes('Timeout')) {
    return {
      isConnectionError: true,
      errorType: 'timeout',
      confidence: 1.0,
      summary: '접속 타임아웃 - 서버 다운 또는 방화벽 차단 추정',
    };
  }

  // Connection refused
  if (message.includes('econnrefused') || message.includes('err_connection_refused')) {
    return {
      isConnectionError: true,
      errorType: 'connection_refused',
      confidence: 1.0,
      summary: '연결 거부됨 - 서버가 연결을 받지 않음',
    };
  }

  // DNS resolution failed
  if (message.includes('enotfound') || message.includes('err_name_not_resolved') || message.includes('getaddrinfo')) {
    return {
      isConnectionError: true,
      errorType: 'dns_failed',
      confidence: 1.0,
      summary: 'DNS 해석 실패 - 도메인이 존재하지 않거나 DNS 서버 접근 불가',
    };
  }

  // SSL/TLS errors
  if (message.includes('ssl') || message.includes('err_cert') || message.includes('certificate')) {
    return {
      isConnectionError: true,
      errorType: 'ssl_error',
      confidence: 0.95,
      summary: 'SSL/TLS 오류 - 인증서 문제 또는 HTTPS 설정 오류',
    };
  }

  // Generic network errors
  if (message.includes('net::err_') || message.includes('econnreset') || message.includes('network')) {
    return {
      isConnectionError: true,
      errorType: 'network_error',
      confidence: 0.9,
      summary: '네트워크 오류 - 연결 중단 또는 접근 불가',
    };
  }

  // Server errors (5xx)
  if (/\b5\d{2}\b/.test(error.message)) {
    return {
      isConnectionError: true,
      errorType: 'server_error',
      confidence: 0.9,
      summary: '서버 오류 - 서비스 일시 중단',
    };
  }

  return {
    isConnectionError: false,
    errorType: 'unknown',
    confidence: 0,
    summary: error.message,
  };
}

interface LoginAgentConfig {
  systemCode: string;
  url: string;
  credentialManager: CredentialManager;
  specStore: SpecStore;
  llm: BaseChatModel;
  maxIterations?: number;
  mcpClient?: Client;  // 외부 주입 시 브라우저 세션 공유
}

interface SessionInfo {
  type?: 'jwt' | 'cookie' | 'session' | 'mixed';
  accessToken?: string;
  cookies?: string[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

interface ParsedAnalysis {
  status?: LoginResult['status'];
  confidence?: number;
  loginType?: LoginSpec['loginType'];
  form?: LoginSpec['form'];
  api?: LoginSpec['api'];
  successIndicators?: LoginSpec['successIndicators'];
  session?: SessionInfo;
  errorMessage?: string;
}

export class LoginAgent {
  private config: LoginAgentConfig & { maxIterations: number };
  private mcpClient: Client | null = null;
  private externalMcp: boolean = false;  // 외부 주입 여부
  private networkLogs: { url: string; method: string; status?: number; body?: string }[] = [];

  constructor(config: LoginAgentConfig) {
    this.config = { maxIterations: 15, ...config };
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
      this.externalMcp = true;
    }
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
      // Start MCP server (skip if external MCP provided)
      if (!this.externalMcp) {
        const transport = new StdioClientTransport({
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless', '--isolated'],
        });

        this.mcpClient = new Client({ name: 'login-agent', version: '1.0.0' });
        await this.mcpClient.connect(transport);
        console.log('  [LoginAgent] MCP connected');
      } else {
        console.log('  [LoginAgent] Using shared MCP client');
      }

      // Build tools
      const tools = await this.buildTools();
      console.log(`  [LoginAgent] ${tools.length} tools ready`);

      // Create LangChain agent with model call limit
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

      console.log('\n  [LangChain Agent] Starting...');

      // Run agent with recursion limit
      const agentResult = await agent.invoke(
        { messages: [new HumanMessage('Execute the complete login flow: navigate to the URL, fill username and password using secure_fill_credential, click submit, and report the result. Do NOT stop until login is attempted.')] },
        { recursionLimit: this.config.maxIterations * 3 }
      );

      // Extract final response from last AI message
      const messages = agentResult.messages as BaseMessage[];

      // Debug: print all messages to understand agent behavior
      console.log('\n  [Agent Messages Debug]');
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const type = msg.constructor.name;
        const content = typeof msg.content === 'string' ? msg.content.slice(0, 300) : JSON.stringify(msg.content).slice(0, 300);
        console.log(`    [${i}] ${type}: ${content}...`);
      }
      console.log('  [End Debug]\n');

      let finalResponse = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg instanceof AIMessage && typeof msg.content === 'string' && msg.content.trim()) {
          finalResponse = msg.content;
          break;
        }
      }

      // Extract URL tracking from messages
      for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.includes('Page URL:')) {
          const match = content.match(/Page URL: ([^\n]+)/);
          if (match) urlAfter = match[1];
        }
      }

      console.log(`  [LangChain Agent] Completed with ${messages.length} messages`);

      // Parse LLM's final analysis
      const analysis = this.parseAnalysis(finalResponse);

      // Check if LLM reported a connection error in errorMessage
      // (Playwright MCP returns navigation errors as tool results, not exceptions)
      if (analysis.errorMessage) {
        const connectionInfo = classifyConnectionError(new Error(analysis.errorMessage));
        if (connectionInfo.isConnectionError) {
          console.log(`  [LoginAgent] Connection error detected in response: ${connectionInfo.errorType}`);
          return {
            result: {
              status: 'CONNECTION_ERROR',
              confidence: connectionInfo.confidence,
              details: {
                urlBefore,
                urlAfter: urlBefore,
                urlChanged: false,
                errorMessage: connectionInfo.summary,
              },
              timestamp,
            },
            spec: capturedSpec as LoginSpec,
          };
        }
      }

      // Human-in-the-loop fallback: Low confidence + unknown error
      if ((analysis.confidence || 0) < 0.5 && analysis.status === 'UNKNOWN_ERROR') {
        console.log('  [LoginAgent] Low confidence - requesting human help');

        // Take screenshot for human review
        let screenshotPath: string | undefined;
        try {
          const screenshotResult = await this.mcpClient!.callTool({
            name: 'browser_take_screenshot',
            arguments: {},
          });
          const contents = screenshotResult.content as any[];
          for (const c of contents) {
            if (c.type === 'image' && c.data) {
              screenshotPath = `human-help-${Date.now()}.png`;
              writeFileSync(screenshotPath, Buffer.from(c.data, 'base64'));
              console.log(`      [screenshot saved] ${screenshotPath}`);
            }
          }
        } catch {
          // Screenshot failed, continue without it
        }

        return {
          result: {
            status: 'NEEDS_HUMAN_HELP',
            confidence: analysis.confidence || 0,
            details: {
              urlBefore,
              urlAfter,
              urlChanged: urlBefore !== urlAfter,
              errorMessage: `자동 분석 실패 - 수동 검토 필요${screenshotPath ? ` (스크린샷: ${screenshotPath})` : ''}`,
            },
            timestamp,
          },
          spec: capturedSpec as LoginSpec,
        };
      }

      // Build final spec
      const spec: LoginSpec = {
        ...capturedSpec,
        loginType: analysis.loginType || 'dom',
        form: analysis.form,
        api: analysis.api,
        successIndicators: analysis.successIndicators || { urlPattern: urlAfter },
      } as LoginSpec;

      // Compare with existing spec using LLM (read-only, never overwrite)
      const changes: SpecChanges = await this.config.specStore.compare(this.config.systemCode, spec, this.config.llm);

      const loginResult: LoginResult = {
        status: analysis.status || 'UNKNOWN_ERROR',
        confidence: analysis.confidence || 0.5,
        details: {
          urlBefore,
          urlAfter,
          urlChanged: urlBefore !== urlAfter,
          errorMessage: analysis.errorMessage,
        },
        changes,
        session: analysis.session,
        timestamp,
      };

      return { result: loginResult, spec };

    } catch (error) {
      const connectionInfo = classifyConnectionError(error as Error);

      if (connectionInfo.isConnectionError) {
        console.log(`  [LoginAgent] Connection error: ${connectionInfo.errorType}`);
        return {
          result: {
            status: 'CONNECTION_ERROR',
            confidence: connectionInfo.confidence,
            details: {
              urlBefore,
              urlAfter: urlBefore,
              urlChanged: false,
              errorMessage: connectionInfo.summary,
            },
            timestamp,
          },
          spec: capturedSpec as LoginSpec,
        };
      }

      // Non-connection errors fall through to UNKNOWN_ERROR
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
      // Only close MCP if we created it (not external)
      if (this.mcpClient && !this.externalMcp) {
        await this.mcpClient.close().catch(() => {});
        console.log('  [LoginAgent] MCP closed');
      } else if (this.externalMcp) {
        console.log('  [LoginAgent] Keeping shared MCP open');
      }
    }
  }

  private async buildTools(): Promise<any[]> {
    const { tools: mcpTools } = await this.mcpClient!.listTools();

    // Log all available MCP tools
    console.log('  [MCP Tools Available]');
    mcpTools.forEach(t => console.log(`    - ${t.name}`));

    // Filter MCP tools - exclude browser_type (we use secure_fill instead)
    const allowedTools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_wait_for', 'browser_press_key', 'browser_take_screenshot', 'browser_network_requests', 'browser_evaluate', 'browser_handle_dialog'];
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
          console.log(`      [secure_fill] field=${field}, element=${element}, valueLen=${value.length}`);

          // Step 0: Dismiss any existing alert dialog first
          try {
            await this.mcpClient!.callTool({
              name: 'browser_handle_dialog',
              arguments: { accept: true },
            });
            console.log(`      [secure_fill] dismissed existing dialog`);
          } catch {
            // No dialog to dismiss, continue
          }

          // Step 1: Click to focus the element first
          await this.mcpClient!.callTool({
            name: 'browser_click',
            arguments: { ref: element },
          });

          // Step 2: Small delay for focus
          await new Promise(resolve => setTimeout(resolve, 100));

          // Step 3: Type the value
          const mcpResult = await this.mcpClient!.callTool({
            name: 'browser_type',
            arguments: { ref: element, text: value, submit: false },
          });
          const content = mcpResult.content as any[];
          const resultText = content?.map(c => c.text || '').join('\n') || '';
          console.log(`      [secure_fill result] ${resultText.slice(0, 200)}`);

          // Check for alert dialogs and dismiss them
          if (resultText.includes('alert') || resultText.includes('dialog')) {
            console.log(`      [secure_fill] alert detected, attempting to handle...`);
            try {
              await this.mcpClient!.callTool({
                name: 'browser_handle_dialog',
                arguments: { accept: true },
              });
            } catch {
              // Dialog handling tool might not exist, ignore
            }
          }

          if (resultText.toLowerCase().includes('error')) {
            return `Error filling ${field}: ${resultText}`;
          }
          return `Filled ${field} field successfully`;
        } catch (e) {
          console.log(`      [secure_fill error] ${(e as Error).message}`);
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: 'secure_fill_credential',
        description: 'Fill username or password field securely. Actual value is injected internally. IMPORTANT: Always fill username FIRST, then password.',
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
          console.log(`      [MCP] ${mcpTool.name}(${JSON.stringify(params)})`);
          const toolResult = await this.mcpClient!.callTool({ name: mcpTool.name, arguments: params });
          const contents = toolResult.content as any[];

          // Handle screenshot - save image to file
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
    // Load hints from spec if available
    const spec = this.config.specStore.load(this.config.systemCode);
    const hints: VendorHints | undefined = spec?.hints;

    let hintSection = '';
    if (hints?.login) {
      hintSection = `
**VENDOR HINTS (사용 우선):**
${hints.login.usernameSelector ? `- 아이디 필드: ${hints.login.usernameSelector}` : ''}
${hints.login.passwordSelector ? `- 비밀번호 필드: ${hints.login.passwordSelector}` : ''}
${hints.login.submitSelector ? `- 로그인 버튼: ${hints.login.submitSelector}` : ''}
${hints.login.failureTexts?.length ? `- 실패 텍스트: ${hints.login.failureTexts.join(', ')}` : ''}
${hints.quirks?.dismissAlerts ? '- Alert 자동 dismiss 필요' : ''}

힌트 셀렉터를 먼저 시도하고, 실패 시 일반적인 방법으로 폴백하세요.
`;
    }

    return `You are a login flow analyzer for: ${this.config.url}
SystemCode: ${this.config.systemCode}
${hintSection}
**TASK:**
1. Navigate to URL
2. If you see "alert dialog" in response, dismiss it with browser_handle_dialog(accept: true)
3. Take snapshot, find login form fields (see FINDING LOGIN FIELDS below)
4. Fill credentials in STRICT ORDER:
   a. FIRST: secure_fill_credential(field: "username", element: "ref")
   b. SECOND: secure_fill_credential(field: "password", element: "ref")
   c. NEVER fill password before username - this causes validation errors!
5. Click submit button
6. Wait 3 seconds, then take screenshot
7. Use browser_network_requests to capture API calls made during login
8. If login SUCCESS, extract session info:
   - browser_evaluate: document.cookie
   - browser_evaluate: JSON.stringify(localStorage)
   - browser_evaluate: JSON.stringify(sessionStorage)
9. Take snapshot and analyze result

**FINDING LOGIN FIELDS:**
Login forms use various field names. Look for:
- Username field: input with name/id containing "user", "id", "login", "email", "account", "j_username", or type="text" near password field
- Password field: input with type="password" OR name/id containing "pass", "pw", "pwd", "j_password"
- Submit button: button or input with type="submit", or text like "로그인", "Login", "Sign in"

**TOOLS:**
- browser_navigate, browser_snapshot, browser_click, browser_wait_for
- browser_take_screenshot (use after login to capture result)
- browser_network_requests (use after login to capture API calls)
- browser_evaluate (use to extract cookies, localStorage, sessionStorage)
- browser_handle_dialog (use to dismiss alert/confirm dialogs)
- secure_fill_credential(field: "username"|"password", element: "ref from snapshot")

**IMPORTANT:**
- Fill username FIRST, then password - NEVER reverse this order!
- If you see "alert dialog" in response, use browser_handle_dialog(accept: true) to dismiss it
- Use secure_fill_credential for ALL credential inputs
- NEVER type passwords directly
- After login, ALWAYS call browser_network_requests to capture API endpoints
- After login SUCCESS, ALWAYS extract session info using browser_evaluate
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
  "api": {
    "loginEndpoint": "captured login API endpoint if any",
    "method": "POST|GET",
    "otherEndpoints": ["other API calls captured"]
  },
  "session": {
    "type": "jwt|cookie|session|mixed",
    "accessToken": "token if found in API response",
    "cookies": ["relevant auth cookies"],
    "localStorage": {"key": "value if auth related"},
    "sessionStorage": {"key": "value if auth related"}
  },
  "successIndicators": { "urlPattern": "..." },
  "errorMessage": "if any"
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
