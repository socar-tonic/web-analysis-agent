# Login Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MCP 기반 로그인 에이전트 - 로그인 수행 + 프로세스 분석 + Spec 생성/비교 + 변경 감지

**Architecture:** LLM이 MCP Playwright 도구로 로그인 수행. 비밀번호는 CredentialManager로 격리. 로그인 과정의 DOM/Network를 캡처하여 LoginSpec 생성. 기존 Spec과 비교하여 변경 감지.

**Tech Stack:** TypeScript, Playwright MCP, Zod, @langchain/core

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Login Agent                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: { systemCode, url, credentials }                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  MCP Tool Loop                            │   │
│  │  - browser_navigate, browser_snapshot, browser_click      │   │
│  │  - secure_fill_credential (pwd 격리)                      │   │
│  │  - 🆕 capture_login_spec (DOM + Network 캡처)             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Analysis                                 │   │
│  │  1. 로그인 결과 판정 (SUCCESS/FAIL/CREDENTIAL/CHANGED)    │   │
│  │  2. LoginSpec 생성 (selectors, apiEndpoints)              │   │
│  │  3. 기존 Spec 비교 → 변경점 감지                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                          ▼                                       │
│  Output: LoginResult + LoginSpec + Changes                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 보안 설계

```
LLM이 아는 것:
  - systemCode, url
  - "username/password 필드가 있다"
  - DOM 구조, API 엔드포인트 (credential 마스킹)

LLM이 모르는 것:
  - 실제 id 값
  - 실제 pwd 값
  - Authorization 헤더 값
  - 쿠키/토큰 값
```

---

## Task 1: LoginSpec 스키마 정의

**Files:**
- Create: `src/schemas/login-spec.schema.ts`
- Modify: `src/schemas/index.ts`

**Step 1: Write LoginSpec schema**

```typescript
// src/schemas/login-spec.schema.ts
import { z } from 'zod';

// 로그인 폼 셀렉터 정보
export const LoginFormSpecSchema = z.object({
  usernameSelector: z.string(),
  passwordSelector: z.string(),
  submitSelector: z.string(),
  // 추가 필드 (OTP, 캡챠 등)
  additionalFields: z.array(z.object({
    name: z.string(),
    selector: z.string(),
    type: z.string(),
  })).optional(),
});

// 로그인 API 엔드포인트 정보
export const LoginApiSpecSchema = z.object({
  endpoint: z.string(),
  method: z.enum(['GET', 'POST', 'PUT']),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']),
  requestFields: z.array(z.string()), // ['username', 'password', 'rememberMe']
  responseFields: z.array(z.string()), // ['token', 'refreshToken', 'user']
});

// 전체 로그인 Spec
export const LoginSpecSchema = z.object({
  systemCode: z.string(),
  url: z.string(),
  capturedAt: z.string().datetime(),

  // 로그인 방식
  loginType: z.enum(['dom', 'api', 'hybrid']),

  // DOM 기반 로그인 정보
  form: LoginFormSpecSchema.optional(),

  // API 기반 로그인 정보
  api: LoginApiSpecSchema.optional(),

  // 로그인 성공 판별 조건
  successIndicators: z.object({
    urlPattern: z.string().optional(),       // 로그인 후 URL 패턴
    elementSelector: z.string().optional(),  // 로그인 후 나타나는 요소
    cookieName: z.string().optional(),       // 설정되는 쿠키 이름
  }),

  // 메타데이터
  version: z.number().default(1),
});

export type LoginSpec = z.infer<typeof LoginSpecSchema>;
export type LoginFormSpec = z.infer<typeof LoginFormSpecSchema>;
export type LoginApiSpec = z.infer<typeof LoginApiSpecSchema>;
```

**Step 2: Write LoginResult schema**

```typescript
// src/schemas/login-result.schema.ts
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

  // 상세 정보
  details: z.object({
    urlBefore: z.string(),
    urlAfter: z.string(),
    urlChanged: z.boolean(),
    errorMessage: z.string().optional(),
  }),

  // 변경 감지 (기존 Spec과 비교)
  changes: z.object({
    hasChanges: z.boolean(),
    formChanges: z.array(z.string()).optional(),  // ['usernameSelector changed', ...]
    apiChanges: z.array(z.string()).optional(),   // ['endpoint changed', ...]
  }).optional(),

  timestamp: z.string().datetime(),
});

export type LoginResult = z.infer<typeof LoginResultSchema>;
```

**Step 3: Update index.ts**

```typescript
// src/schemas/index.ts (add exports)
export * from './login-spec.schema';
export * from './login-result.schema';
```

**Step 4: Commit**

```bash
git add src/schemas/
git commit -m "feat: add LoginSpec and LoginResult schemas"
```

---

## Task 2: CredentialManager 생성

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
  it('should store and retrieve credentials', () => {
    const manager = new CredentialManager();
    manager.set('vendor-abc', { username: 'user1', password: 'pass1' });

    expect(manager.get('vendor-abc')).toEqual({ username: 'user1', password: 'pass1' });
  });

  it('should get individual field', () => {
    const manager = new CredentialManager();
    manager.set('vendor-abc', { username: 'user1', password: 'pass1' });

    expect(manager.getField('vendor-abc', 'username')).toBe('user1');
    expect(manager.getField('vendor-abc', 'password')).toBe('pass1');
  });

  it('should return null for unknown systemCode', () => {
    const manager = new CredentialManager();
    expect(manager.get('unknown')).toBeNull();
    expect(manager.getField('unknown', 'username')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/security/__tests__/credential-manager.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/security/credential-manager.ts
export interface Credentials {
  username: string;
  password: string;
}

export class CredentialManager {
  private store = new Map<string, Credentials>();

  set(systemCode: string, credentials: Credentials): void {
    this.store.set(systemCode, credentials);
  }

  get(systemCode: string): Credentials | null {
    return this.store.get(systemCode) || null;
  }

  getField(systemCode: string, field: 'username' | 'password'): string | null {
    const creds = this.get(systemCode);
    return creds ? creds[field] : null;
  }

  has(systemCode: string): boolean {
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
git commit -m "feat: add CredentialManager"
```

---

## Task 3: SpecStore 생성 (Spec 저장/조회/비교)

**Files:**
- Create: `src/specs/spec-store.ts`
- Create: `src/specs/index.ts`
- Test: `src/specs/__tests__/spec-store.test.ts`

**Step 1: Write the failing test**

```typescript
// src/specs/__tests__/spec-store.test.ts
import { describe, it, expect } from 'vitest';
import { SpecStore } from '../spec-store';
import { LoginSpec } from '../../schemas';

describe('SpecStore', () => {
  const sampleSpec: LoginSpec = {
    systemCode: 'vendor-abc',
    url: 'https://example.com',
    capturedAt: new Date().toISOString(),
    loginType: 'dom',
    form: {
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#submit',
    },
    successIndicators: {
      urlPattern: '/dashboard',
    },
    version: 1,
  };

  it('should save and load spec', () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const loaded = store.load('vendor-abc');
    expect(loaded?.systemCode).toBe('vendor-abc');
  });

  it('should detect changes between specs', () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const newSpec: LoginSpec = {
      ...sampleSpec,
      form: {
        usernameSelector: '#new-username', // changed
        passwordSelector: '#password',
        submitSelector: '#submit',
      },
    };

    const changes = store.compare('vendor-abc', newSpec);
    expect(changes.hasChanges).toBe(true);
    expect(changes.formChanges).toContain('usernameSelector: #username → #new-username');
  });

  it('should return no changes for identical specs', () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const changes = store.compare('vendor-abc', sampleSpec);
    expect(changes.hasChanges).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/specs/__tests__/spec-store.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/specs/spec-store.ts
import { LoginSpec } from '../schemas';

export interface SpecChanges {
  hasChanges: boolean;
  formChanges?: string[];
  apiChanges?: string[];
}

export class SpecStore {
  private store = new Map<string, LoginSpec>();

  save(spec: LoginSpec): void {
    this.store.set(spec.systemCode, spec);
  }

  load(systemCode: string): LoginSpec | null {
    return this.store.get(systemCode) || null;
  }

  has(systemCode: string): boolean {
    return this.store.has(systemCode);
  }

  compare(systemCode: string, newSpec: LoginSpec): SpecChanges {
    const oldSpec = this.load(systemCode);
    if (!oldSpec) {
      return { hasChanges: false }; // No previous spec to compare
    }

    const formChanges: string[] = [];
    const apiChanges: string[] = [];

    // Compare form selectors
    if (oldSpec.form && newSpec.form) {
      if (oldSpec.form.usernameSelector !== newSpec.form.usernameSelector) {
        formChanges.push(`usernameSelector: ${oldSpec.form.usernameSelector} → ${newSpec.form.usernameSelector}`);
      }
      if (oldSpec.form.passwordSelector !== newSpec.form.passwordSelector) {
        formChanges.push(`passwordSelector: ${oldSpec.form.passwordSelector} → ${newSpec.form.passwordSelector}`);
      }
      if (oldSpec.form.submitSelector !== newSpec.form.submitSelector) {
        formChanges.push(`submitSelector: ${oldSpec.form.submitSelector} → ${newSpec.form.submitSelector}`);
      }
    }

    // Compare API
    if (oldSpec.api && newSpec.api) {
      if (oldSpec.api.endpoint !== newSpec.api.endpoint) {
        apiChanges.push(`endpoint: ${oldSpec.api.endpoint} → ${newSpec.api.endpoint}`);
      }
      if (oldSpec.api.method !== newSpec.api.method) {
        apiChanges.push(`method: ${oldSpec.api.method} → ${newSpec.api.method}`);
      }
    }

    const hasChanges = formChanges.length > 0 || apiChanges.length > 0;

    return {
      hasChanges,
      formChanges: formChanges.length > 0 ? formChanges : undefined,
      apiChanges: apiChanges.length > 0 ? apiChanges : undefined,
    };
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/specs/index.ts
export * from './spec-store';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/specs/__tests__/spec-store.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/specs/
git commit -m "feat: add SpecStore for LoginSpec storage and comparison"
```

---

## Task 4: LoginAgent 클래스 구현

**Files:**
- Create: `src/agents/login-agent.ts`
- Create: `src/agents/index.ts`

**Step 1: Write LoginAgent**

```typescript
// src/agents/login-agent.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { CredentialManager } from '../security';
import { SpecStore } from '../specs';
import { LoginSpec, LoginResult } from '../schemas';

interface LoginAgentConfig {
  systemCode: string;
  url: string;
  credentialManager: CredentialManager;
  specStore: SpecStore;
  llm: BaseChatModel;
  maxIterations?: number;
}

export class LoginAgent {
  private config: LoginAgentConfig;
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
      console.log('  ✓ MCP connected');

      // Build tools
      const tools = await this.buildTools();
      console.log(`  ✓ ${tools.length} tools ready`);

      // Run agent loop
      const messages = this.buildInitialMessages();
      let iteration = 0;
      let finalResponse = '';

      console.log('\n  [Agent Loop]');
      while (iteration < this.config.maxIterations!) {
        iteration++;
        console.log(`  --- Iteration ${iteration}/${this.config.maxIterations} ---`);

        const llmWithTools = this.config.llm.bindTools(tools);
        const response = await llmWithTools.invoke(messages);
        messages.push(response);

        const toolCalls = response.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          finalResponse = response.content as string;
          break;
        }

        for (const tc of toolCalls) {
          console.log(`    → ${tc.name}`);
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
      const changes = this.config.specStore.compare(this.config.systemCode, spec);

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
      console.log('  MCP closed');
    }
  }

  private async buildTools() {
    const { tools: mcpTools } = await this.mcpClient!.listTools();

    // Filter MCP tools
    const allowedTools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_wait_for', 'browser_press_key'];
    const filtered = mcpTools.filter(t => {
      const schema = t.inputSchema as any;
      const hasParams = schema?.properties && Object.keys(schema.properties).length > 0;
      return hasParams || allowedTools.includes(t.name);
    }).filter(t => t.name !== 'browser_type'); // Use secure_fill instead

    const langchainTools = filtered.map(t => this.convertMcpTool(t));

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
          return `✓ Filled ${field} field`;
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

  private parseAnalysis(response: string): any {
    try {
      const match = response.match(/```json\s*([\s\S]*?)\s*```/) || [null, response];
      return JSON.parse(match[1] || response);
    } catch {
      return { status: 'UNKNOWN_ERROR', confidence: 0 };
    }
  }
}
```

**Step 2: Create index.ts**

```typescript
// src/agents/index.ts
export * from './login-agent';
```

**Step 3: Commit**

```bash
git add src/agents/
git commit -m "feat: add LoginAgent with MCP and spec capture"
```

---

## Task 5: CLI 연결

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

**Step 1: Add imports to cli.ts (top of file)**

```typescript
import { LoginAgent } from './agents';
import { CredentialManager } from './security';
import { SpecStore } from './specs';
```

**Step 2: Add runLoginAgent function**

```typescript
async function runLoginAgentCommand(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Login Agent] Starting for: ${input.url}`);

  const credManager = new CredentialManager();
  credManager.set(input.systemCode, { username: input.id, password: input.pwd });

  const specStore = new SpecStore();

  const agent = new LoginAgent({
    systemCode: input.systemCode,
    url: input.url,
    credentialManager: credManager,
    specStore,
    llm,
  });

  const { result, spec } = await agent.run();

  console.log('\n  [Result]');
  console.log(`    Status: ${result.status}`);
  console.log(`    Confidence: ${result.confidence}`);
  if (result.changes?.hasChanges) {
    console.log(`    ⚠️ Changes detected:`);
    result.changes.formChanges?.forEach(c => console.log(`      - ${c}`));
    result.changes.apiChanges?.forEach(c => console.log(`      - ${c}`));
  }

  return {
    agent: 'login',
    success: result.status === 'SUCCESS',
    analysis: JSON.stringify({ result, spec }, null, 2),
    data: { result, spec },
  };
}
```

**Step 3: Add CLI case in main()**

```typescript
} else if (agentArg === 'login') {
  results.push(await runLoginAgentCommand(input, llm));
}
```

**Step 4: Update package.json**

```json
"agent:login": "tsx src/cli.ts login"
```

**Step 5: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat: connect LoginAgent to CLI"
```

---

## Task 6: 테스트 실행

**Step 1: Run login agent**

```bash
pnpm agent:login
```

**Expected output:**
```
[Login Agent] Starting for: https://console.humax-parcs.com
  ✓ MCP connected
  ✓ 6 tools ready

  [Agent Loop]
  --- Iteration 1/15 ---
    → browser_navigate
    → browser_snapshot
  --- Iteration 2/15 ---
    → secure_fill_credential
    ✓ Filled username field
    → secure_fill_credential
    ✓ Filled password field
    → browser_click
  ...

  [Result]
    Status: SUCCESS
    Confidence: 0.9

  MCP closed
```

**Step 2: Verify security**

- Console output에 실제 password 없음
- LLM 응답에 password 없음
- "✓ Filled password field"만 표시

**Step 3: Commit**

```bash
git add -A
git commit -m "test: verify LoginAgent works"
```

---

## Summary

| Task | 설명 |
|------|------|
| 1 | LoginSpec, LoginResult 스키마 |
| 2 | CredentialManager (보안) |
| 3 | SpecStore (저장/비교) |
| 4 | LoginAgent 클래스 |
| 5 | CLI 연결 |
| 6 | 테스트 실행 |

**Output:**
- `LoginResult`: 성공/실패/credential오류/폼변경 판정
- `LoginSpec`: 캡처된 셀렉터, API 정보
- `Changes`: 기존 Spec과 비교 결과
