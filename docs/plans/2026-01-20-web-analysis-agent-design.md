# Web Analysis Agent 설계 문서

> 주차 할인권 적용 배치의 실패 분석을 자동화하는 AI 에이전트

## 배경 및 문제

### 현재 상황
- **50개** 외부 주차 장비사 웹사이트와 연동
- Puppeteer/Axios 기반 배치로 할인권 적용
- 템플릿 메소드 패턴: `로그인 → 차량 검색 → 할인권 적용 → 적용 확인`
- 장비사마다 UI 기반(Puppeteer) 또는 API 기반(Axios) 혼재

### 문제점
- 실패 원인이 다양함:
  - **장비사 로컬 서버 다운 혹은 방화벽 이슈** - 접속 자체가 안 됨
  - **UI/API 시그니처 변경** - 셀렉터, 엔드포인트, 요청/응답 포맷 변경
  - 내부 로직 오류 (DB 할인키 설정 등)
  - 차량번호 오인식
- 현재는 슬랙 알림만 받고 대부분 디버깅 안 함
- 알림에 분석을 위한 정보 부족 (장비사 ID, 차량번호, 실패 단계, 에러 메시지가 불규칙하게 존재)

### 목표 우선순위
1. **실패 분석** (MVP) - 할인권 적용 실패 시 원인 자동 파악
2. 변경 감지 - UI/API 변경 탐지
3. 신규 연동 자동화 - 새 장비사 분석 → JSON → 코드 생성
4. 기존 코드 구조화 - 50개 배치 코드를 JSON spec으로 관리

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        배치 서버 (기존)                           │
│  Puppeteer/Axios 기반 할인권 적용                                 │
│  실패 시 → warning 로그 + 슬랙 알림                               │
└─────────────────────┬───────────────────────────────────────────┘
                      │ 웹훅 or 로그 스트림
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                   분석 에이전트 서버 (신규)                        │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Alert     │→ │ Analyzer  │→ │ AI Engine │→ │ Action       │  │
│  │ Receiver  │  │ (Playwright)│ │ (LLM)     │  │ Dispatcher   │  │
│  └───────────┘  └───────────┘  └───────────┘  └──────────────┘  │
│                                                      │          │
│  ┌───────────────────────────────────────────────────┘          │
│  │                                                              │
│  ▼                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Slack 리포트 │  │ GitHub PR   │  │ Spec 저장소  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 기술 스택
- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright (headless)
- **LLM**: TBD (OpenAI, Claude, 또는 로컬 모델)
- **GitHub 연동**: GitHub MCP (Draft PR 생성)
- **Storage**: TBD (파일 시스템, DB, 또는 S3)

---

## 핵심 컴포넌트

### 1. Alert Receiver
슬랙 웹훅 또는 로그 모니터링으로 실패 이벤트 수신

**입력 (현재 알림에서 추출 가능한 정보):**
```typescript
interface FailureAlert {
  vendorId?: string;      // 장비사 식별자
  vehicleNumber?: string; // 차량번호
  failedStep?: 'login' | 'search' | 'apply' | 'verify';
  errorMessage?: string;
  timestamp: Date;
}
```

**책임:**
- 슬랙 이벤트 파싱 또는 로그 스트림 모니터링
- 최소한 `vendorId` 추출 (없으면 분석 불가)
- Analyzer에 분석 요청 전달

### 2. Analyzer (Playwright 기반)
해당 장비사 사이트 방문하여 현재 상태 캡처

**수집 데이터:**
```typescript
interface SiteAnalysis {
  vendorId: string;
  timestamp: Date;

  // 접속 상태
  connectionStatus: 'success' | 'timeout' | 'error';
  httpStatus?: number;

  // DOM 분석
  domSnapshot: {
    loginForm?: DOMElement;
    searchForm?: DOMElement;
    applyButton?: DOMElement;
    resultArea?: DOMElement;
  };

  // 네트워크 분석
  networkLogs: {
    url: string;
    method: string;
    status: number;
    responseType: string;
  }[];

  // 스크린샷
  screenshots: {
    step: string;
    base64: string;
  }[];
}
```

**책임:**
- Headless 브라우저로 사이트 접속
- DOM 구조 캡처 (주요 요소 셀렉터)
- Fetch/XHR 네트워크 요청 인터셉트
- 각 단계별 스크린샷 저장

### 3. AI Engine (멀티 에이전트 구조)

**아키텍처: Orchestrator + 3개 전문 에이전트**

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
│                                                             │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│   │ DOM Agent   │ │ Network     │ │ Policy      │          │
│   │             │ │ Agent       │ │ Agent       │          │
│   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘          │
│          │               │               │                  │
│          └───────────────┴───────────────┘                  │
│                          │                                  │
│                    종합 진단                                 │
└─────────────────────────────────────────────────────────────┘
```

**Phase 1: 규칙 기반 즉시 판정 (LLM 불필요)**
```typescript
// 접속 실패는 LLM 없이 즉시 판정
function checkConnectionFailure(analysis: SiteAnalysis): Diagnosis | null {
  if (analysis.connectionStatus === 'timeout') {
    return { diagnosis: 'SERVER_OR_FIREWALL', message: '접속 타임아웃 - 서버 다운 또는 방화벽' };
  }
  if (analysis.connectionStatus === 'error') {
    return { diagnosis: 'SERVER_OR_FIREWALL', message: '접속 실패 - 서버 다운 또는 방화벽' };
  }
  if (analysis.httpStatus && analysis.httpStatus >= 500) {
    return { diagnosis: 'SERVER_OR_FIREWALL', message: `서버 에러 (${analysis.httpStatus})` };
  }
  return null; // 접속 성공 → Phase 2로 (멀티 에이전트 분석)
}
```

**Phase 2: 멀티 에이전트 병렬 분석 (접속 성공 시)**

```typescript
interface AgentResult {
  agent: 'dom' | 'network' | 'policy';
  hasIssue: boolean;
  diagnosis?: Diagnosis;
  details?: string;
  suggestedFix?: string;
}

// 3개 에이전트 병렬 실행
async function analyzeWithAgents(
  analysis: SiteAnalysis,
  spec: VendorSpec,
  internalConfig: InternalConfig
): Promise<AgentResult[]> {
  const results = await Promise.all([
    domAgent.analyze(analysis.domSnapshot, spec),
    networkAgent.analyze(analysis.networkLogs, spec),
    policyAgent.analyze(internalConfig, spec)
  ]);
  return results;
}
```

**3-1. DOM Agent**
```typescript
// 역할: UI 셀렉터 변경 감지
const domAgent = {
  async analyze(domSnapshot: DOMSnapshot, spec: VendorSpec): Promise<AgentResult> {
    // LLM 프롬프트
    const prompt = `
      기대 셀렉터: ${JSON.stringify(spec.steps)}
      실제 DOM: ${JSON.stringify(domSnapshot)}

      다음을 분석하세요:
      1. 로그인 폼 셀렉터가 변경되었는가?
      2. 검색 폼 셀렉터가 변경되었는가?
      3. 버튼/입력필드 위치가 변경되었는가?

      변경된 경우 새 셀렉터를 제안하세요.
    `;
    // ...
  }
};
```

**3-2. Network Agent**
```typescript
// 역할: API 엔드포인트/포맷 변경 감지
const networkAgent = {
  async analyze(networkLogs: NetworkLog[], spec: VendorSpec): Promise<AgentResult> {
    // LLM 프롬프트
    const prompt = `
      기대 API: ${JSON.stringify(spec.api)}
      실제 네트워크 로그: ${JSON.stringify(networkLogs)}

      다음을 분석하세요:
      1. API 엔드포인트가 변경되었는가?
      2. 요청/응답 포맷이 변경되었는가?
      3. 인증 방식이 변경되었는가?

      변경된 경우 새 API 스펙을 제안하세요.
    `;
    // ...
  }
};
```

**3-3. Policy Agent**
```typescript
// 역할: 내부 연동 정보 검증
const policyAgent = {
  async analyze(config: InternalConfig, spec: VendorSpec): Promise<AgentResult> {
    // LLM 프롬프트
    const prompt = `
      장비사: ${spec.name}
      DB 설정: ${JSON.stringify(config.discountKeys)}
      연동 정보: ${JSON.stringify(config.credentials)}

      다음을 검증하세요:
      1. 할인키가 올바르게 설정되어 있는가?
      2. 연동 계정 정보가 유효한가?
      3. 차량번호 포맷이 올바른가?

      문제가 있으면 수정 방안을 제안하세요.
    `;
    // ...
  }
};
```

**Phase 3: 결과 종합**
```typescript
function aggregateResults(results: AgentResult[]): FinalDiagnosis {
  const domResult = results.find(r => r.agent === 'dom');
  const networkResult = results.find(r => r.agent === 'network');
  const policyResult = results.find(r => r.agent === 'policy');

  // 우선순위: Policy (내부 문제) > DOM/Network (외부 변경)
  if (policyResult?.hasIssue) {
    return { diagnosis: 'INTERNAL_ERROR', source: 'policy', ... };
  }
  if (domResult?.hasIssue || networkResult?.hasIssue) {
    return { diagnosis: 'SIGNATURE_CHANGED', source: domResult?.hasIssue ? 'dom' : 'network', ... };
  }
  return { diagnosis: 'UNKNOWN', ... };
}
```

**출력:**
```typescript
interface AnalysisResult {
  vendorId: string;
  diagnosis:
    | 'SERVER_OR_FIREWALL'   // 장비사 로컬 서버 다운 혹은 방화벽 이슈
    | 'SIGNATURE_CHANGED'    // UI/API 시그니처 변경
    | 'INTERNAL_ERROR'       // 내부 로직 오류 (DB 할인키 설정 등)
    | 'DATA_ERROR'           // 차량번호 오인식 등 데이터 문제
    | 'UNKNOWN';
  confidence: number;  // 0-1
  summary: string;     // 사람이 읽을 수 있는 요약
  details: {
    changedElements?: { selector: string; before?: string; after?: string }[];
    suggestedFix?: string;
    relatedCode?: { file: string; line: number }[];
  };
  canAutoFix: boolean; // PR 자동 생성 가능 여부 (SIGNATURE_CHANGED인 경우만 true)
}
```

### 4. Action Dispatcher
분석 결과에 따라 적절한 액션 수행

**액션 분기:**
```
분석 결과
    │
    ├─ SIGNATURE_CHANGED (UI/API 시그니처 변경)
    │   ├─ 기존 배치 코드 조회 (batchCodeRef 참조)
    │   ├─ 변경점 diff 생성
    │   ├─ 수정 코드 생성
    │   ├─ GitHub MCP로 Draft PR 생성
    │   └─ 슬랙: "@운영팀 시그니처 변경 감지, Draft PR: [링크]"
    │
    ├─ SERVER_OR_FIREWALL (서버 다운/방화벽)
    │   └─ 슬랙: "@운영팀 장비사 서버 접속 불가: [장비사명]"
    │
    ├─ INTERNAL_ERROR / DATA_ERROR
    │   └─ 슬랙: "@운영팀 내부 확인 필요: [상세 내용]"
    │
    └─ UNKNOWN
        └─ 슬랙: "@운영팀 분석 실패, 수동 확인 필요: [로그]"
```

**SIGNATURE_CHANGED 시 Draft PR 생성 흐름:**
```typescript
interface PullRequestPayload {
  repo: string;                    // 배치 레포 (e.g., "company/parking-batch")
  branch: string;                  // 새 브랜치 (e.g., "fix/vendor-abc-selector-update")
  title: string;                   // PR 제목
  body: string;                    // 변경 사항 설명 (before/after diff 포함)
  files: {
    path: string;                  // 수정 파일 경로
    content: string;               // 수정된 코드
  }[];
  draft: true;                     // Draft PR로 생성
  validated: boolean;              // 테스트 차량으로 검증 완료 여부
}

// GitHub MCP를 통한 Draft PR 생성
async function createDraftPR(analysis: AnalysisResult, spec: VendorSpec): Promise<string> {
  // 1. 기존 배치 코드 조회
  const currentCode = await githubMcp.getFileContent(spec.batchCodeRef.repo, spec.batchCodeRef.file);

  // 2. LLM이 제안한 수정 사항 적용
  const updatedCode = applyFix(currentCode, analysis.details.suggestedFix);

  // 3. 테스트 차량으로 검증 (제공된 경우)
  let validationResult: ValidationResult | null = null;
  if (analysis.testVehicle) {
    validationResult = await validateWithTestVehicle(
      spec,
      updatedCode,
      analysis.testVehicle
    );
  }

  // 4. Draft PR 생성
  const prUrl = await githubMcp.createPullRequest({
    repo: spec.batchCodeRef.repo,
    branch: `fix/${spec.vendorId}-signature-update`,
    title: `fix(${spec.vendorId}): UI/API 시그니처 변경 대응`,
    body: generatePRBody(analysis, validationResult),
    files: [{ path: spec.batchCodeRef.file, content: updatedCode }],
    draft: true
  });

  return prUrl;
}
```

### 테스트 차량 검증 (Validation)

운영팀이 테스트 차량번호를 제공하면 실제로 수정된 로직을 실행하여 검증:

```typescript
interface TestVehicleConfig {
  vehicleNumber: string;          // 테스트 차량번호
  allowActualDiscount: boolean;   // 실제 할인 적용 허용 여부
  skipApplyStep?: boolean;        // 적용 단계 스킵 (검색까지만 테스트)
}

interface ValidationResult {
  success: boolean;
  stepsCompleted: {
    login: boolean;
    search: boolean;
    apply: boolean;
    verify: boolean;
  };
  failedAt?: 'login' | 'search' | 'apply' | 'verify';
  error?: string;
  screenshots: {
    step: string;
    base64: string;
  }[];
  executionTime: number;
}

async function validateWithTestVehicle(
  spec: VendorSpec,
  updatedCode: string,
  testConfig: TestVehicleConfig
): Promise<ValidationResult> {
  // 1. 수정된 코드로 임시 실행 환경 구성
  const executor = createTempExecutor(updatedCode);

  // 2. Playwright MCP로 전체 플로우 실행
  const result = await executor.run({
    vendorId: spec.vendorId,
    vehicleNumber: testConfig.vehicleNumber,
    steps: testConfig.skipApplyStep
      ? ['login', 'search']
      : ['login', 'search', 'apply', 'verify'],
    captureScreenshots: true
  });

  return result;
}
```

**검증 결과에 따른 분기:**

```
┌─────────────────────────────────────────────────────────────┐
│                    테스트 차량 검증                          │
│                                                             │
│   테스트 차량: "12가3456"                                    │
│                                                             │
│   실행: 로그인 → 검색 → 할인적용 → 확인                       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ✅ 전체 성공                                               │
│      └─ PR 본문에 "✅ 테스트 차량 검증 완료" 태그            │
│      └─ 스크린샷 첨부                                        │
│      └─ 운영팀 리뷰 → 빠른 머지 가능                         │
│                                                             │
│   ⚠️ 부분 성공 (예: 검색까지만 성공)                         │
│      └─ PR 본문에 "⚠️ 부분 검증 (로그인/검색 성공)"          │
│      └─ 실패 지점 상세 로그                                  │
│      └─ 추가 수동 확인 필요                                  │
│                                                             │
│   ❌ 실패                                                    │
│      └─ PR 생성 보류                                        │
│      └─ 재분석 시도 또는                                     │
│      └─ 슬랙: "자동 수정 실패, 수동 확인 필요"               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**PR 본문 예시 (검증 완료 시):**

```markdown
## 변경 사항
- 로그인 버튼 셀렉터: `#login-btn` → `.new-login-btn`

## 변경 전/후 비교
| 단계 | Before | After |
|------|--------|-------|
| 로그인 | `#login-btn` | `.new-login-btn` |

## ✅ 테스트 차량 검증 완료
- 차량번호: 12가3456
- 실행 시간: 4.2초
- 결과: 전체 플로우 성공

### 스크린샷
<details>
<summary>로그인 성공</summary>
[스크린샷]
</details>
<details>
<summary>검색 성공</summary>
[스크린샷]
</details>
<details>
<summary>할인 적용 성공</summary>
[스크린샷]
</details>
```

---

## 데이터 흐름

```
1. [배치] 할인권 적용 실패 → 슬랙 알림 발송

2. [Alert Receiver]
   - 슬랙 이벤트 수신
   - vendorId 추출: "vendor-abc"
   - 분석 요청 생성

3. [Analyzer]
   - vendor-abc 사이트 접속 시도 (Playwright)

   3-1. 접속 실패 시 (timeout, connection refused, 5xx)
        → 즉시 반환: { connectionStatus: 'error', httpStatus: 503 }

   3-2. 접속 성공 시
        → DOM 캡처: 로그인 폼, 검색 폼, 버튼들
        → 네트워크 로그: API 엔드포인트들
        → 스크린샷 저장

4. [AI Engine]
   4-1. Phase 1: 규칙 기반 판정 (LLM 불필요)
        - 접속 실패? → SERVER_OR_FIREWALL 즉시 판정, 끝

   4-2. Phase 2: LLM 심층 분석 (접속 성공했지만 실패한 경우)
        - Spec과 DOM/네트워크 비교
        - LLM: "button#login → button.new-login-btn 변경 추정"
        - 결과: { diagnosis: 'SIGNATURE_CHANGED', canAutoFix: true, suggestedFix: '...' }

5. [Action Dispatcher]
   - SIGNATURE_CHANGED + canAutoFix: true
     → 기존 배치 코드 조회 (GitHub MCP)
     → 변경점 비교: "button#login → button.new-login-btn"
     → 수정 코드 생성
     → Draft PR 생성 (GitHub MCP): "fix(vendor-abc): 로그인 버튼 셀렉터 업데이트"
     → 슬랙: "@운영팀 시그니처 변경 감지, Draft PR: https://..."

   - SERVER_OR_FIREWALL
     → 슬랙: "@운영팀 vendor-abc 서버 접속 불가 (서버 다운/방화벽 추정)"
```

---

## Spec 저장소

장비사별 기대 구조를 JSON으로 관리 (TypeScript 클래스에서 자동 추출)

### Spec 구조

```typescript
interface VendorSpec {
  vendorId: string;
  name: string;
  baseUrl: string;

  // 현재 구현 방식
  implementationType: 'dom' | 'api';

  // 구현 버전 (v1/v2 등 레거시 대응)
  implementationVersion: 'v1' | 'v2' | string;

  // 현재 구현 상세
  currentImplementation: {
    dom?: {
      login: { selectors: Record<string, string> };
      search: { selectors: Record<string, string> };
      apply: { selectors: Record<string, string> };
      verify: { selectors: Record<string, string> };
    };
    api?: {
      login: { endpoint: string; method: string; bodyFormat: object };
      search: { endpoint: string; method: string; bodyFormat: object };
      apply: { endpoint: string; method: string; bodyFormat: object };
      verify: { endpoint: string; method: string; bodyFormat: object };
    };
  };

  // 에이전트가 발견한 대안 (안정성 제안용)
  discoveredAlternatives?: {
    api?: {
      endpoints: string[];
      discoveredAt: Date;
      stability: 'unknown' | 'tested' | 'recommended';
    };
    dom?: {
      selectors: Record<string, string>;
      discoveredAt: Date;
    };
  };

  // 마지막 검증 시점
  lastVerified: Date;

  // 연결된 배치 코드 위치
  batchCodeRef: {
    repo: string;
    file: string;
    version: 'v1' | 'v2';
  };

  // Spec 생성 출처
  generatedFrom: {
    source: 'typescript' | 'legacy' | 'manual';
    commit?: string;
    timestamp: Date;
  };
}
```

### 안정성 제안 기능

에이전트가 분석 중 더 안정적인 방식을 발견하면 제안:

```typescript
interface StabilityRecommendation {
  vendorId: string;
  currentMethod: 'dom' | 'api';
  recommendedMethod: 'dom' | 'api';
  reason: string;
  evidence: {
    // DOM → API 전환 추천 시
    discoveredApiEndpoints?: string[];
    apiResponseSample?: object;

    // API → DOM 전환 추천 시 (드묾)
    apiDeprecationNotice?: string;
  };
  migrationDifficulty: 'easy' | 'medium' | 'hard';
}

// 예시 출력
const recommendation: StabilityRecommendation = {
  vendorId: 'vendor-abc',
  currentMethod: 'dom',
  recommendedMethod: 'api',
  reason: 'DOM 셀렉터가 자주 변경됨. 안정적인 API 엔드포인트 발견',
  evidence: {
    discoveredApiEndpoints: [
      'POST /api/v2/auth/login',
      'POST /api/v2/discount/apply'
    ],
    apiResponseSample: { success: true, discountId: '...' }
  },
  migrationDifficulty: 'medium'
};
```

### 분석 흐름에 안정성 제안 추가

```
┌─────────────────────────────────────────────────────────────┐
│                    DOM/Network Agent                        │
│                                                             │
│   1. 현재 구현 방식으로 분석                                  │
│      └─ DOM 방식: 셀렉터 변경 감지                           │
│                                                             │
│   2. (부가) 대안 방식 탐색                                   │
│      └─ Network 로그에서 API 엔드포인트 발견                  │
│      └─ /api/v2/discount/apply 발견                         │
│                                                             │
│   3. 안정성 비교                                             │
│      └─ DOM: 최근 3개월 내 2회 변경                          │
│      └─ API: 발견됨, 테스트 필요                             │
│                                                             │
│   4. 제안                                                   │
│      └─ "API 방식 전환 검토 추천"                            │
│      └─ discoveredAlternatives에 저장                       │
└─────────────────────────────────────────────────────────────┘
```
```

### 하이브리드 Spec 조회 전략

```typescript
async function getVendorExpectation(vendorId: string): Promise<VendorExpectation> {
  // 1. Fast Path: Spec JSON 조회
  const spec = await specStore.get(vendorId);

  if (spec && !isStale(spec)) {
    return { source: 'spec', data: spec };
  }

  // 2. Fallback: TypeScript 코드 직접 읽기
  const code = await githubMcp.getFileContent(
    spec?.batchCodeRef.repo ?? DEFAULT_REPO,
    `vendors/${vendorId}.ts`
  );

  return { source: 'code', data: await parseTypeScriptClass(code) };
}

function isStale(spec: VendorSpec): boolean {
  // spec 생성 후 코드가 변경되었으면 stale
  // 또는 일정 기간 지났으면 stale
}
```

### Spec 자동 생성/동기화

**1. 초기 생성 (1회성)**
```
기존 50개 TypeScript 클래스
        │
        ▼ LLM 기반 파싱
┌─────────────────────────────────────┐
│  class VendorAbc extends BaseVendor │
│    login(): #login-btn              │
│    search(): .search-input          │
│    apply(): button.apply            │
└─────────────────────────────────────┘
        │
        ▼ 추출
┌─────────────────────────────────────┐
│  vendor-abc.json                    │
│  {                                  │
│    "login": { "submit": "#login" }, │
│    "search": { ... }                │
│  }                                  │
└─────────────────────────────────────┘
```

**2. 자동 동기화 (CI/CD)**
```yaml
# .github/workflows/sync-spec.yml
on:
  push:
    paths:
      - 'src/vendors/**/*.ts'

jobs:
  sync-spec:
    runs-on: ubuntu-latest
    steps:
      - name: Extract spec from changed vendor files
        run: npm run extract-spec -- --changed-only

      - name: Commit updated specs
        run: |
          git add specs/
          git commit -m "chore: sync vendor specs"
          git push
```

### 분석 시 활용

```
┌─────────────────────────────────────────────────────────┐
│                     DOM Agent                           │
│                                                         │
│   1. Spec 조회 (Fast Path)                              │
│      └─ vendor-abc.json: login.submit = "#login-btn"   │
│                                                         │
│   2. 실제 DOM 캡처 (Playwright MCP)                     │
│      └─ #login-btn 없음, .new-login-btn 발견            │
│                                                         │
│   3. 변경 감지                                          │
│      └─ "#login-btn" → ".new-login-btn" 변경됨          │
│                                                         │
│   4. (필요시) 코드 직접 확인 (Deep Path)                 │
│      └─ GitHub MCP → vendor-abc.ts 읽기                │
│      └─ 정확한 수정 위치 파악                            │
└─────────────────────────────────────────────────────────┘
```

---

## MVP 범위

### Phase 1: 실패 분석 기본
- [ ] Alert Receiver: 슬랙 웹훅 연동
- [ ] Analyzer: Playwright 기반 사이트 분석
- [ ] AI Engine: 휴리스틱 기반 분류 (LLM 없이)
- [ ] Action Dispatcher: 슬랙 알림만 (PR 생성 없이)

### Phase 2: 자동 수정
- [ ] Spec 저장소 구축
- [ ] LLM 연동: 변경 사항 상세 분석
- [ ] GitHub 연동: PR 자동 생성
- [ ] 기존 50개 장비사 spec 생성

### Phase 3: 신규 연동 자동화
- [ ] 새 장비사 사이트 분석 → spec 자동 생성
- [ ] spec → TypeScript 코드 생성
- [ ] 완전 자동 연동 파이프라인

---

## 미결정 사항

1. **LLM 선택**: OpenAI vs Claude vs 로컬 모델
2. **저장소**: 파일 시스템 vs DB vs S3
3. **배포 환경**: 기존 인프라 vs 별도 서버
4. **알림 수신 방식**: 슬랙 웹훅 vs 로그 스트림 모니터링
5. **인증 정보 관리**: 장비사 로그인 정보를 어떻게 안전하게 관리할지

---

## 다음 단계

1. 프로젝트 초기 셋업 (Node.js + TypeScript + Playwright)
2. 샘플 장비사 1개로 Analyzer PoC 구현
3. 휴리스틱 기반 AI Engine 구현
4. 슬랙 연동
