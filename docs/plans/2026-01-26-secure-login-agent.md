# Secure Login Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MCP 기반 로그인 에이전트를 구현하되, LLM이 비밀번호를 절대 알지 못하게 보안 패턴 적용

**Architecture:** LLM이 MCP Playwright 도구를 사용하여 페이지 탐색/분석. 비밀번호 입력은 `secure_fill_credential` 커스텀 도구로 처리 (LLM은 "password 필드에 채워라"만 지시, 실제 pwd는 CredentialManager가 주입). 로그인 후 DOM/API 변경 감지.

**Tech Stack:** TypeScript, LangGraph.js, Playwright MCP, Zod, @langchain/core

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     LangGraph Workflow                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐               │
│  │  Start   │───▶│  Login   │───▶│ Analyze  │               │
│  │  Node    │    │  Node    │    │  Node    │               │
│  └──────────┘    └──────────┘    └──────────┘               │
│       │               │               │                      │
│       ▼               ▼               ▼                      │
│  ┌─────────────────────────────────────────┐                │
│  │           MCP Tool Node                  │                │
│  │  ┌─────────────────────────────────┐    │                │
│  │  │ Playwright MCP (browser_*)      │    │                │
│  │  │ + secure_fill_credential        │◀───┼─── Credential  │
│  │  └─────────────────────────────────┘    │    Manager     │
│  └─────────────────────────────────────────┘                │
│                                                              │
└─────────────────────────────────────────────────────────────┘

LLM이 아는 것: systemCode, url, carNum, "password 필드 존재"
LLM이 모르는 것: 실제 id 값, 실제 pwd 값, 토큰, 쿠키
```

## Security Design

**Credential Manager 패턴:**
- LLM은 `secure_fill_credential(field: "username" | "password")` 만 호출
- CredentialManager가 systemCode 기반으로 실제 값 주입
- LLM 프롬프트/응답에 pwd 절대 노출 안 됨

---

## Task 1: CredentialManager 클래스 생성

**Files:**
- Create: `src/security/credential-manager.ts`
- Create: `src/security/index.ts`
- Test: `src/security/__tests__/credential-manager.test.ts`

**Step 1: Write the failing test**

```typescript
// src/security/__tests__/credential-manager.test.ts
import { describe, it, expect } from 'vitest';
import { CredentialManager } from '../credential-manager';

describe('CredentialManager', () => {
  it('should store and retrieve credentials by systemCode', () => {
    const manager = new CredentialManager();
    manager.setCredentials('vendor-abc', { username: 'user1', password: 'pass1' });

    const creds = manager.getCredentials('vendor-abc');

    expect(creds).toEqual({ username: 'user1', password: 'pass1' });
  });

  it('should return null for unknown systemCode', () => {
    const manager = new CredentialManager();

    const creds = manager.getCredentials('unknown');

    expect(creds).toBeNull();
  });

  it('should get individual field value', () => {
    const manager = new CredentialManager();
    manager.setCredentials('vendor-abc', { username: 'user1', password: 'pass1' });

    expect(manager.getFieldValue('vendor-abc', 'username')).toBe('user1');
    expect(manager.getFieldValue('vendor-abc', 'password')).toBe('pass1');
  });

  it('should mask password in toString/toJSON', () => {
    const manager = new CredentialManager();
    manager.setCredentials('vendor-abc', { username: 'user1', password: 'pass1' });

    const masked = manager.getMaskedCredentials('vendor-abc');

    expect(masked).toEqual({ username: 'user1', password: '***' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/security/__tests__/credential-manager.test.ts`
Expected: FAIL - Cannot find module '../credential-manager'

**Step 3: Write minimal implementation**

```typescript
// src/security/credential-manager.ts
export interface Credentials {
  username: string;
  password: string;
}

export class CredentialManager {
  private store: Map<string, Credentials> = new Map();

  setCredentials(systemCode: string, credentials: Credentials): void {
    this.store.set(systemCode, credentials);
  }

  getCredentials(systemCode: string): Credentials | null {
    return this.store.get(systemCode) || null;
  }

  getFieldValue(systemCode: string, field: 'username' | 'password'): string | null {
    const creds = this.getCredentials(systemCode);
    return creds ? creds[field] : null;
  }

  getMaskedCredentials(systemCode: string): { username: string; password: string } | null {
    const creds = this.getCredentials(systemCode);
    if (!creds) return null;
    return { username: creds.username, password: '***' };
  }

  hasCredentials(systemCode: string): boolean {
    return this.store.has(systemCode);
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/security/index.ts
export * from './credential-manager';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/security/__tests__/credential-manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/security/
git commit -m "feat: add CredentialManager for secure credential handling"
```

---

## Task 2: Secure Fill Tool 생성

**Files:**
- Create: `src/mcp/secure-tools.ts`
- Create: `src/mcp/index.ts`
- Test: `src/mcp/__tests__/secure-tools.test.ts`

**Step 1: Write the failing test**

```typescript
// src/mcp/__tests__/secure-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSecureFillTool } from '../secure-tools';
import { CredentialManager } from '../../security';

describe('createSecureFillTool', () => {
  it('should create a tool that fills credentials without exposing password', async () => {
    const credManager = new CredentialManager();
    credManager.setCredentials('vendor-abc', { username: 'user1', password: 'secret123' });

    const mockMcpClient = {
      callTool: vi.fn().mockResolvedValue({ content: [{ text: 'Filled' }] }),
    };

    const tool = createSecureFillTool(credManager, mockMcpClient as any, 'vendor-abc');

    // LLM calls with field name only, not the actual value
    const result = await tool.invoke({ field: 'password', element: 'input[type="password"]' });

    expect(mockMcpClient.callTool).toHaveBeenCalledWith({
      name: 'browser_type',
      arguments: { element: 'input[type="password"]', text: 'secret123', submit: false },
    });
    expect(result).not.toContain('secret123'); // Password not in response
  });

  it('should reject invalid field names', async () => {
    const credManager = new CredentialManager();
    const mockMcpClient = { callTool: vi.fn() };

    const tool = createSecureFillTool(credManager, mockMcpClient as any, 'vendor-abc');

    const result = await tool.invoke({ field: 'invalid', element: 'input' });

    expect(result).toContain('Error');
    expect(mockMcpClient.callTool).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/mcp/__tests__/secure-tools.test.ts`
Expected: FAIL - Cannot find module '../secure-tools'

**Step 3: Write minimal implementation**

```typescript
// src/mcp/secure-tools.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CredentialManager } from '../security';

export function createSecureFillTool(
  credentialManager: CredentialManager,
  mcpClient: Client,
  systemCode: string
) {
  return tool(
    async ({ field, element }) => {
      // Validate field
      if (field !== 'username' && field !== 'password') {
        return `Error: Invalid field "${field}". Use "username" or "password".`;
      }

      // Get actual value from credential manager (LLM never sees this)
      const value = credentialManager.getFieldValue(systemCode, field);
      if (!value) {
        return `Error: No credentials found for ${systemCode}`;
      }

      // Call browser_type with actual value
      try {
        await mcpClient.callTool({
          name: 'browser_type',
          arguments: { element, text: value, submit: false },
        });

        // Return sanitized response (no actual value)
        return `✓ Filled ${field} field`;
      } catch (e) {
        return `Error filling ${field}: ${(e as Error).message}`;
      }
    },
    {
      name: 'secure_fill_credential',
      description: 'Securely fill username or password field. LLM specifies which field, actual value is injected internally.',
      schema: z.object({
        field: z.enum(['username', 'password']).describe('Which credential field to fill'),
        element: z.string().describe('Element selector or reference to fill'),
      }),
    }
  );
}
```

**Step 4: Create index.ts**

```typescript
// src/mcp/index.ts
export * from './secure-tools';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/mcp/__tests__/secure-tools.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/mcp/
git commit -m "feat: add secure_fill_credential tool for password-safe MCP"
```

---

## Task 3: LoginAnalyzer 결과 스키마 정의

**Files:**
- Modify: `src/schemas/index.ts`
- Create: `src/schemas/login-analysis.schema.ts`

**Step 1: Write the schema**

```typescript
// src/schemas/login-analysis.schema.ts
import { z } from 'zod';

export const LoginResultSchema = z.object({
  status: z.enum([
    'SUCCESS',              // 로그인 성공
    'INVALID_CREDENTIALS',  // id/pwd 틀림
    'FORM_CHANGED',         // 로그인 폼 구조 변경
    'API_CHANGED',          // 로그인 API 변경
    'CONNECTION_ERROR',     // 접속 실패
    'UNKNOWN_ERROR',        // 알 수 없는 에러
  ]),
  confidence: z.number().min(0).max(1),
  details: z.object({
    urlBefore: z.string(),
    urlAfter: z.string(),
    urlChanged: z.boolean(),
    loginFormFound: z.boolean(),
    loginFormSelectors: z.object({
      username: z.string().optional(),
      password: z.string().optional(),
      submit: z.string().optional(),
    }).optional(),
    errorMessage: z.string().optional(),
    successIndicators: z.array(z.string()).optional(),
    apiEndpoints: z.array(z.object({
      url: z.string(),
      method: z.string(),
      status: z.number().optional(),
    })).optional(),
  }),
  changes: z.object({
    domChanges: z.array(z.string()).optional(),
    apiChanges: z.array(z.string()).optional(),
  }).optional(),
  timestamp: z.string().datetime(),
});

export type LoginResult = z.infer<typeof LoginResultSchema>;
```

**Step 2: Update index.ts**

```typescript
// src/schemas/index.ts (add export)
export * from './login-analysis.schema';
```

**Step 3: Commit**

```bash
git add src/schemas/
git commit -m "feat: add LoginResult schema for login analysis"
```

---

## Task 4: SecureLoginAgent 클래스 구현

**Files:**
- Create: `src/agents/secure-login-agent.ts`
- Create: `src/agents/index.ts`

**Step 1: Write the agent**

```typescript
// src/agents/secure-login-agent.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { CredentialManager } from '../security';
import { createSecureFillTool } from '../mcp';
import { LoginResult } from '../schemas';

interface SecureLoginAgentConfig {
  systemCode: string;
  url: string;
  credentialManager: CredentialManager;
  llm: BaseChatModel;
  maxIterations?: number;
}

export class SecureLoginAgent {
  private config: SecureLoginAgentConfig;
  private mcpClient: Client | null = null;
  private networkLogs: { url: string; method: string; status?: number }[] = [];

  constructor(config: SecureLoginAgentConfig) {
    this.config = { maxIterations: 15, ...config };
  }

  async run(): Promise<LoginResult> {
    const timestamp = new Date().toISOString();
    let urlBefore = '';
    let urlAfter = '';

    try {
      // Start MCP server
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
      });

      this.mcpClient = new Client({ name: 'secure-login-agent', version: '1.0.0' });
      await this.mcpClient.connect(transport);

      // Get MCP tools and add secure_fill_credential
      const { tools: mcpTools } = await this.mcpClient.listTools();
      const langchainTools = this.convertMcpTools(mcpTools);

      // Add secure credential tool
      const secureFillTool = createSecureFillTool(
        this.config.credentialManager,
        this.mcpClient,
        this.config.systemCode
      );
      langchainTools.push(secureFillTool);

      // System prompt - NO PASSWORD MENTIONED
      const systemPrompt = this.buildSystemPrompt();

      // Run agent loop
      const messages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage('Start: Navigate to the login page and take a snapshot.'),
      ];

      let iteration = 0;
      let finalAnalysis = '';

      while (iteration < this.config.maxIterations!) {
        iteration++;

        const llmWithTools = this.config.llm.bindTools(langchainTools);
        const response = await llmWithTools.invoke(messages);
        messages.push(response);

        const toolCalls = response.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          finalAnalysis = response.content as string;
          break;
        }

        // Track URL changes
        if (iteration === 1) urlBefore = this.config.url;

        // Execute tools
        for (const toolCall of toolCalls) {
          const result = await this.executeTool(toolCall, langchainTools);
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: result,
          }));

          // Capture URL after navigation
          if (toolCall.name === 'browser_navigate' || toolCall.name === 'browser_click') {
            const snapshot = await this.getSnapshot();
            if (snapshot.url) urlAfter = snapshot.url;
          }
        }
      }

      // Parse final analysis
      return this.parseAnalysis(finalAnalysis, urlBefore, urlAfter, timestamp);

    } catch (error) {
      return {
        status: 'UNKNOWN_ERROR',
        confidence: 0,
        details: {
          urlBefore,
          urlAfter: urlAfter || urlBefore,
          urlChanged: false,
          loginFormFound: false,
          errorMessage: (error as Error).message,
        },
        timestamp,
      };
    } finally {
      if (this.mcpClient) {
        await this.mcpClient.close().catch(() => {});
      }
    }
  }

  private buildSystemPrompt(): string {
    return `You are a login flow analyzer for: ${this.config.url}
SystemCode: ${this.config.systemCode}

**YOUR TASK:**
1. Navigate to the URL
2. Find the login form (username, password fields, submit button)
3. Use secure_fill_credential to fill username field
4. Use secure_fill_credential to fill password field
5. Click the submit button
6. Analyze the result

**AVAILABLE TOOLS:**
- browser_navigate, browser_snapshot, browser_click, browser_wait_for
- secure_fill_credential(field: "username" | "password", element: "selector")
  → This tool securely fills credentials. You specify the field name, the actual value is injected internally.

**RULES:**
- NEVER ask for or try to input actual password values
- Use secure_fill_credential for ALL credential inputs
- After login attempt, analyze if:
  - SUCCESS: URL changed, dashboard/welcome visible
  - INVALID_CREDENTIALS: Error message about wrong id/password
  - FORM_CHANGED: Login form structure unexpected
  - API_CHANGED: Network requests different from expected

**FINAL RESPONSE FORMAT:**
After completing the flow, respond with JSON:
{
  "status": "SUCCESS|INVALID_CREDENTIALS|FORM_CHANGED|API_CHANGED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "loginFormSelectors": { "username": "...", "password": "...", "submit": "..." },
  "errorMessage": "if any",
  "observations": ["list of observations"]
}`;
  }

  private convertMcpTools(mcpTools: any[]): any[] {
    // Filter and convert MCP tools (same logic as runDomMcpAgent)
    const essentialTools = [
      'browser_navigate', 'browser_snapshot', 'browser_click',
      'browser_type', 'browser_press_key', 'browser_wait_for',
    ];

    return mcpTools
      .filter(t => {
        const schema = t.inputSchema as any;
        const hasParams = schema?.properties && Object.keys(schema.properties).length > 0;
        return hasParams || essentialTools.includes(t.name);
      })
      .filter(t => t.name !== 'browser_type') // Remove browser_type, use secure_fill_credential instead
      .map(t => this.convertSingleTool(t));
  }

  private convertSingleTool(mcpTool: any): any {
    const inputSchema = mcpTool.inputSchema as any;
    let zodSchema: z.ZodObject<any>;

    if (inputSchema?.properties && Object.keys(inputSchema.properties).length > 0) {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(inputSchema.properties)) {
        const prop = value as any;
        if (prop.type === 'string') {
          shape[key] = inputSchema.required?.includes(key)
            ? z.string().describe(prop.description || key)
            : z.string().optional().describe(prop.description || key);
        } else if (prop.type === 'number' || prop.type === 'integer') {
          shape[key] = inputSchema.required?.includes(key)
            ? z.number().describe(prop.description || key)
            : z.number().optional().describe(prop.description || key);
        } else if (prop.type === 'boolean') {
          shape[key] = inputSchema.required?.includes(key)
            ? z.boolean().describe(prop.description || key)
            : z.boolean().optional().describe(prop.description || key);
        } else {
          shape[key] = z.any().describe(prop.description || key);
        }
      }
      zodSchema = z.object(shape);
    } else {
      zodSchema = z.object({
        _unused: z.string().optional().describe('Unused parameter'),
      });
    }

    return tool(
      async (params) => {
        try {
          const result = await this.mcpClient!.callTool({
            name: mcpTool.name,
            arguments: params,
          });
          const content = result.content as any[];
          const text = content?.map(c => c.text || '').join('\n') || 'Done';
          return text.length > 5000 ? text.slice(0, 5000) + '\n...(truncated)' : text;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
      {
        name: mcpTool.name,
        description: mcpTool.description || mcpTool.name,
        schema: zodSchema,
      }
    );
  }

  private async executeTool(toolCall: any, tools: any[]): Promise<string> {
    const t = tools.find(t => t.name === toolCall.name);
    if (!t) return `Error: Tool "${toolCall.name}" not found`;

    try {
      return await t.invoke(toolCall.args);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  private async getSnapshot(): Promise<{ url?: string }> {
    if (!this.mcpClient) return {};
    try {
      const result = await this.mcpClient.callTool({ name: 'browser_snapshot', arguments: {} });
      const text = (result.content as any[])?.[0]?.text || '';
      const urlMatch = text.match(/Page URL: ([^\n]+)/);
      return { url: urlMatch?.[1] };
    } catch {
      return {};
    }
  }

  private parseAnalysis(analysis: string, urlBefore: string, urlAfter: string, timestamp: string): LoginResult {
    try {
      const jsonMatch = analysis.match(/```json\s*([\s\S]*?)\s*```/) || [null, analysis];
      const parsed = JSON.parse(jsonMatch[1] || analysis);

      return {
        status: parsed.status || 'UNKNOWN_ERROR',
        confidence: parsed.confidence || 0.5,
        details: {
          urlBefore,
          urlAfter,
          urlChanged: urlBefore !== urlAfter,
          loginFormFound: !!parsed.loginFormSelectors,
          loginFormSelectors: parsed.loginFormSelectors,
          errorMessage: parsed.errorMessage,
          successIndicators: parsed.observations,
        },
        timestamp,
      };
    } catch {
      return {
        status: 'UNKNOWN_ERROR',
        confidence: 0,
        details: {
          urlBefore,
          urlAfter,
          urlChanged: urlBefore !== urlAfter,
          loginFormFound: false,
          errorMessage: 'Failed to parse analysis',
        },
        timestamp,
      };
    }
  }
}
```

**Step 2: Create index.ts**

```typescript
// src/agents/index.ts
export * from './secure-login-agent';
```

**Step 3: Commit**

```bash
git add src/agents/
git commit -m "feat: add SecureLoginAgent with credential isolation"
```

---

## Task 5: CLI에 secure-login 명령어 연결

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

**Step 1: Add import and function to cli.ts**

Add at top of file:
```typescript
import { SecureLoginAgent } from './agents';
import { CredentialManager } from './security';
```

Add new function:
```typescript
async function runSecureLoginAgent(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Secure Login Agent] Starting for: ${input.url}`);

  const credManager = new CredentialManager();
  credManager.setCredentials(input.systemCode, {
    username: input.id,
    password: input.pwd,
  });

  const agent = new SecureLoginAgent({
    systemCode: input.systemCode,
    url: input.url,
    credentialManager: credManager,
    llm,
  });

  const result = await agent.run();

  return {
    agent: 'secure-login',
    success: result.status === 'SUCCESS',
    analysis: JSON.stringify(result, null, 2),
    data: result,
  };
}
```

**Step 2: Add CLI case**

In main() function, add:
```typescript
} else if (agentArg === 'secure-login') {
  results.push(await runSecureLoginAgent(input, llm));
}
```

**Step 3: Update package.json**

```json
"agent:secure-login": "tsx src/cli.ts secure-login"
```

**Step 4: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat: add secure-login CLI command"
```

---

## Task 6: 테스트 실행 및 검증

**Step 1: Run secure-login agent**

```bash
pnpm agent:secure-login
```

**Expected output:**
```
[Secure Login Agent] Starting for: https://console.humax-parcs.com
  ✓ MCP server connected
  [Agent Loop] Starting...
  --- Iteration 1/15 ---
    → browser_navigate
    → browser_snapshot
  --- Iteration 2/15 ---
    → secure_fill_credential (field: username)
    ← ✓ Filled username field
    → secure_fill_credential (field: password)
    ← ✓ Filled password field
    → browser_click
  ...
  [Final] SUCCESS with confidence 0.9
```

**Step 2: Verify password is never logged**

Check that:
- Console output never shows actual password
- LLM messages don't contain password
- Only "✓ Filled password field" appears

**Step 3: Commit**

```bash
git add -A
git commit -m "test: verify secure-login agent works"
```

---

## Summary

| Task | 설명 | 예상 시간 |
|------|------|----------|
| 1 | CredentialManager 클래스 | - |
| 2 | secure_fill_credential 도구 | - |
| 3 | LoginResult 스키마 | - |
| 4 | SecureLoginAgent 클래스 | - |
| 5 | CLI 연결 | - |
| 6 | 테스트 및 검증 | - |

**보안 체크리스트:**
- [ ] LLM 프롬프트에 pwd 없음
- [ ] LLM 응답에 pwd 없음
- [ ] 콘솔 출력에 pwd 없음
- [ ] secure_fill_credential만 credential 접근
