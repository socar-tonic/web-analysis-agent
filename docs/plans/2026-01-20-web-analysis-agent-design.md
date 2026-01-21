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

### 3. AI Engine
2단계 분석: 규칙 기반 판정 → LLM 심층 분석

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
  return null; // 접속 성공 → Phase 2로
}
```

**Phase 2: LLM 심층 분석 (접속 성공 시에만)**
```typescript
// 접속은 됐지만 실패한 경우 → LLM이 DOM/네트워크 분석
async function analyzeWithLLM(analysis: SiteAnalysis, spec: VendorSpec): Promise<Diagnosis> {
  const prompt = `
    장비사: ${spec.name}
    기대 셀렉터: ${JSON.stringify(spec.steps)}
    실제 DOM: ${JSON.stringify(analysis.domSnapshot)}
    네트워크 로그: ${JSON.stringify(analysis.networkLogs)}

    실패 원인을 분석하고 SIGNATURE_CHANGED / INTERNAL_ERROR / DATA_ERROR / UNKNOWN 중 판정하세요.
    SIGNATURE_CHANGED인 경우 변경된 셀렉터와 새 셀렉터를 제안하세요.
  `;
  // LLM 호출
}
```

**LLM 역할 (Phase 2에서만):**
- DOM diff 분석하여 구체적인 변경 사항 설명
- 새 셀렉터 추천
- API 응답 포맷 변경 감지
- 수정 코드 제안

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
}

// GitHub MCP를 통한 Draft PR 생성
async function createDraftPR(analysis: AnalysisResult, spec: VendorSpec): Promise<string> {
  // 1. 기존 배치 코드 조회
  const currentCode = await githubMcp.getFileContent(spec.batchCodeRef.repo, spec.batchCodeRef.file);

  // 2. LLM이 제안한 수정 사항 적용
  const updatedCode = applyFix(currentCode, analysis.details.suggestedFix);

  // 3. Draft PR 생성
  const prUrl = await githubMcp.createPullRequest({
    repo: spec.batchCodeRef.repo,
    branch: `fix/${spec.vendorId}-signature-update`,
    title: `fix(${spec.vendorId}): UI/API 시그니처 변경 대응`,
    body: generatePRBody(analysis),  // 변경 전/후 비교, 스크린샷 포함
    files: [{ path: spec.batchCodeRef.file, content: updatedCode }],
    draft: true
  });

  return prUrl;
}
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

## Spec 저장소 (향후 구현)

장비사별 기대 구조를 JSON으로 관리:

```typescript
interface VendorSpec {
  vendorId: string;
  name: string;
  baseUrl: string;
  type: 'ui' | 'api' | 'hybrid';

  steps: {
    login: {
      selectors?: {
        form: string;
        username: string;
        password: string;
        submit: string;
      };
      api?: {
        endpoint: string;
        method: string;
        bodyFormat: object;
      };
    };
    search: { /* ... */ };
    apply: { /* ... */ };
    verify: { /* ... */ };
  };

  // 마지막 검증 시점
  lastVerified: Date;

  // 연결된 배치 코드 위치
  batchCodeRef: {
    repo: string;
    file: string;
  };
}
```

**Spec 생성 방법 (Phase 2):**
1. 기존 Puppeteer 코드에서 셀렉터 추출
2. 실제 사이트 방문하여 검증 및 보강
3. 정기적으로 spec vs 실제 비교하여 drift 감지

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
