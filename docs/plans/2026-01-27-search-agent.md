# SearchAgent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** LoginAgent 로그인 성공 후 세션 정보를 사용하여 차량 검색을 수행하고, 검색 플로우의 Spec을 캡처/비교하는 SearchAgent 구현

**Architecture:** LoginAgent 패턴 그대로 활용 (MCP + LangChain createAgent). 세션 정보(accessToken, cookies)를 config로 주입받아 인증 상태 유지. `secure_search_vehicle` 도구로 차량번호 보안 주입. SearchSpec으로 검색 플로우 캡처 및 변경 감지.

**Tech Stack:** TypeScript, LangChain (createAgent), MCP (Playwright), Zod

---

## Task 1: SearchResult Schema 생성

**Files:**
- Create: `src/schemas/search-result.schema.ts`
- Modify: `src/schemas/index.ts`
- Test: `src/schemas/__tests__/schemas.test.ts`

**Step 1: Write the failing test**

`src/schemas/__tests__/schemas.test.ts`에 추가:

```typescript
import { SearchResultSchema } from '../search-result.schema.js';

describe('SearchResultSchema', () => {
  it('should validate successful search result', () => {
    const result = {
      status: 'SUCCESS',
      confidence: 0.95,
      details: {
        vehicleFound: true,
        searchMethod: 'api',
        resultCount: 1,
      },
      vehicle: {
        id: '12345',
        plateNumber: '12가3456',
        inTime: '2026-01-27T10:00:00Z',
      },
      timestamp: new Date().toISOString(),
    };
    expect(() => SearchResultSchema.parse(result)).not.toThrow();
  });

  it('should validate not found result', () => {
    const result = {
      status: 'NOT_FOUND',
      confidence: 0.9,
      details: {
        vehicleFound: false,
        searchMethod: 'dom',
        resultCount: 0,
      },
      timestamp: new Date().toISOString(),
    };
    expect(() => SearchResultSchema.parse(result)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- --testPathPattern=schemas.test.ts`
Expected: FAIL - Cannot find module '../search-result.schema.js'

**Step 3: Write SearchResult schema**

`src/schemas/search-result.schema.ts`:

```typescript
import { z } from 'zod';

export const SearchResultSchema = z.object({
  status: z.enum([
    'SUCCESS',           // 차량 검색 성공
    'NOT_FOUND',         // 차량 없음 (정상 케이스)
    'FORM_CHANGED',      // 검색 폼 구조 변경 감지
    'API_CHANGED',       // 검색 API 변경 감지
    'SESSION_EXPIRED',   // 세션 만료
    'UNKNOWN_ERROR',     // 알 수 없는 에러
  ]),
  confidence: z.number().min(0).max(1),
  details: z.object({
    vehicleFound: z.boolean(),
    searchMethod: z.enum(['dom', 'api', 'hybrid']),
    resultCount: z.number().int().min(0),
    errorMessage: z.string().optional(),
  }),
  vehicle: z.object({
    id: z.string(),
    plateNumber: z.string(),
    inTime: z.string(),
    outTime: z.string().optional(),
    lastOrderId: z.string().optional(),
  }).optional(),
  changes: z.object({
    hasChanges: z.boolean(),
    codeWillBreak: z.boolean().optional(),
    breakingChanges: z.array(z.string()).optional(),
    summary: z.string().optional(),
  }).optional(),
  timestamp: z.string().datetime(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;
```

**Step 4: Update index.ts**

`src/schemas/index.ts`에 export 추가:

```typescript
export * from './search-result.schema.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test -- --testPathPattern=schemas.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/schemas/search-result.schema.ts src/schemas/index.ts src/schemas/__tests__/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat: add SearchResult schema for vehicle search results

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SearchSpec Schema 생성

**Files:**
- Create: `src/schemas/search-spec.schema.ts`
- Modify: `src/schemas/index.ts`
- Test: `src/schemas/__tests__/schemas.test.ts`

**Step 1: Write the failing test**

```typescript
import { SearchSpecSchema } from '../search-spec.schema.js';

describe('SearchSpecSchema', () => {
  it('should validate API-based search spec', () => {
    const spec = {
      systemCode: 'humax-parcs-api',
      url: 'https://console.humax-parcs.com',
      capturedAt: new Date().toISOString(),
      searchType: 'api',
      api: {
        endpoint: '/in.store/{siteId}',
        method: 'GET',
        params: ['searchType', 'plateNumber', 'fromAt', 'toAt'],
        responseFields: ['id', 'plateNumber', 'inTime'],
      },
      resultIndicators: {
        successField: 'resultCode',
        successValue: 'SUCCESS',
      },
      version: 1,
    };
    expect(() => SearchSpecSchema.parse(spec)).not.toThrow();
  });

  it('should validate DOM-based search spec', () => {
    const spec = {
      systemCode: 'vendor-dom',
      url: 'https://vendor.com',
      capturedAt: new Date().toISOString(),
      searchType: 'dom',
      form: {
        searchInputSelector: 'input[name="carNum"]',
        searchButtonSelector: 'button.search-btn',
        resultTableSelector: 'table.result-list',
        resultRowSelector: 'tr.vehicle-row',
      },
      resultIndicators: {
        noResultText: '검색 결과가 없습니다',
      },
      version: 1,
    };
    expect(() => SearchSpecSchema.parse(spec)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- --testPathPattern=schemas.test.ts`
Expected: FAIL - Cannot find module '../search-spec.schema.js'

**Step 3: Write SearchSpec schema**

`src/schemas/search-spec.schema.ts`:

```typescript
import { z } from 'zod';

export const SearchFormSpecSchema = z.object({
  searchInputSelector: z.string(),
  searchButtonSelector: z.string(),
  resultTableSelector: z.string().optional(),
  resultRowSelector: z.string().optional(),
});

export const SearchApiSpecSchema = z.object({
  endpoint: z.string(),
  method: z.enum(['GET', 'POST']),
  params: z.array(z.string()).optional(),
  requestFields: z.record(z.string()).optional(),
  responseFields: z.array(z.string()),
});

export const SearchSpecSchema = z.object({
  systemCode: z.string(),
  url: z.string(),
  capturedAt: z.string().datetime(),
  searchType: z.enum(['dom', 'api', 'hybrid']),
  form: SearchFormSpecSchema.optional(),
  api: SearchApiSpecSchema.optional(),
  resultIndicators: z.object({
    successField: z.string().optional(),
    successValue: z.string().optional(),
    noResultText: z.string().optional(),
    rowSelector: z.string().optional(),
  }),
  version: z.number().default(1),
});

export type SearchSpec = z.infer<typeof SearchSpecSchema>;
export type SearchFormSpec = z.infer<typeof SearchFormSpecSchema>;
export type SearchApiSpec = z.infer<typeof SearchApiSpecSchema>;
```

**Step 4: Update index.ts**

```typescript
export * from './search-spec.schema.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test -- --testPathPattern=schemas.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/schemas/search-spec.schema.ts src/schemas/index.ts src/schemas/__tests__/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat: add SearchSpec schema for search flow capture

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SearchAgent 클래스 생성

**Files:**
- Create: `src/agents/search-agent.ts`
- Modify: `src/agents/index.ts` (export 추가)

**Step 1: Write the failing test**

`src/agents/__tests__/search-agent.test.ts`:

```typescript
import { SearchAgent, SearchAgentConfig } from '../search-agent.js';

describe('SearchAgent', () => {
  it('should be instantiable with config', () => {
    const config: SearchAgentConfig = {
      systemCode: 'test-vendor',
      url: 'https://test.com',
      carNum: '12가3456',
      session: {
        type: 'jwt',
        accessToken: 'test-token',
      },
      specStore: { load: () => null, save: () => {}, has: () => false, compare: async () => ({ hasChanges: false }) } as any,
      llm: {} as any,
    };
    const agent = new SearchAgent(config);
    expect(agent).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- --testPathPattern=search-agent.test.ts`
Expected: FAIL - Cannot find module '../search-agent.js'

**Step 3: Write SearchAgent class**

`src/agents/search-agent.ts`:

```typescript
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
```

**Step 4: Update agents/index.ts**

`src/agents/index.ts`에 추가:

```typescript
export * from './search-agent.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test -- --testPathPattern=search-agent.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/agents/search-agent.ts src/agents/index.ts src/agents/__tests__/search-agent.test.ts
git commit -m "$(cat <<'EOF'
feat: add SearchAgent for vehicle search with session injection

- Uses stored session (cookies/localStorage/sessionStorage) from LoginAgent
- secure_search_vehicle tool for secure carNum injection
- inject_session tool for auth state restoration
- Captures search spec (DOM selectors or API endpoints)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CLI Integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

**Step 1: Add SearchAgent CLI command**

`src/cli.ts`에 runLoginAgentCommand 다음에 추가:

```typescript
import { SearchAgent } from './agents/index.js';

// SearchAgent command - uses session from LoginAgent
async function runSearchAgentCommand(
  input: MockInput,
  session: SessionInfo,
  llm: BaseChatModel
): Promise<AgentResult> {
  console.log(`\n[Search Agent] Starting for: ${input.url}`);

  const specStore = new SpecStore();

  const agent = new SearchAgent({
    systemCode: input.systemCode,
    url: input.url,
    carNum: input.carNum,
    session,
    specStore,
    llm,
  });

  const { result, spec } = await agent.run();

  console.log('\n  [Result]');
  console.log(`    검색 결과: ${result.status} (confidence: ${result.confidence})`);

  if (result.details.vehicleFound && result.vehicle) {
    console.log(`    ✅ 차량 발견: ${result.vehicle.plateNumber}`);
    console.log(`      입차 시간: ${result.vehicle.inTime}`);
  } else if (result.status === 'NOT_FOUND') {
    console.log(`    ℹ️  차량 없음 (정상 응답)`);
  } else {
    console.log(`    ❌ 검색 실패: ${result.details.errorMessage || result.status}`);
  }

  const codeCompatible = !result.changes?.codeWillBreak;

  if (result.changes?.codeWillBreak) {
    console.log(`    🚨 코드 호환성: 실패 - 수정 필요`);
    result.changes.breakingChanges?.forEach(c => console.log(`      - ${c}`));
  } else {
    console.log(`    ✅ 코드 호환성: 성공`);
  }

  return {
    agent: 'search',
    success: codeCompatible,
    analysis: JSON.stringify({ result, spec }, null, 2),
    data: { result, spec },
  };
}
```

**Step 2: Add login-then-search combined command**

```typescript
// Combined Login → Search flow
async function runLoginAndSearchCommand(input: MockInput, llm: BaseChatModel): Promise<AgentResult[]> {
  console.log(`\n[Login → Search Flow] Starting...`);

  // Step 1: Login
  const loginResult = await runLoginAgentCommand(input, llm);

  if (!loginResult.success || loginResult.data?.result?.status !== 'SUCCESS') {
    console.log('\n  [Flow] Login failed, skipping search');
    return [loginResult];
  }

  const session = loginResult.data.result.session;
  if (!session) {
    console.log('\n  [Flow] No session captured, skipping search');
    return [loginResult];
  }

  console.log('\n  [Flow] Login successful, proceeding to search...');

  // Step 2: Search with captured session
  const searchResult = await runSearchAgentCommand(input, session, llm);

  return [loginResult, searchResult];
}
```

**Step 3: Add CLI argument handling**

`main()` 함수 내 command 처리 부분에 추가:

```typescript
case 'search':
  // Search requires prior login - run combined flow
  results = await runLoginAndSearchCommand(input, llm);
  break;

case 'login-search':
  results = await runLoginAndSearchCommand(input, llm);
  break;
```

**Step 4: Update package.json scripts**

`package.json`에 추가:

```json
{
  "scripts": {
    "agent:search": "tsx src/cli.ts search",
    "agent:login-search": "tsx src/cli.ts login-search"
  }
}
```

**Step 5: Test the CLI manually**

Run: `pnpm agent:login-search`
Expected: LoginAgent 실행 → 세션 캡처 → SearchAgent 실행 → 결과 출력

**Step 6: Commit**

```bash
git add src/cli.ts package.json
git commit -m "$(cat <<'EOF'
feat: add search agent CLI commands

- pnpm agent:search - combined login + search flow
- pnpm agent:login-search - explicit combined command
- Session handoff from LoginAgent to SearchAgent

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Integration Test

**Files:**
- Create: `src/agents/__tests__/search-agent.integration.test.ts`

**Step 1: Write integration test (skip in CI)**

```typescript
import { describe, it, expect } from 'vitest';
import { SearchAgent } from '../search-agent.js';
import { SpecStore } from '../../specs/index.js';

describe('SearchAgent Integration', () => {
  it.skip('should search with mock session', async () => {
    // This test requires actual browser - skip in CI
    // Run manually: pnpm test -- --testPathPattern=search-agent.integration
    const agent = new SearchAgent({
      systemCode: 'test-vendor',
      url: 'https://example.com',
      carNum: '12가3456',
      session: {
        type: 'cookie',
        cookies: ['session=test'],
      },
      specStore: new SpecStore(),
      llm: {} as any, // Mock LLM would be needed
    });

    // Just verify instantiation works
    expect(agent).toBeDefined();
  });
});
```

**Step 2: Run test**

Run: `pnpm test -- --testPathPattern=search-agent`
Expected: PASS (integration test skipped)

**Step 3: Commit**

```bash
git add src/agents/__tests__/search-agent.integration.test.ts
git commit -m "$(cat <<'EOF'
test: add SearchAgent integration test placeholder

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | SearchResult Schema | `search-result.schema.ts` |
| 2 | SearchSpec Schema | `search-spec.schema.ts` |
| 3 | SearchAgent Class | `search-agent.ts` |
| 4 | CLI Integration | `cli.ts`, `package.json` |
| 5 | Integration Test | `search-agent.integration.test.ts` |

**실행 방법:**
```bash
# 로그인 + 검색 연속 실행
pnpm agent:login-search

# mock-input.json에 carNum 필드 필요:
# { "systemCode": "...", "url": "...", "id": "...", "pwd": "...", "carNum": "12가3456" }
```

**세션 핸드오프 플로우:**
```
LoginAgent.run()
    ↓
{ result: { session: { type, accessToken, cookies, ... } }, spec }
    ↓
SearchAgent.run({ session })
    ↓
inject_session() → secure_search_vehicle() → 결과 분석
```
