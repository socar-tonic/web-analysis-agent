# SearchGraph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** LoginGraph에서 로그인 성공 후 브라우저를 이어받아 차량 검색을 수행하는 LangGraph StateGraph 기반 워크플로우 구축

**Architecture:** LoginGraph와 동일한 패턴의 StateGraph. 별도 LLM 모델 지원. DOM 분석 → 스크린샷 폴백 → Hint 폴백 → 기존 Spec 폴백 순서로 검색 방법 도출. 네트워크 요청 캡처 및 Spec 변경 감지.

**Tech Stack:** @langchain/langgraph StateGraph, Playwright MCP, Zod schemas, TypeScript

---

## 워크플로우 개요

```
[LoginGraph에서 MCP 클라이언트 + 세션 전달]
                    ↓
              loadSpec (기존 스펙 로드)
                    ↓
         analyzeSearchMethod (DOM 분석)
                    ↓
         [실패] → screenshotFallback (스크린샷 분석)
                    ↓
         [실패] → hintFallback (Spec hint 사용)
                    ↓
         [실패] → specFallback (기존 Spec 방식 시도)
                    ↓
              [API 방식] → executeApiSearch → END (API는 다음 화면 불가)
              [DOM 방식] → executeSearch
                    ↓
              captureResults (네트워크 캡처 + 결과 분석)
                    ↓
              compareSpec (Spec 변경 감지)
                    ↓
         [차량 발견 + 문제 없음] → END (DiscountGraph로 전달)
         [차량 없음] → END (입차 안함, 정상)
         [에러/변경 감지] → END (보고)
```

---

## Task 1: SearchGraph State 정의

**Files:**
- Create: `src/agents/search-graph/state.ts`
- Test: `src/agents/search-graph/__tests__/state.test.ts`

**Step 1: 실패하는 테스트 작성**

```typescript
// src/agents/search-graph/__tests__/state.test.ts
import { describe, it, expect } from 'vitest';
import { SearchGraphState } from '../state.js';

describe('SearchGraphState', () => {
  it('should export SearchGraphState annotation', () => {
    expect(SearchGraphState).toBeDefined();
    expect(SearchGraphState.Root).toBeDefined();
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `pnpm test:run src/agents/search-graph/__tests__/state.test.ts`
Expected: FAIL - Cannot find module

**Step 3: State 구현**

```typescript
// src/agents/search-graph/state.ts
import { Annotation } from '@langchain/langgraph';
import type { SearchSpec } from '../../schemas/index.js';
import type { SessionInfo } from '../login-graph/state.js';

export type SearchStatus =
  | 'pending'
  | 'SUCCESS'              // 차량 발견
  | 'NOT_FOUND'            // 입차 기록 없음 (정상)
  | 'FORM_CHANGED'         // DOM UI 변경 감지
  | 'API_CHANGED'          // API 변경 감지
  | 'SESSION_EXPIRED'      // 세션 만료
  | 'CONNECTION_ERROR'     // 연결 오류
  | 'TIMEOUT_ERROR'        // 타임아웃
  | 'UNKNOWN_ERROR';

export type SearchMethodType = 'dom' | 'api' | 'unknown';
export type AnalysisSource = 'dom_analysis' | 'screenshot' | 'hint' | 'spec_fallback';

export interface SearchFormElements {
  searchInputRef: string | null;
  searchInputSelector: string | null;
  searchButtonRef: string | null;
  searchButtonSelector: string | null;
}

export interface VehicleInfo {
  id?: string;
  plateNumber: string;
  inTime: string;
  outTime?: string;
  parkingFee?: number;
}

export interface CapturedNetworkRequest {
  url: string;
  method: string;
  requestBody?: any;
  responseStatus: number;
  responseBody?: any;
  timestamp: number;
}

export interface SpecChanges {
  hasChanges: boolean;
  changeType: 'dom' | 'api' | 'both' | null;
  changes: string[];
  codeWillBreak: boolean;
}

export const SearchGraphState = Annotation.Root({
  // Input (from LoginGraph)
  systemCode: Annotation<string>,
  url: Annotation<string>,
  carNum: Annotation<string>,
  session: Annotation<SessionInfo>({ reducer: (_, b) => b, default: () => ({}) }),

  // Spec
  spec: Annotation<SearchSpec | null>({ reducer: (_, b) => b, default: () => null }),

  // Analysis state
  snapshot: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  screenshot: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  searchMethod: Annotation<SearchMethodType>({ reducer: (_, b) => b, default: () => 'unknown' }),
  analysisSource: Annotation<AnalysisSource | null>({ reducer: (_, b) => b, default: () => null }),
  formElements: Annotation<SearchFormElements>({
    reducer: (_, b) => b,
    default: () => ({ searchInputRef: null, searchInputSelector: null, searchButtonRef: null, searchButtonSelector: null }),
  }),

  // Network capture
  capturedRequests: Annotation<CapturedNetworkRequest[]>({ reducer: (_, b) => b, default: () => [] }),

  // Results
  vehicle: Annotation<VehicleInfo | null>({ reducer: (_, b) => b, default: () => null }),
  resultCount: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // Output
  status: Annotation<SearchStatus>({ reducer: (_, b) => b, default: () => 'pending' }),
  confidence: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  errorMessage: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  specChanges: Annotation<SpecChanges | null>({ reducer: (_, b) => b, default: () => null }),

  // For DiscountGraph handoff
  readyForDiscount: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
});

export type SearchGraphStateType = typeof SearchGraphState.State;
```

**Step 4: 테스트 통과 확인**

Run: `pnpm test:run src/agents/search-graph/__tests__/state.test.ts`
Expected: PASS

**Step 5: 커밋**

```bash
git add src/agents/search-graph/state.ts src/agents/search-graph/__tests__/state.test.ts
git commit -m "feat(search-graph): add state definition"
```

---

## Task 2: Utils 모듈 생성

**Files:**
- Create: `src/agents/search-graph/utils.ts`
- Test: `src/agents/search-graph/__tests__/utils.test.ts`

**Step 1: 테스트 작성**

```typescript
// src/agents/search-graph/__tests__/utils.test.ts
import { describe, it, expect } from 'vitest';
import { extractTextFromMcpResult, extractLast4Digits } from '../utils.js';

describe('utils', () => {
  it('should extract text from MCP result', () => {
    const result = { content: [{ text: 'Hello' }, { text: ' World' }] };
    expect(extractTextFromMcpResult(result)).toBe('Hello\n World');
  });

  it('should extract last 4 digits', () => {
    expect(extractLast4Digits('12가3456')).toBe('3456');
    expect(extractLast4Digits('서울12가3456')).toBe('3456');
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `pnpm test:run src/agents/search-graph/__tests__/utils.test.ts`

**Step 3: Utils 구현**

```typescript
// src/agents/search-graph/utils.ts
export function extractTextFromMcpResult(result: any): string {
  const contents = result.content as any[];
  return contents?.map((c: any) => c.text || '').join('\n') || '';
}

export function extractLast4Digits(carNum: string): string {
  return carNum.replace(/[^0-9]/g, '').slice(-4);
}

// Network interceptor JS (from login-graph)
export const NETWORK_INTERCEPTOR_JS = `() => {
  if (window.__networkInterceptorInstalled) return 'Already installed';
  window.__networkInterceptorInstalled = true;
  window.__capturedApiRequests = [];
  // ... (login-graph/nodes/check-connection.ts의 인터셉터 코드 재사용)
  return 'Network interceptor installed';
}`;

export const GET_CAPTURED_REQUESTS_JS = `() => JSON.stringify(window.__capturedApiRequests || [])`;
```

**Step 4: 테스트 통과 확인**

**Step 5: 커밋**

```bash
git add src/agents/search-graph/utils.ts src/agents/search-graph/__tests__/utils.test.ts
git commit -m "feat(search-graph): add utils module"
```

---

## Task 3: NodeContext 및 Index 설정

**Files:**
- Create: `src/agents/search-graph/index.ts`

**Step 1: Index 구현**

```typescript
// src/agents/search-graph/index.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SpecStore } from '../../specs/index.js';

export interface SearchGraphConfig {
  systemCode: string;
  url: string;
  carNum: string;
  session: import('./state.js').SessionInfo;
  specStore: SpecStore;
  llm: BaseChatModel;  // SearchGraph 전용 LLM (별도 모델 가능)
  mcpClient: Client;   // LoginGraph에서 전달받은 MCP 클라이언트 (필수)
}

export interface NodeContext {
  mcpClient: Client;
  specStore: SpecStore;
  llm: BaseChatModel;
  systemCode: string;
  carNum: string;
}

let _nodeContext: NodeContext | null = null;

export function getNodeContext(): NodeContext {
  if (!_nodeContext) throw new Error('Node context not initialized');
  return _nodeContext;
}

export function setNodeContext(ctx: NodeContext): void {
  _nodeContext = ctx;
}

export function clearNodeContext(): void {
  _nodeContext = null;
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/index.ts
git commit -m "feat(search-graph): add NodeContext setup"
```

---

## Task 4: loadSpec 노드

**Files:**
- Create: `src/agents/search-graph/nodes/load-spec.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/load-spec.ts
import type { SearchGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';

export async function loadSpec(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const spec = ctx.specStore.load(state.systemCode);

  console.log(spec
    ? `  [loadSpec] Loaded spec v${spec.version} for ${state.systemCode}`
    : `  [loadSpec] No spec found for ${state.systemCode}`);

  return { spec };
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/load-spec.ts
git commit -m "feat(search-graph): add loadSpec node"
```

---

## Task 5: analyzeSearchMethod 노드 (DOM 분석) - createAgent 사용

**Files:**
- Create: `src/agents/search-graph/nodes/analyze-search-method.ts`

**설계 결정:** 이 노드는 `createAgent`를 사용합니다. 에이전트가 스냅샷을 보고 자율적으로 검색 요소를 찾아야 하며, 필요시 여러 번 시도하거나 다른 접근법을 시도할 수 있어야 합니다.

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/analyze-search-method.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, SearchFormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const ANALYZE_PROMPT = `로그인 성공 후 화면에서 차량 검색 방법을 찾으세요.

## 도구 사용
1. browser_snapshot으로 DOM 구조 확인
2. 검색 관련 요소 찾기:
   - 검색 입력 필드 (type="text", name/id에 car, vehicle, 차량, 번호)
   - 검색 버튼 (조회, 검색, Search)
   - 숫자 키패드 (0-9 버튼이 있는 경우)

## 응답 형식 (JSON)
{
  "found": true/false,
  "searchInputRef": "e12",
  "searchInputSelector": "input[name='carNo']",
  "searchButtonRef": "e18",
  "searchButtonSelector": "button.search",
  "isKeypad": false,
  "confidence": 0.9
}`;

export async function analyzeSearchMethod(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [analyzeSearchMethod] Starting agent-based DOM analysis...');

  // Build tools for the agent
  const browserSnapshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {},
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_snapshot',
      description: 'Take a DOM snapshot of the current page to analyze structure',
      schema: z.object({
        _unused: z.string().optional().describe('Not used'),
      }),
    }
  );

  const browserEvaluateTool = tool(
    async ({ code }: { code: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_evaluate',
      description: 'Evaluate JavaScript to find elements or test selectors',
      schema: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserEvaluateTool],
      systemPrompt: ANALYZE_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('화면을 분석하고 차량 검색 방법을 찾아주세요.')] },
      { recursionLimit: 10 }
    );

    // Extract final response
    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (typeof messages[i].content === 'string' && messages[i].content.trim()) {
        finalResponse = messages[i].content;
        break;
      }
    }

    console.log(`  [analyzeSearchMethod] Agent response: ${finalResponse.slice(0, 200)}...`);

    const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.found) {
        console.log(`  [analyzeSearchMethod] Found: input=${parsed.searchInputRef}, button=${parsed.searchButtonRef}`);
        return {
          searchMethod: parsed.isKeypad ? 'dom' : 'dom',
          analysisSource: 'dom_analysis',
          formElements: {
            searchInputRef: parsed.searchInputRef || null,
            searchInputSelector: parsed.searchInputSelector || null,
            searchButtonRef: parsed.searchButtonRef || null,
            searchButtonSelector: parsed.searchButtonSelector || null,
          },
          confidence: parsed.confidence || 0.8,
        };
      }
    }

    console.log('  [analyzeSearchMethod] Agent could not find search elements');
    return { searchMethod: 'unknown' };
  } catch (e) {
    console.log(`  [analyzeSearchMethod] Error: ${(e as Error).message}`);
    return { searchMethod: 'unknown' };
  }
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/analyze-search-method.ts
git commit -m "feat(search-graph): add analyzeSearchMethod node with createAgent"
```

---

## Task 6: screenshotFallback 노드 - createAgent 사용

**Files:**
- Create: `src/agents/search-graph/nodes/screenshot-fallback.ts`

**설계 결정:** 스크린샷 기반 시각적 분석. 에이전트가 스크린샷을 보고 검색 UI를 찾고, 필요시 DOM 스냅샷과 교차 검증합니다.

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/screenshot-fallback.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { SearchGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const SCREENSHOT_PROMPT = `DOM 분석으로 검색 요소를 찾지 못했습니다. 스크린샷을 보고 차량 검색 UI를 찾아주세요.

## 도구 사용
1. browser_take_screenshot - 현재 화면 스크린샷 촬영
2. browser_snapshot - DOM과 비교하여 요소 식별

## 찾아야 할 것
- 검색 입력 필드 (텍스트 박스)
- 숫자 키패드 (0-9 버튼)
- 검색/조회 버튼

## 응답 (JSON)
{
  "found": true/false,
  "inputType": "text|keypad",
  "searchInputRef": "e12",
  "searchButtonRef": "e18",
  "description": "발견한 UI 설명"
}`;

export async function screenshotFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [screenshotFallback] Starting visual analysis with agent...');

  const browserScreenshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_take_screenshot',
        arguments: { type: 'png' },
      });
      const contents = result.content as any[];
      for (const c of contents) {
        if (c.type === 'image' && c.data) {
          const filename = `search-screenshot-${Date.now()}.png`;
          writeFileSync(filename, Buffer.from(c.data, 'base64'));
          return `Screenshot saved: ${filename}. Analyze this image to find search UI elements.`;
        }
      }
      return 'No screenshot captured';
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take a screenshot of the current page for visual analysis',
      schema: z.object({ _unused: z.string().optional() }),
    }
  );

  const browserSnapshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {},
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_snapshot',
      description: 'Take a DOM snapshot to cross-reference with visual findings',
      schema: z.object({ _unused: z.string().optional() }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserScreenshotTool, browserSnapshotTool],
      systemPrompt: SCREENSHOT_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('스크린샷을 찍고 검색 UI를 시각적으로 분석해주세요.')] },
      { recursionLimit: 8 }
    );

    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (typeof messages[i].content === 'string' && messages[i].content.trim()) {
        finalResponse = messages[i].content;
        break;
      }
    }

    const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.found) {
        console.log(`  [screenshotFallback] Found: ${parsed.description}`);
        return {
          searchMethod: 'dom',
          analysisSource: 'screenshot',
          formElements: {
            searchInputRef: parsed.searchInputRef || null,
            searchInputSelector: null,
            searchButtonRef: parsed.searchButtonRef || null,
            searchButtonSelector: null,
          },
        };
      }
    }

    console.log('  [screenshotFallback] Visual analysis could not find search UI');
    return { searchMethod: 'unknown' };
  } catch (e) {
    console.log(`  [screenshotFallback] Error: ${(e as Error).message}`);
    return { searchMethod: 'unknown' };
  }
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/screenshot-fallback.ts
git commit -m "feat(search-graph): add screenshotFallback node with createAgent"
```

---

## Task 7: hintFallback 노드

**Files:**
- Create: `src/agents/search-graph/nodes/hint-fallback.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/hint-fallback.ts
import type { SearchGraphStateType } from '../state.js';

export async function hintFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const hints = state.spec?.hints?.search;

  if (!hints) {
    console.log('  [hintFallback] No search hints in spec');
    return { searchMethod: 'unknown' };
  }

  console.log(`  [hintFallback] Using hints: inputMethod=${hints.inputMethod}`);

  if (hints.inputSelector || hints.inputMethod) {
    return {
      searchMethod: 'dom',
      analysisSource: 'hint',
      formElements: {
        searchInputRef: null,
        searchInputSelector: hints.inputSelector || null,
        searchButtonRef: null,
        searchButtonSelector: hints.searchButtonText ? `button:contains("${hints.searchButtonText}")` : null,
      },
    };
  }

  return { searchMethod: 'unknown' };
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/hint-fallback.ts
git commit -m "feat(search-graph): add hintFallback node"
```

---

## Task 8: specFallback 노드

**Files:**
- Create: `src/agents/search-graph/nodes/spec-fallback.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/spec-fallback.ts
import type { SearchGraphStateType } from '../state.js';

export async function specFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const spec = state.spec;

  if (!spec) {
    console.log('  [specFallback] No existing spec available');
    return {
      status: 'FORM_CHANGED',
      errorMessage: '검색 방법을 찾을 수 없고, 기존 spec도 없음',
    };
  }

  console.log(`  [specFallback] Using existing spec: searchType=${spec.searchType}`);

  if (spec.searchType === 'api' && spec.api) {
    return {
      searchMethod: 'api',
      analysisSource: 'spec_fallback',
    };
  }

  if (spec.searchType === 'dom' && spec.form) {
    return {
      searchMethod: 'dom',
      analysisSource: 'spec_fallback',
      formElements: {
        searchInputRef: null,
        searchInputSelector: spec.form.searchInputSelector,
        searchButtonRef: null,
        searchButtonSelector: spec.form.searchButtonSelector,
      },
    };
  }

  return {
    status: 'FORM_CHANGED',
    errorMessage: '기존 spec의 검색 방법이 유효하지 않음',
  };
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/spec-fallback.ts
git commit -m "feat(search-graph): add specFallback node"
```

---

## Task 9: executeApiSearch 노드 (API 방식 검색)

**Files:**
- Create: `src/agents/search-graph/nodes/execute-api-search.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/execute-api-search.ts
import type { SearchGraphStateType, CapturedNetworkRequest } from '../state.js';
import { getNodeContext } from '../index.js';

export async function executeApiSearch(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const spec = state.spec;

  if (!spec?.api) {
    return { status: 'API_CHANGED', errorMessage: 'API spec not found' };
  }

  console.log(`  [executeApiSearch] Calling API: ${spec.api.method} ${spec.api.endpoint}`);

  try {
    // 세션에서 인증 토큰 추출
    const authHeaders: Record<string, string> = {};
    if (state.session.accessToken) {
      authHeaders['Authorization'] = `Bearer ${state.session.accessToken}`;
    }

    // fetch로 API 호출 (브라우저 내에서 실행)
    const fetchCode = `
      (async () => {
        const response = await fetch('${spec.api.endpoint}', {
          method: '${spec.api.method}',
          headers: {
            'Content-Type': 'application/json',
            ${Object.entries(authHeaders).map(([k, v]) => `'${k}': '${v}'`).join(',')}
          },
          ${spec.api.method === 'POST' ? `body: JSON.stringify({ carNum: '${ctx.carNum}' })` : ''}
        });
        const data = await response.json();
        return JSON.stringify({ status: response.status, data });
      })()
    `;

    const result = await ctx.mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: fetchCode },
    });

    const text = (result.content as any[])?.[0]?.text || '';
    const response = JSON.parse(text);

    if (response.status >= 400) {
      console.log(`  [executeApiSearch] API error: ${response.status}`);
      return {
        status: 'API_CHANGED',
        errorMessage: `API 호출 실패: HTTP ${response.status}`,
        capturedRequests: [{
          url: spec.api.endpoint,
          method: spec.api.method,
          responseStatus: response.status,
          responseBody: response.data,
          timestamp: Date.now(),
        }],
      };
    }

    // API 성공 - 결과 분석
    const hasVehicle = response.data && (
      response.data.length > 0 ||
      response.data.result ||
      response.data.vehicle
    );

    console.log(`  [executeApiSearch] API success, vehicle found: ${hasVehicle}`);

    return {
      status: hasVehicle ? 'SUCCESS' : 'NOT_FOUND',
      confidence: 0.9,
      vehicle: hasVehicle ? {
        plateNumber: ctx.carNum,
        inTime: response.data.inTime || response.data[0]?.inTime || '',
      } : null,
      capturedRequests: [{
        url: spec.api.endpoint,
        method: spec.api.method,
        responseStatus: response.status,
        responseBody: response.data,
        timestamp: Date.now(),
      }],
    };
  } catch (e) {
    console.log(`  [executeApiSearch] Error: ${(e as Error).message}`);
    return {
      status: 'API_CHANGED',
      errorMessage: `API 호출 중 오류: ${(e as Error).message}`,
    };
  }
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/execute-api-search.ts
git commit -m "feat(search-graph): add executeApiSearch node"
```

---

## Task 10: executeSearch 노드 (DOM 방식 검색)

**Files:**
- Create: `src/agents/search-graph/nodes/execute-search.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/execute-search.ts
import type { SearchGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult, extractLast4Digits } from '../utils.js';

export async function executeSearch(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient } = ctx;
  const { formElements } = state;

  console.log('  [executeSearch] Executing DOM-based search...');

  try {
    // 1. 입력 필드에 차량번호 입력
    const inputRef = formElements.searchInputRef;
    const inputSelector = formElements.searchInputSelector;

    if (inputRef) {
      await mcpClient.callTool({
        name: 'browser_type',
        arguments: { ref: inputRef, text: ctx.carNum, submit: false },
      });
    } else if (inputSelector) {
      // selector로 직접 입력
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: {
          function: `(() => {
            const el = document.querySelector('${inputSelector}');
            if (el) { el.value = '${ctx.carNum}'; el.dispatchEvent(new Event('input')); }
          })()`,
        },
      });
    } else {
      // 키패드 방식 시도
      const digits = extractLast4Digits(ctx.carNum);
      console.log(`  [executeSearch] Using keypad for digits: ${digits}`);

      for (const digit of digits) {
        await mcpClient.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: `(() => {
              const btns = document.querySelectorAll('button, a, td, span, div');
              for (const b of btns) {
                if (b.textContent?.trim() === '${digit}') { b.click(); return 'clicked'; }
              }
              return 'not found';
            })()`,
          },
        });
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log('  [executeSearch] Input complete, clicking search button...');

    // 2. 검색 버튼 클릭
    const buttonRef = formElements.searchButtonRef;
    const buttonSelector = formElements.searchButtonSelector;

    if (buttonRef) {
      await mcpClient.callTool({
        name: 'browser_click',
        arguments: { ref: buttonRef },
      });
    } else if (buttonSelector) {
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: {
          function: `(() => {
            const el = document.querySelector('${buttonSelector}');
            if (el) el.click();
          })()`,
        },
      });
    } else {
      // 조회 버튼 텍스트로 찾기
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: {
          function: `(() => {
            const btns = document.querySelectorAll('button, a, input[type=submit]');
            for (const b of btns) {
              const t = (b.textContent || b.value || '').trim();
              if (['조회', '검색', 'Search', '찾기'].includes(t)) { b.click(); return; }
            }
          })()`,
        },
      });
    }

    // 3. 결과 대기
    await new Promise(r => setTimeout(r, 1500));

    console.log('  [executeSearch] Search executed');
    return {};
  } catch (e) {
    console.log(`  [executeSearch] Error: ${(e as Error).message}`);

    // DOM 실패 시 UI 변경 가능성
    if (state.analysisSource === 'spec_fallback') {
      return {
        status: 'FORM_CHANGED',
        errorMessage: `기존 spec으로 검색 실패 - UI 변경됨: ${(e as Error).message}`,
      };
    }

    return {
      status: 'UNKNOWN_ERROR',
      errorMessage: (e as Error).message,
    };
  }
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/execute-search.ts
git commit -m "feat(search-graph): add executeSearch node for DOM-based search"
```

---

## Task 11: captureResults 노드 - createAgent 사용

**Files:**
- Create: `src/agents/search-graph/nodes/capture-results.ts`

**설계 결정:** 검색 결과 분석은 복잡한 판단이 필요합니다. 에이전트가 스냅샷, 스크린샷, 네트워크 요청을 종합적으로 분석하여 결과를 판정합니다.

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/capture-results.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, CapturedNetworkRequest, VehicleInfo } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult, GET_CAPTURED_REQUESTS_JS } from '../utils.js';

const CAPTURE_RESULTS_PROMPT = `차량 검색 후 결과를 분석하세요.

## 도구 사용
1. browser_snapshot - 결과 화면 DOM 확인
2. browser_take_screenshot - 시각적 확인
3. get_network_requests - 검색 API 응답 확인

## 판단 기준
- SUCCESS: 차량 정보 표시됨 (입차시간, 차량번호, 주차요금 등)
- NOT_FOUND: "결과 없음", "해당 차량 없음", 빈 테이블 (입차 안함 - 정상)
- SESSION_EXPIRED: 로그인 화면으로 리다이렉트됨
- TIMEOUT_ERROR: 타임아웃, 무한 로딩

## 응답 (JSON)
{
  "status": "SUCCESS|NOT_FOUND|SESSION_EXPIRED|TIMEOUT_ERROR|UNKNOWN_ERROR",
  "vehicleFound": true/false,
  "resultCount": 0,
  "vehicle": {
    "plateNumber": "12가3456",
    "inTime": "2026-01-28 10:30",
    "outTime": null,
    "parkingFee": 5000
  },
  "confidence": 0.9,
  "reasoning": "판단 근거"
}`;

export async function captureResults(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm, carNum } = ctx;

  console.log('  [captureResults] Starting agent-based result analysis...');

  // 네트워크 요청 캡처 (에이전트 시작 전에)
  let capturedRequests: CapturedNetworkRequest[] = [];
  try {
    const networkResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: GET_CAPTURED_REQUESTS_JS },
    });
    capturedRequests = JSON.parse(extractTextFromMcpResult(networkResult));
    console.log(`  [captureResults] Pre-captured ${capturedRequests.length} network requests`);
  } catch {}

  // Build tools
  const browserSnapshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {},
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_snapshot',
      description: 'Get DOM snapshot to analyze search results',
      schema: z.object({ _unused: z.string().optional() }),
    }
  );

  const browserScreenshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_take_screenshot',
        arguments: { type: 'png' },
      });
      const contents = result.content as any[];
      for (const c of contents) {
        if (c.type === 'image' && c.data) {
          const filename = `search-result-${Date.now()}.png`;
          writeFileSync(filename, Buffer.from(c.data, 'base64'));
          return `Screenshot saved: ${filename}`;
        }
      }
      return 'No screenshot captured';
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take screenshot to visually verify results',
      schema: z.object({ _unused: z.string().optional() }),
    }
  );

  const getNetworkRequestsTool = tool(
    async (_input: { _unused?: string }) => {
      // 이미 캡처된 요청 반환 + 추가 캡처 시도
      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: GET_CAPTURED_REQUESTS_JS },
      });
      const newRequests = JSON.parse(extractTextFromMcpResult(result));
      return JSON.stringify(newRequests.slice(-10), null, 2); // 최근 10개
    },
    {
      name: 'get_network_requests',
      description: 'Get captured network requests to see API responses',
      schema: z.object({ _unused: z.string().optional() }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserScreenshotTool, getNetworkRequestsTool],
      systemPrompt: CAPTURE_RESULTS_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(`차량번호 "${carNum}" 검색 결과를 분석해주세요.`)] },
      { recursionLimit: 12 }
    );

    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (typeof messages[i].content === 'string' && messages[i].content.trim()) {
        finalResponse = messages[i].content;
        break;
      }
    }

    console.log(`  [captureResults] Agent response: ${finalResponse.slice(0, 300)}...`);

    let status: SearchGraphStateType['status'] = 'UNKNOWN_ERROR';
    let vehicle: VehicleInfo | null = null;
    let resultCount = 0;
    let confidence = 0.5;

    const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      status = parsed.status || 'UNKNOWN_ERROR';
      resultCount = parsed.resultCount || 0;
      confidence = parsed.confidence || 0.7;

      if (parsed.vehicleFound && parsed.vehicle) {
        vehicle = {
          plateNumber: parsed.vehicle.plateNumber || carNum,
          inTime: parsed.vehicle.inTime || '',
          outTime: parsed.vehicle.outTime,
          parkingFee: parsed.vehicle.parkingFee,
        };
      }
    }

    console.log(`  [captureResults] Status: ${status}, Vehicle: ${!!vehicle}, Confidence: ${confidence}`);

    return {
      status,
      vehicle,
      resultCount,
      capturedRequests,
      confidence,
    };
  } catch (e) {
    console.log(`  [captureResults] Error: ${(e as Error).message}`);
    return {
      status: 'UNKNOWN_ERROR',
      errorMessage: (e as Error).message,
      capturedRequests,
    };
  }
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/capture-results.ts
git commit -m "feat(search-graph): add captureResults node with createAgent"
```

---

## Task 12: compareSpec 노드

**Files:**
- Create: `src/agents/search-graph/nodes/compare-spec.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/nodes/compare-spec.ts
import type { SearchGraphStateType, SpecChanges } from '../state.js';
import { getNodeContext } from '../index.js';

export async function compareSpec(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const existingSpec = state.spec;

  console.log('  [compareSpec] Comparing captured data with existing spec...');

  // spec이 없으면 비교 불필요
  if (!existingSpec) {
    console.log('  [compareSpec] No existing spec to compare');
    return {
      specChanges: { hasChanges: false, changeType: null, changes: [], codeWillBreak: false },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }

  const changes: string[] = [];

  // DOM 방식 비교
  if (existingSpec.searchType === 'dom' && existingSpec.form) {
    const captured = state.formElements;
    if (captured.searchInputSelector &&
        captured.searchInputSelector !== existingSpec.form.searchInputSelector) {
      changes.push(`검색 입력 셀렉터 변경: ${existingSpec.form.searchInputSelector} → ${captured.searchInputSelector}`);
    }
    if (captured.searchButtonSelector &&
        captured.searchButtonSelector !== existingSpec.form.searchButtonSelector) {
      changes.push(`검색 버튼 셀렉터 변경: ${existingSpec.form.searchButtonSelector} → ${captured.searchButtonSelector}`);
    }
  }

  // API 방식 비교
  if (existingSpec.searchType === 'api' && existingSpec.api) {
    const capturedApiCalls = state.capturedRequests.filter(r =>
      r.url.includes('search') || r.url.includes('vehicle') || r.url.includes('car')
    );

    for (const call of capturedApiCalls) {
      if (call.url !== existingSpec.api.endpoint) {
        changes.push(`API 엔드포인트 변경: ${existingSpec.api.endpoint} → ${call.url}`);
      }
      if (call.method !== existingSpec.api.method) {
        changes.push(`API 메서드 변경: ${existingSpec.api.method} → ${call.method}`);
      }
    }
  }

  const hasChanges = changes.length > 0;
  const specChanges: SpecChanges = {
    hasChanges,
    changeType: hasChanges ? (existingSpec.searchType === 'api' ? 'api' : 'dom') : null,
    changes,
    codeWillBreak: hasChanges,
  };

  if (hasChanges) {
    console.log(`  [compareSpec] Changes detected: ${changes.join(', ')}`);
  } else {
    console.log('  [compareSpec] No changes detected');
  }

  // 차량 발견 + 변경 없음 → DiscountGraph로 전달 가능
  const readyForDiscount = state.status === 'SUCCESS' && !hasChanges;

  return { specChanges, readyForDiscount };
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/nodes/compare-spec.ts
git commit -m "feat(search-graph): add compareSpec node"
```

---

## Task 13: Routes 모듈

**Files:**
- Create: `src/agents/search-graph/routes.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/routes.ts
import { END } from '@langchain/langgraph';
import type { SearchGraphStateType } from './state.js';

// DOM 분석 후 라우팅
export function routeAfterAnalyze(state: SearchGraphStateType): string {
  if (state.searchMethod === 'dom' || state.searchMethod === 'api') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'screenshotFallback';
}

// 스크린샷 분석 후 라우팅
export function routeAfterScreenshot(state: SearchGraphStateType): string {
  if (state.searchMethod !== 'unknown') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'hintFallback';
}

// Hint 폴백 후 라우팅
export function routeAfterHint(state: SearchGraphStateType): string {
  if (state.searchMethod !== 'unknown') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'specFallback';
}

// Spec 폴백 후 라우팅
export function routeAfterSpecFallback(state: SearchGraphStateType): string {
  // 에러 상태면 종료
  if (state.status !== 'pending') {
    return END;
  }
  return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
}

// API 검색 후 라우팅 (API는 다음 화면 불가하므로 바로 종료)
export function routeAfterApiSearch(state: SearchGraphStateType): string {
  return END;
}

// DOM 검색 후 라우팅
export function routeAfterSearch(state: SearchGraphStateType): string {
  if (state.status !== 'pending') {
    return END;
  }
  return 'captureResults';
}

// 결과 캡처 후 라우팅
export function routeAfterCapture(state: SearchGraphStateType): string {
  // 에러/타임아웃/세션만료면 종료
  if (['TIMEOUT_ERROR', 'SESSION_EXPIRED', 'UNKNOWN_ERROR'].includes(state.status)) {
    return END;
  }
  return 'compareSpec';
}

// Spec 비교 후 라우팅 (항상 종료)
export function routeAfterCompare(state: SearchGraphStateType): string {
  return END;
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/routes.ts
git commit -m "feat(search-graph): add routing functions"
```

---

## Task 14: Graph Builder

**Files:**
- Create: `src/agents/search-graph/graph.ts`

**Step 1: 구현**

```typescript
// src/agents/search-graph/graph.ts
import { END, START, StateGraph } from '@langchain/langgraph';
import { SearchGraphState } from './state.js';
import {
  routeAfterAnalyze,
  routeAfterScreenshot,
  routeAfterHint,
  routeAfterSpecFallback,
  routeAfterApiSearch,
  routeAfterSearch,
  routeAfterCapture,
} from './routes.js';

// Node imports
import { loadSpec } from './nodes/load-spec.js';
import { analyzeSearchMethod } from './nodes/analyze-search-method.js';
import { screenshotFallback } from './nodes/screenshot-fallback.js';
import { hintFallback } from './nodes/hint-fallback.js';
import { specFallback } from './nodes/spec-fallback.js';
import { executeApiSearch } from './nodes/execute-api-search.js';
import { executeSearch } from './nodes/execute-search.js';
import { captureResults } from './nodes/capture-results.js';
import { compareSpec } from './nodes/compare-spec.js';

export function buildSearchGraph() {
  const workflow = new StateGraph(SearchGraphState)
    // Add nodes
    .addNode('loadSpec', loadSpec)
    .addNode('analyzeSearchMethod', analyzeSearchMethod)
    .addNode('screenshotFallback', screenshotFallback)
    .addNode('hintFallback', hintFallback)
    .addNode('specFallback', specFallback)
    .addNode('executeApiSearch', executeApiSearch)
    .addNode('executeSearch', executeSearch)
    .addNode('captureResults', captureResults)
    .addNode('compareSpec', compareSpec)

    // Entry
    .addEdge(START, 'loadSpec')
    .addEdge('loadSpec', 'analyzeSearchMethod')

    // Fallback chain with conditional routing
    .addConditionalEdges('analyzeSearchMethod', routeAfterAnalyze, {
      screenshotFallback: 'screenshotFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })
    .addConditionalEdges('screenshotFallback', routeAfterScreenshot, {
      hintFallback: 'hintFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })
    .addConditionalEdges('hintFallback', routeAfterHint, {
      specFallback: 'specFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })
    .addConditionalEdges('specFallback', routeAfterSpecFallback, {
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
      [END]: END,
    })

    // Search execution paths
    .addConditionalEdges('executeApiSearch', routeAfterApiSearch, {
      [END]: END,
    })
    .addConditionalEdges('executeSearch', routeAfterSearch, {
      captureResults: 'captureResults',
      [END]: END,
    })

    // Results and comparison
    .addConditionalEdges('captureResults', routeAfterCapture, {
      compareSpec: 'compareSpec',
      [END]: END,
    })
    .addEdge('compareSpec', END);

  return workflow.compile();
}
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/graph.ts
git commit -m "feat(search-graph): add StateGraph builder"
```

---

## Task 15: SearchGraph 클래스

**Files:**
- Modify: `src/agents/search-graph/index.ts`

**Step 1: SearchGraph 클래스 추가**

```typescript
// src/agents/search-graph/index.ts 에 추가
import { buildSearchGraph } from './graph.js';
import type { SearchGraphStateType } from './state.js';
import type { SearchResult, SearchSpec } from '../../schemas/index.js';

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
      // Set node context (MCP는 외부에서 전달받음)
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

      const result: SearchResult = {
        status: finalState.status as SearchResult['status'],
        confidence: finalState.confidence,
        details: {
          vehicleFound: !!finalState.vehicle,
          searchMethod: finalState.searchMethod === 'api' ? 'api' : 'dom',
          resultCount: finalState.resultCount,
          errorMessage: finalState.errorMessage || undefined,
        },
        vehicle: finalState.vehicle || undefined,
        changes: finalState.specChanges?.hasChanges ? {
          hasChanges: true,
          codeWillBreak: finalState.specChanges.codeWillBreak,
          breakingChanges: finalState.specChanges.changes,
          summary: finalState.specChanges.changes.join(', '),
        } : undefined,
        timestamp,
      };

      const spec: SearchSpec = {
        systemCode: this.config.systemCode,
        url: this.config.url,
        capturedAt: timestamp,
        searchType: finalState.searchMethod === 'api' ? 'api' : 'dom',
        form: finalState.formElements?.searchInputSelector ? {
          searchInputSelector: finalState.formElements.searchInputSelector,
          searchButtonSelector: finalState.formElements.searchButtonSelector || '',
        } : undefined,
        resultIndicators: {},
        version: 1,
      };

      return {
        result,
        spec,
        readyForDiscount: finalState.readyForDiscount,
      };
    } finally {
      clearNodeContext();
    }
  }
}

export type { SearchGraphStateType } from './state.js';
```

**Step 2: 커밋**

```bash
git add src/agents/search-graph/index.ts
git commit -m "feat(search-graph): add SearchGraph class"
```

---

## Task 16: CLI 및 통합 테스트

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

**Step 1: CLI에 search-graph 명령 추가**

```typescript
// cli.ts에 추가
import { SearchGraph } from './agents/search-graph/index.js';

case 'login-search':
  // LoginGraph → SearchGraph 연동 테스트
  await runLoginThenSearchCommand();
  break;

async function runLoginThenSearchCommand() {
  // 1. LoginGraph 실행
  const loginGraph = new LoginGraph({ ... });
  const { result: loginResult } = await loginGraph.run();

  if (loginResult.status !== 'SUCCESS') {
    console.log('Login failed:', loginResult);
    return;
  }

  // 2. SearchGraph 실행 (MCP 클라이언트 공유)
  const searchGraph = new SearchGraph({
    systemCode: input.systemCode,
    url: input.searchUrl,
    carNum: input.carNum,
    session: loginResult.session!,
    specStore,
    llm: createSearchLLM(),  // 별도 LLM 가능
    mcpClient: loginGraph.getMcpClient(),  // MCP 공유
  });

  const { result, readyForDiscount } = await searchGraph.run();
  console.log('Search result:', result);
  console.log('Ready for discount:', readyForDiscount);
}
```

**Step 2: package.json 스크립트 추가**

```json
"agent:login-search": "tsx src/cli.ts login-search"
```

**Step 3: 커밋**

```bash
git add src/cli.ts package.json
git commit -m "feat(cli): add login-search integration command"
```

---

## Summary

SearchGraph는 LoginGraph와 동일한 **하이브리드 패턴**으로 구현됩니다.

### 노드 구현 방식

| 노드 | 구현 방식 | 이유 |
|------|-----------|------|
| `loadSpec` | 단순 함수 | DB/파일 읽기만 |
| `analyzeSearchMethod` | **createAgent** | DOM 분석, 여러 시도 필요 |
| `screenshotFallback` | **createAgent** | 시각적 분석, 교차 검증 |
| `hintFallback` | 단순 함수 | Spec에서 값 추출만 |
| `specFallback` | 단순 함수 | 기존 Spec 적용만 |
| `executeApiSearch` | 단순 함수 | fetch 호출 |
| `executeSearch` | 단순 함수 | 입력/클릭 실행 |
| `captureResults` | **createAgent** | 결과 분석, 복합 판단 |
| `compareSpec` | 단순 함수 | 비교 로직 |

### createAgent 사용 노드 (3개)

```typescript
// 공통 패턴
const agent = createAgent({
  model: llm,  // SearchGraph 전용 LLM
  tools: [browserSnapshotTool, browserScreenshotTool, ...],
  systemPrompt: TASK_SPECIFIC_PROMPT,
});

const result = await agent.invoke(
  { messages: [new HumanMessage('...')] },
  { recursionLimit: 10 }
);
```

### 핵심 특징
- **MCP 공유**: LoginGraph에서 브라우저 세션 이어받음
- **별도 LLM**: SearchGraph 전용 모델 설정 가능 (멀티에이전트)
- **하이브리드**: 복잡한 분석은 createAgent, 단순 로직은 함수
- **폴백 체인**: DOM → 스크린샷 → Hint → Spec
- **네트워크 캡처**: 검색 API 변경 감지용
- **DiscountGraph 연동**: `readyForDiscount` 플래그

---

**Plan complete. Saved to `docs/plans/2026-01-28-search-graph.md`**

**실행 옵션:**

1. **Subagent-Driven (이 세션)** - Task별 subagent 디스패치, 태스크 간 코드 리뷰

2. **Parallel Session (별도)** - 새 세션에서 executing-plans 스킬로 배치 실행

**어느 방식으로 진행할까요?**