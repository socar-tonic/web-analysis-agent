# Phase 1 MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 휴리스틱 기반 실패 분석 시스템 구축 - 접속 실패 감지 및 Slack 알림

**Architecture:** Alert Receiver가 Slack 웹훅으로 실패 알림 수신 → Analyzer가 Playwright로 사이트 접속 시도 및 상태 캡처 → Heuristic Engine이 규칙 기반 진단 → Action Dispatcher가 Slack 알림 발송

**Tech Stack:** Node.js, TypeScript, pnpm, LangGraph.js, Zod, Playwright, LangSmith (트레이싱)

---

## Architecture Decisions

| 항목 | 결정 | 이유 |
|------|------|------|
| Agent 실행 방식 | **Parallel** | DOM/Network/Policy Agent 병렬 실행 → Orchestrator 결과 종합 |
| LLM Provider | **Claude** (@langchain/anthropic) | 교체 용이하도록 추상화 레이어 적용 |
| LLM 추상화 | **BaseChatModel 인터페이스** | OpenAI, Claude, 로컬 모델 등 쉽게 교체 가능 |

---

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (LangGraph Studio용, 선택)

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/index.ts`

**Step 1: Initialize pnpm project**

Run:
```bash
pnpm init
```

**Step 2: Install dependencies**

Run:
```bash
pnpm add @langchain/langgraph @langchain/core zod playwright dotenv
pnpm add -D typescript @types/node tsx vitest
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create .env.example**

```bash
# LLM (Claude)
ANTHROPIC_API_KEY=

# LangSmith (Observability)
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=web-analysis-agent
LANGSMITH_TRACING=true

# Slack
SLACK_WEBHOOK_URL=
SLACK_SIGNING_SECRET=

# Server
PORT=3000
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.log
```

**Step 6: Update package.json scripts**

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

**Step 7: Create src/index.ts placeholder**

```typescript
console.log('Web Analysis Agent starting...');
```

**Step 8: Verify setup**

Run: `pnpm dev`
Expected: "Web Analysis Agent starting..." 출력

**Step 9: Commit**

```bash
git add -A
git commit -m "chore: initialize project with TypeScript and dependencies"
```

---

## Task 2: Zod Schemas

**Files:**
- Create: `src/schemas/failure-alert.schema.ts`
- Create: `src/schemas/site-analysis.schema.ts`
- Create: `src/schemas/diagnosis.schema.ts`
- Create: `src/schemas/index.ts`
- Create: `src/schemas/__tests__/schemas.test.ts`

**Step 1: Write the failing test**

```typescript
// src/schemas/__tests__/schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  FailureAlertSchema,
  SiteAnalysisSchema,
  DiagnosisSchema,
  DiagnosisType,
} from '../index';

describe('FailureAlertSchema', () => {
  it('should parse valid failure alert', () => {
    const input = {
      vendorId: 'vendor-abc',
      vehicleNumber: '12가3456',
      failedStep: 'login',
      errorMessage: 'timeout',
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should parse minimal failure alert (vendorId only)', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject alert without vendorId', () => {
    const input = {
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('SiteAnalysisSchema', () => {
  it('should parse connection failure', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
      connectionStatus: 'timeout',
    };
    const result = SiteAnalysisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should parse successful connection with http status', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
      connectionStatus: 'success',
      httpStatus: 200,
      networkLogs: [],
      screenshots: [],
    };
    const result = SiteAnalysisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe('DiagnosisSchema', () => {
  it('should parse SERVER_OR_FIREWALL diagnosis', () => {
    const input = {
      vendorId: 'vendor-abc',
      diagnosis: 'SERVER_OR_FIREWALL' as DiagnosisType,
      confidence: 1.0,
      summary: '접속 타임아웃 - 서버 다운 또는 방화벽',
      timestamp: new Date().toISOString(),
    };
    const result = DiagnosisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/schemas/__tests__/schemas.test.ts`
Expected: FAIL - Cannot find module '../index'

**Step 3: Create failure-alert.schema.ts**

```typescript
// src/schemas/failure-alert.schema.ts
import { z } from 'zod';

export const FailedStepSchema = z.enum(['login', 'search', 'apply', 'verify']);
export type FailedStep = z.infer<typeof FailedStepSchema>;

export const FailureAlertSchema = z.object({
  vendorId: z.string().min(1),
  vehicleNumber: z.string().optional(),
  failedStep: FailedStepSchema.optional(),
  errorMessage: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type FailureAlert = z.infer<typeof FailureAlertSchema>;
```

**Step 4: Create site-analysis.schema.ts**

```typescript
// src/schemas/site-analysis.schema.ts
import { z } from 'zod';

export const ConnectionStatusSchema = z.enum(['success', 'timeout', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const NetworkLogSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number(),
  responseType: z.string(),
});
export type NetworkLog = z.infer<typeof NetworkLogSchema>;

export const ScreenshotSchema = z.object({
  step: z.string(),
  base64: z.string(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const DOMSnapshotSchema = z.object({
  loginForm: z.string().optional(),
  searchForm: z.string().optional(),
  applyButton: z.string().optional(),
  resultArea: z.string().optional(),
});
export type DOMSnapshot = z.infer<typeof DOMSnapshotSchema>;

export const SiteAnalysisSchema = z.object({
  vendorId: z.string().min(1),
  timestamp: z.string().datetime(),
  connectionStatus: ConnectionStatusSchema,
  httpStatus: z.number().optional(),
  domSnapshot: DOMSnapshotSchema.optional(),
  networkLogs: z.array(NetworkLogSchema).optional(),
  screenshots: z.array(ScreenshotSchema).optional(),
});

export type SiteAnalysis = z.infer<typeof SiteAnalysisSchema>;
```

**Step 5: Create diagnosis.schema.ts**

```typescript
// src/schemas/diagnosis.schema.ts
import { z } from 'zod';

export const DiagnosisTypeSchema = z.enum([
  'SERVER_OR_FIREWALL',
  'SIGNATURE_CHANGED',
  'INTERNAL_ERROR',
  'DATA_ERROR',
  'UNKNOWN',
]);
export type DiagnosisType = z.infer<typeof DiagnosisTypeSchema>;

export const DiagnosisSchema = z.object({
  vendorId: z.string().min(1),
  diagnosis: DiagnosisTypeSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  details: z.string().optional(),
  suggestedFix: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
```

**Step 6: Create index.ts barrel export**

```typescript
// src/schemas/index.ts
export * from './failure-alert.schema';
export * from './site-analysis.schema';
export * from './diagnosis.schema';
```

**Step 7: Run test to verify it passes**

Run: `pnpm test:run src/schemas/__tests__/schemas.test.ts`
Expected: PASS - All tests pass

**Step 8: Commit**

```bash
git add src/schemas/
git commit -m "feat: add Zod schemas for FailureAlert, SiteAnalysis, Diagnosis"
```

---

## Task 3: Analyzer Component (Playwright)

**Files:**
- Create: `src/analyzer/analyzer.ts`
- Create: `src/analyzer/index.ts`
- Create: `src/analyzer/__tests__/analyzer.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/analyzer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Analyzer } from '../analyzer';
import { SiteAnalysisSchema } from '../../schemas';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

describe('Analyzer', () => {
  let analyzer: Analyzer;

  beforeEach(() => {
    analyzer = new Analyzer();
  });

  describe('analyzeSite', () => {
    it('should return timeout status when page times out', async () => {
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
          close: vi.fn(),
        }),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('timeout');
      expect(result.vendorId).toBe('vendor-abc');
      expect(SiteAnalysisSchema.safeParse(result).success).toBe(true);
    });

    it('should return success status when page loads', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        content: vi.fn().mockResolvedValue('<html></html>'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
        close: vi.fn(),
        on: vi.fn(),
      };
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('success');
      expect(result.httpStatus).toBe(200);
      expect(SiteAnalysisSchema.safeParse(result).success).toBe(true);
    });

    it('should return error status on 5xx response', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 503 }),
        content: vi.fn().mockResolvedValue('<html></html>'),
        close: vi.fn(),
        on: vi.fn(),
      };
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('success');
      expect(result.httpStatus).toBe(503);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/analyzer/__tests__/analyzer.test.ts`
Expected: FAIL - Cannot find module '../analyzer'

**Step 3: Create analyzer.ts**

```typescript
// src/analyzer/analyzer.ts
import { chromium, Browser, Page } from 'playwright';
import { SiteAnalysis, NetworkLog, Screenshot } from '../schemas';

export class Analyzer {
  private timeout = 30000;

  async analyzeSite(vendorId: string, url: string): Promise<SiteAnalysis> {
    const timestamp = new Date().toISOString();
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      const networkLogs: NetworkLog[] = [];
      page.on('response', (response) => {
        networkLogs.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          responseType: response.headers()['content-type'] || 'unknown',
        });
      });

      const response = await page.goto(url, {
        timeout: this.timeout,
        waitUntil: 'domcontentloaded',
      });

      const httpStatus = response?.status() ?? 0;
      const screenshots: Screenshot[] = [];

      try {
        const screenshotBuffer = await page.screenshot();
        screenshots.push({
          step: 'initial',
          base64: screenshotBuffer.toString('base64'),
        });
      } catch {
        // Screenshot failed, continue without it
      }

      await page.close();

      return {
        vendorId,
        timestamp,
        connectionStatus: 'success',
        httpStatus,
        networkLogs,
        screenshots,
      };
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.message.includes('timeout') || error.message.includes('Timeout'));

      return {
        vendorId,
        timestamp,
        connectionStatus: isTimeout ? 'timeout' : 'error',
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/analyzer/index.ts
export * from './analyzer';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/analyzer/__tests__/analyzer.test.ts`
Expected: PASS - All tests pass

**Step 6: Commit**

```bash
git add src/analyzer/
git commit -m "feat: add Analyzer component with Playwright site analysis"
```

---

## Task 4: Heuristic Engine (Rule-based Diagnosis)

**Files:**
- Create: `src/engine/heuristic-engine.ts`
- Create: `src/engine/index.ts`
- Create: `src/engine/__tests__/heuristic-engine.test.ts`

**Step 1: Write the failing test**

```typescript
// src/engine/__tests__/heuristic-engine.test.ts
import { describe, it, expect } from 'vitest';
import { HeuristicEngine } from '../heuristic-engine';
import { SiteAnalysis } from '../../schemas';

describe('HeuristicEngine', () => {
  const engine = new HeuristicEngine();

  describe('diagnose', () => {
    it('should return SERVER_OR_FIREWALL for timeout', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'timeout',
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.confidence).toBe(1.0);
      expect(result.summary).toContain('타임아웃');
    });

    it('should return SERVER_OR_FIREWALL for connection error', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'error',
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.confidence).toBe(1.0);
    });

    it('should return SERVER_OR_FIREWALL for 5xx status', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'success',
        httpStatus: 503,
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.summary).toContain('503');
    });

    it('should return UNKNOWN for successful connection without issues', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'success',
        httpStatus: 200,
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('UNKNOWN');
      expect(result.summary).toContain('LLM 분석 필요');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/engine/__tests__/heuristic-engine.test.ts`
Expected: FAIL - Cannot find module '../heuristic-engine'

**Step 3: Create heuristic-engine.ts**

```typescript
// src/engine/heuristic-engine.ts
import { SiteAnalysis, Diagnosis, DiagnosisType } from '../schemas';

export class HeuristicEngine {
  diagnose(analysis: SiteAnalysis): Diagnosis {
    const { vendorId, connectionStatus, httpStatus } = analysis;
    const timestamp = new Date().toISOString();

    // Rule 1: Connection timeout
    if (connectionStatus === 'timeout') {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 타임아웃 - 서버 다운 또는 방화벽 추정',
        timestamp,
      };
    }

    // Rule 2: Connection error
    if (connectionStatus === 'error') {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 실패 - 서버 다운 또는 방화벽 추정',
        timestamp,
      };
    }

    // Rule 3: 5xx server error
    if (httpStatus && httpStatus >= 500) {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 0.9,
        summary: `서버 에러 (HTTP ${httpStatus}) - 서버 장애 추정`,
        timestamp,
      };
    }

    // Rule 4: 4xx client error (potential signature change)
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return {
        vendorId,
        diagnosis: 'UNKNOWN',
        confidence: 0.5,
        summary: `클라이언트 에러 (HTTP ${httpStatus}) - LLM 분석 필요`,
        timestamp,
      };
    }

    // Default: Needs LLM analysis (Phase 2)
    return {
      vendorId,
      diagnosis: 'UNKNOWN',
      confidence: 0.3,
      summary: '접속 성공, 상세 분석 필요 - LLM 분석 필요 (Phase 2)',
      timestamp,
    };
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/engine/index.ts
export * from './heuristic-engine';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/engine/__tests__/heuristic-engine.test.ts`
Expected: PASS - All tests pass

**Step 6: Commit**

```bash
git add src/engine/
git commit -m "feat: add HeuristicEngine for rule-based diagnosis"
```

---

## Task 5: Action Dispatcher (Slack Notification)

**Files:**
- Create: `src/dispatcher/slack-dispatcher.ts`
- Create: `src/dispatcher/index.ts`
- Create: `src/dispatcher/__tests__/slack-dispatcher.test.ts`

**Step 1: Write the failing test**

```typescript
// src/dispatcher/__tests__/slack-dispatcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackDispatcher } from '../slack-dispatcher';
import { Diagnosis } from '../../schemas';

// Mock fetch
global.fetch = vi.fn();

describe('SlackDispatcher', () => {
  let dispatcher: SlackDispatcher;

  beforeEach(() => {
    vi.resetAllMocks();
    dispatcher = new SlackDispatcher('https://hooks.slack.com/test');
  });

  describe('sendDiagnosis', () => {
    it('should send SERVER_OR_FIREWALL notification', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 타임아웃 - 서버 다운 또는 방화벽',
        timestamp: new Date().toISOString(),
      };

      await dispatcher.sendDiagnosis(diagnosis);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/test');

      const body = JSON.parse(options?.body as string);
      expect(body.text).toContain('vendor-abc');
      expect(body.text).toContain('서버/방화벽');
    });

    it('should send UNKNOWN notification', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'UNKNOWN',
        confidence: 0.3,
        summary: '접속 성공, 상세 분석 필요',
        timestamp: new Date().toISOString(),
      };

      await dispatcher.sendDiagnosis(diagnosis);

      const [, options] = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(options?.body as string);
      expect(body.text).toContain('수동 확인 필요');
    });

    it('should throw on failed request', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: 'test',
        timestamp: new Date().toISOString(),
      };

      await expect(dispatcher.sendDiagnosis(diagnosis)).rejects.toThrow('Slack');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/dispatcher/__tests__/slack-dispatcher.test.ts`
Expected: FAIL - Cannot find module '../slack-dispatcher'

**Step 3: Create slack-dispatcher.ts**

```typescript
// src/dispatcher/slack-dispatcher.ts
import { Diagnosis, DiagnosisType } from '../schemas';

const EMOJI_MAP: Record<DiagnosisType, string> = {
  SERVER_OR_FIREWALL: ':rotating_light:',
  SIGNATURE_CHANGED: ':warning:',
  INTERNAL_ERROR: ':x:',
  DATA_ERROR: ':question:',
  UNKNOWN: ':mag:',
};

const LABEL_MAP: Record<DiagnosisType, string> = {
  SERVER_OR_FIREWALL: '서버/방화벽 문제',
  SIGNATURE_CHANGED: 'UI/API 시그니처 변경',
  INTERNAL_ERROR: '내부 오류',
  DATA_ERROR: '데이터 오류',
  UNKNOWN: '수동 확인 필요',
};

export class SlackDispatcher {
  constructor(private webhookUrl: string) {}

  async sendDiagnosis(diagnosis: Diagnosis): Promise<void> {
    const emoji = EMOJI_MAP[diagnosis.diagnosis];
    const label = LABEL_MAP[diagnosis.diagnosis];

    const message = {
      text: `${emoji} *[${diagnosis.vendorId}]* ${label}\n> ${diagnosis.summary}\n_신뢰도: ${Math.round(diagnosis.confidence * 100)}%_`,
    };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/dispatcher/index.ts
export * from './slack-dispatcher';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/dispatcher/__tests__/slack-dispatcher.test.ts`
Expected: PASS - All tests pass

**Step 6: Commit**

```bash
git add src/dispatcher/
git commit -m "feat: add SlackDispatcher for sending diagnosis notifications"
```

---

## Task 6: LangGraph Workflow

**Files:**
- Create: `src/graph/state.ts`
- Create: `src/graph/nodes.ts`
- Create: `src/graph/workflow.ts`
- Create: `src/graph/index.ts`
- Create: `src/graph/__tests__/workflow.test.ts`

**Note:** LangGraph.js 구현 시 `use context7`로 최신 문서 참조

**Step 1: Write the failing test**

```typescript
// src/graph/__tests__/workflow.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkflow } from '../workflow';
import { AgentState } from '../state';

// Mock dependencies
vi.mock('../../analyzer', () => ({
  Analyzer: vi.fn().mockImplementation(() => ({
    analyzeSite: vi.fn().mockResolvedValue({
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
      connectionStatus: 'timeout',
    }),
  })),
}));

vi.mock('../../dispatcher', () => ({
  SlackDispatcher: vi.fn().mockImplementation(() => ({
    sendDiagnosis: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process SERVER_OR_FIREWALL diagnosis', async () => {
    const workflow = createWorkflow({
      slackWebhookUrl: 'https://hooks.slack.com/test',
    });

    const initialState: Partial<AgentState> = {
      vendorId: 'vendor-abc',
      vendorUrl: 'https://example.com',
    };

    const result = await workflow.invoke(initialState);

    expect(result.diagnosis?.diagnosis).toBe('SERVER_OR_FIREWALL');
    expect(result.notificationSent).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/graph/__tests__/workflow.test.ts`
Expected: FAIL - Cannot find module '../workflow'

**Step 3: Create state.ts**

```typescript
// src/graph/state.ts
import { SiteAnalysis, Diagnosis } from '../schemas';

export interface AgentState {
  // Input
  vendorId: string;
  vendorUrl: string;

  // Analysis results
  siteAnalysis?: SiteAnalysis;
  diagnosis?: Diagnosis;

  // Output
  notificationSent?: boolean;
  error?: string;
}
```

**Step 4: Create nodes.ts**

```typescript
// src/graph/nodes.ts
import { AgentState } from './state';
import { Analyzer } from '../analyzer';
import { HeuristicEngine } from '../engine';
import { SlackDispatcher } from '../dispatcher';

export function createNodes(config: { slackWebhookUrl: string }) {
  const analyzer = new Analyzer();
  const engine = new HeuristicEngine();
  const dispatcher = new SlackDispatcher(config.slackWebhookUrl);

  return {
    async analyze(state: AgentState): Promise<Partial<AgentState>> {
      try {
        const siteAnalysis = await analyzer.analyzeSite(
          state.vendorId,
          state.vendorUrl
        );
        return { siteAnalysis };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Analysis failed',
        };
      }
    },

    async diagnose(state: AgentState): Promise<Partial<AgentState>> {
      if (!state.siteAnalysis) {
        return { error: 'No site analysis available' };
      }
      const diagnosis = engine.diagnose(state.siteAnalysis);
      return { diagnosis };
    },

    async notify(state: AgentState): Promise<Partial<AgentState>> {
      if (!state.diagnosis) {
        return { error: 'No diagnosis available' };
      }
      try {
        await dispatcher.sendDiagnosis(state.diagnosis);
        return { notificationSent: true };
      } catch (error) {
        return {
          notificationSent: false,
          error: error instanceof Error ? error.message : 'Notification failed',
        };
      }
    },
  };
}
```

**Step 5: Create workflow.ts**

```typescript
// src/graph/workflow.ts
import { StateGraph, END } from '@langchain/langgraph';
import { AgentState } from './state';
import { createNodes } from './nodes';

export function createWorkflow(config: { slackWebhookUrl: string }) {
  const nodes = createNodes(config);

  const workflow = new StateGraph<AgentState>({
    channels: {
      vendorId: { value: (x: string, y?: string) => y ?? x, default: () => '' },
      vendorUrl: { value: (x: string, y?: string) => y ?? x, default: () => '' },
      siteAnalysis: { value: (x, y) => y ?? x, default: () => undefined },
      diagnosis: { value: (x, y) => y ?? x, default: () => undefined },
      notificationSent: { value: (x, y) => y ?? x, default: () => undefined },
      error: { value: (x, y) => y ?? x, default: () => undefined },
    },
  })
    .addNode('analyze', nodes.analyze)
    .addNode('diagnose', nodes.diagnose)
    .addNode('notify', nodes.notify)
    .addEdge('__start__', 'analyze')
    .addEdge('analyze', 'diagnose')
    .addEdge('diagnose', 'notify')
    .addEdge('notify', '__end__');

  return workflow.compile();
}
```

**Step 6: Create index.ts**

```typescript
// src/graph/index.ts
export * from './state';
export * from './nodes';
export * from './workflow';
```

**Step 7: Run test to verify it passes**

Run: `pnpm test:run src/graph/__tests__/workflow.test.ts`
Expected: PASS - All tests pass

**Step 8: Commit**

```bash
git add src/graph/
git commit -m "feat: add LangGraph workflow for analysis pipeline"
```

---

## Task 7: Alert Receiver (HTTP Server)

**Files:**
- Create: `src/alert-receiver/server.ts`
- Create: `src/alert-receiver/index.ts`
- Create: `src/alert-receiver/__tests__/server.test.ts`
- Modify: `src/index.ts`

**Step 1: Install http server dependency**

Run:
```bash
pnpm add express
pnpm add -D @types/express supertest @types/supertest
```

**Step 2: Write the failing test**

```typescript
// src/alert-receiver/__tests__/server.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../server';

// Mock workflow
vi.mock('../../graph', () => ({
  createWorkflow: vi.fn().mockReturnValue({
    invoke: vi.fn().mockResolvedValue({
      diagnosis: { diagnosis: 'SERVER_OR_FIREWALL' },
      notificationSent: true,
    }),
  }),
}));

describe('Alert Receiver Server', () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    app = createServer({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      vendorUrlMap: {
        'vendor-abc': 'https://vendor-abc.example.com',
      },
    });
  });

  describe('POST /webhook/alert', () => {
    it('should process valid failure alert', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({
          vendorId: 'vendor-abc',
          timestamp: new Date().toISOString(),
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.diagnosis).toBe('SERVER_OR_FIREWALL');
    });

    it('should reject alert without vendorId', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({
          timestamp: new Date().toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('vendorId');
    });

    it('should reject unknown vendor', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({
          vendorId: 'unknown-vendor',
          timestamp: new Date().toISOString(),
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Unknown vendor');
    });
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm test:run src/alert-receiver/__tests__/server.test.ts`
Expected: FAIL - Cannot find module '../server'

**Step 4: Create server.ts**

```typescript
// src/alert-receiver/server.ts
import express, { Request, Response } from 'express';
import { FailureAlertSchema } from '../schemas';
import { createWorkflow } from '../graph';

interface ServerConfig {
  slackWebhookUrl: string;
  vendorUrlMap: Record<string, string>;
}

export function createServer(config: ServerConfig) {
  const app = express();
  app.use(express.json());

  const workflow = createWorkflow({
    slackWebhookUrl: config.slackWebhookUrl,
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.post('/webhook/alert', async (req: Request, res: Response) => {
    try {
      // Validate input
      const parseResult = FailureAlertSchema.safeParse({
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString(),
      });

      if (!parseResult.success) {
        res.status(400).json({
          error: `Invalid alert: ${parseResult.error.errors.map((e) => e.message).join(', ')}`,
        });
        return;
      }

      const alert = parseResult.data;

      // Get vendor URL
      const vendorUrl = config.vendorUrlMap[alert.vendorId];
      if (!vendorUrl) {
        res.status(404).json({
          error: `Unknown vendor: ${alert.vendorId}`,
        });
        return;
      }

      // Run workflow
      const result = await workflow.invoke({
        vendorId: alert.vendorId,
        vendorUrl,
      });

      res.json({
        success: true,
        vendorId: alert.vendorId,
        diagnosis: result.diagnosis?.diagnosis,
        notificationSent: result.notificationSent,
      });
    } catch (error) {
      console.error('Alert processing error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  return app;
}
```

**Step 5: Create index.ts**

```typescript
// src/alert-receiver/index.ts
export * from './server';
```

**Step 6: Run test to verify it passes**

Run: `pnpm test:run src/alert-receiver/__tests__/server.test.ts`
Expected: PASS - All tests pass

**Step 7: Update main index.ts**

```typescript
// src/index.ts
import 'dotenv/config';
import { createServer } from './alert-receiver';

const PORT = process.env.PORT || 3000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SLACK_WEBHOOK_URL) {
  console.error('SLACK_WEBHOOK_URL is required');
  process.exit(1);
}

// TODO: Load from config or database
const VENDOR_URL_MAP: Record<string, string> = {
  'vendor-sample': 'https://example.com',
};

const app = createServer({
  slackWebhookUrl: SLACK_WEBHOOK_URL,
  vendorUrlMap: VENDOR_URL_MAP,
});

app.listen(PORT, () => {
  console.log(`Web Analysis Agent running on port ${PORT}`);
});
```

**Step 8: Commit**

```bash
git add src/alert-receiver/ src/index.ts pnpm-lock.yaml package.json
git commit -m "feat: add Alert Receiver HTTP server with webhook endpoint"
```

---

## Task 8: LangSmith Integration

**Files:**
- Modify: `src/graph/workflow.ts`
- Create: `src/config/langsmith.ts`

**Step 1: Create langsmith.ts**

```typescript
// src/config/langsmith.ts
export function configureLangSmith() {
  // LangSmith는 환경 변수만으로 자동 활성화됨
  // LANGSMITH_API_KEY, LANGSMITH_PROJECT, LANGSMITH_TRACING=true
  const isEnabled = process.env.LANGSMITH_TRACING === 'true';

  if (isEnabled) {
    console.log(`LangSmith tracing enabled for project: ${process.env.LANGSMITH_PROJECT}`);
  }

  return { isEnabled };
}
```

**Step 2: Update src/index.ts to configure LangSmith**

```typescript
// src/index.ts
import 'dotenv/config';
import { createServer } from './alert-receiver';
import { configureLangSmith } from './config/langsmith';

// Configure LangSmith first
configureLangSmith();

const PORT = process.env.PORT || 3000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SLACK_WEBHOOK_URL) {
  console.error('SLACK_WEBHOOK_URL is required');
  process.exit(1);
}

const VENDOR_URL_MAP: Record<string, string> = {
  'vendor-sample': 'https://example.com',
};

const app = createServer({
  slackWebhookUrl: SLACK_WEBHOOK_URL,
  vendorUrlMap: VENDOR_URL_MAP,
});

app.listen(PORT, () => {
  console.log(`Web Analysis Agent running on port ${PORT}`);
});
```

**Step 3: Create config index**

```typescript
// src/config/index.ts
export * from './langsmith';
```

**Step 4: Commit**

```bash
git add src/config/ src/index.ts
git commit -m "feat: add LangSmith configuration for observability"
```

---

## Task 9: LangGraph Studio Configuration (Optional)

**Files:**
- Create: `langgraph.json`

**Step 1: Create langgraph.json**

```json
{
  "$schema": "https://langchain-ai.github.io/langgraph/schemas/langgraph.json",
  "node_version": "20",
  "dockerfile_lines": [],
  "graphs": {
    "agent": "./src/graph/workflow.ts:createWorkflow"
  },
  "env": ".env"
}
```

**Step 2: Commit**

```bash
git add langgraph.json
git commit -m "chore: add LangGraph Studio configuration"
```

---

## Task 10: Integration Test & Documentation

**Files:**
- Create: `src/__tests__/integration.test.ts`
- Update: `README.md` (optional)

**Step 1: Write integration test**

```typescript
// src/__tests__/integration.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer } from '../alert-receiver';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
        close: vi.fn(),
        on: vi.fn(),
      }),
      close: vi.fn(),
    }),
  },
}));

// Mock fetch for Slack
global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

describe('Integration: Full Analysis Flow', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      vendorUrlMap: {
        'vendor-test': 'https://test.example.com',
      },
    });
  });

  it('should complete full flow: alert → analyze → diagnose → notify', async () => {
    const response = await request(app)
      .post('/webhook/alert')
      .send({
        vendorId: 'vendor-test',
        errorMessage: 'Connection failed',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      vendorId: 'vendor-test',
      diagnosis: 'SERVER_OR_FIREWALL',
      notificationSent: true,
    });

    // Verify Slack was called
    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });
});
```

**Step 2: Run integration test**

Run: `pnpm test:run src/__tests__/integration.test.ts`
Expected: PASS

**Step 3: Run all tests**

Run: `pnpm test:run`
Expected: All tests pass

**Step 4: Final commit**

```bash
git add src/__tests__/
git commit -m "test: add integration test for full analysis flow"
```

---

## Summary

Phase 1 MVP 구현 완료 시 다음 기능이 동작:

1. **Alert Receiver**: `POST /webhook/alert`로 실패 알림 수신
2. **Analyzer**: Playwright로 장비사 사이트 접속 시도
3. **Heuristic Engine**: 규칙 기반 진단 (접속 실패 → `SERVER_OR_FIREWALL`)
4. **Action Dispatcher**: Slack 웹훅으로 진단 결과 알림
5. **LangSmith**: 트레이싱 활성화 (환경 변수 설정 시)

### 테스트 명령어

```bash
pnpm test:run                    # 전체 테스트
pnpm test:run src/schemas        # 스키마 테스트만
pnpm test:run src/analyzer       # Analyzer 테스트만
pnpm dev                         # 개발 서버 실행
```

### 다음 단계 (Phase 2)

- [ ] LLM 연동 (DOM/Network Agent)
- [ ] Spec 저장소 구축
- [ ] GitHub PR 자동 생성
