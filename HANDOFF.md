# Handoff: Web Analysis Agent

> 다음 에이전트가 빠르게 컨텍스트를 파악할 수 있도록 작성된 문서

## 한 줄 요약

**주차 할인권 배치 실패 시 자동으로 원인을 분석하고, UI/API 시그니처 변경이면 PR까지 생성하는 AI 에이전트**

---

## 프로젝트 컨텍스트

### 비즈니스 배경
- 50개 외부 주차 장비사 웹사이트와 연동하는 배치 시스템 운영 중
- Puppeteer/Axios로 로그인 → 차량 검색 → 할인권 적용 → 확인 수행
- 실패해도 배치는 멈추지 않고 warning 로그 + 슬랙 알림만 발송
- 현재는 알림만 받고 대부분 디버깅하지 않음

### 해결하려는 문제
1. 실패 원인 파악이 어려움 (서버 다운/방화벽? UI/API 시그니처 변경? 내부 로직 오류? 데이터 문제?)
2. 외부 사이트 UI/API 변경 시 수동으로 코드 수정 필요
3. 신규 장비사 연동 시 분석 및 코드 작성에 시간 소요

---

## 아키텍처 결정 사항

### 확정된 것
- **별도 서버**: 기존 배치와 분리된 독립 서비스
- **기술 스택**:
  - Node.js + TypeScript + pnpm
  - **LangGraph.js** (에이전트 오케스트레이션)
  - **LangSmith** (트레이싱, 디버깅, 데모용 Observability)
  - **Zod** (에이전트 간 구조화된 통신)
  - **LangGraph Checkpoints** (메모리/상태 저장)
- **MCP 연동**: Playwright, GitHub, DB
- **트리거**: 슬랙 알림 수신 시 분석 시작
- **분석 방식**: 사후 분석 (실패 알림 → 사이트 재방문 → 분석)
- **최종 목표**: UI/API 변경 시 기존 코드와 비교 → 변경점 제안 → Draft PR 생성

### 주요 컴포넌트
```
Alert Receiver → Analyzer (Playwright) → AI Engine (멀티 에이전트) → Action Dispatcher
                                              │                            ↓
                                    ┌─────────┼─────────┐       Slack 알림 / GitHub PR
                                    │         │         │
                                DOM Agent  Network   Policy
                                           Agent    Agent
```

### 멀티 에이전트 구조
| 에이전트 | 역할 | 분석 대상 |
|---------|------|----------|
| **DOM Agent** | UI 셀렉터 변경 감지 | 폼 구조, 버튼, 입력필드 |
| **Network Agent** | API 변경 감지 | 엔드포인트, 요청/응답 포맷 |
| **Policy Agent** | 내부 설정 검증 | DB 할인키, 연동 정보, 차량번호 |

### 구현 방식
- 장비사별로 `dom` OR `api` 방식 (현재 혼합 없음)
- 코드 버전: v1/v2 혼재 (TypeScript만 있는게 아님)
- → Spec으로 추상화하여 관리

### 안정성 제안 기능
에이전트가 분석 중 더 안정적인 방식 발견 시 제안:
```
"현재 DOM 방식인데 API 엔드포인트(/api/v2/discount) 발견.
 DOM이 최근 자주 변경됨 → API 전환 검토 추천"
```

### 테스트 차량 검증
운영팀이 테스트 차량번호 제공 시:
1. 수정된 코드로 실제 플로우 실행 (Playwright MCP)
2. 로그인 → 검색 → 할인적용 → 확인
3. 결과에 따라:
   - ✅ 성공 → PR에 "검증 완료" 태그 + 스크린샷 첨부
   - ❌ 실패 → 재분석 또는 수동 확인 요청

### 보안 아키텍처
**원칙: LLM은 비밀번호, 세션 토큰, 쿠키를 절대 알지 못함**

| LLM이 아는 것 | LLM이 모르는 것 |
|--------------|----------------|
| vendorId | username/password |
| sessionId | cookies |
| vehicleNumber | auth tokens |
| 성공/실패 결과 | session data |

**구성요소:**
- **Credential Vault**: 비밀번호 보안 저장 (AWS Secrets Manager 등)
- **Session Manager**: 브라우저 세션 관리 (로그인 상태 유지)
- **MCP Tools**: vendorId/sessionId만 받고, 실제 credentials는 내부에서 처리

**실행 방식**: 조건부 실행 (실패 유형에 따라 필요한 에이전트만 호출)

### Spec 하이브리드 전략
| 상황 | 방식 | 설명 |
|-----|------|------|
| 평소 | **Fast Path** | Spec JSON 참조 (빠름, 토큰 절약) |
| Spec 없음/오래됨 | **Deep Path** | GitHub MCP로 TypeScript 코드 직접 읽기 |

**Spec 동기화**: 배치 레포 PR 머지 시 CI/CD가 자동으로 Spec 추출/갱신

### 분석 흐름
1. 슬랙에서 실패 알림 수신
2. 장비사 ID 추출
3. 해당 사이트 headless 접속 시도
4. **Phase 1 (LLM 불필요)**: 접속 실패? → `SERVER_OR_FIREWALL` 즉시 판정
5. **Phase 2 (LLM 필요)**: 접속 성공 → DOM/네트워크 캡처 → LLM 분석
6. `SIGNATURE_CHANGED`면:
   - 기존 배치 코드와 비교 (GitHub MCP로 조회)
   - 변경점 분석 및 수정 코드 생성
   - **Draft PR 생성** (GitHub MCP)
   - 슬랙에 Draft PR 링크 공유

### 실패 분류 (도메인 지식 기반)

| 진단 | 조건 | LLM | 액션 |
|------|------|-----|------|
| `SERVER_OR_FIREWALL` | 접속 자체 실패 (timeout, 5xx) | **불필요** | 슬랙 알림 |
| `SIGNATURE_CHANGED` | DOM 셀렉터/API 포맷 불일치 | 필요 | **GitHub MCP로 Draft PR 생성** |
| `INTERNAL_ERROR` | (외부 분석으론 판단 어려움) | 필요 | 수동 확인 알림 |
| `DATA_ERROR` | (외부 분석으론 판단 어려움) | 필요 | 수동 확인 알림 |

---

## 결정된 사항

| 항목 | 결정 | 비고 |
|------|------|------|
| LLM | **Claude** (@langchain/anthropic) | 교체 용이하도록 추상화 |
| Agent 실행 방식 | **Parallel** | DOM/Network/Policy 병렬 실행 |
| Observability | **LangSmith** | 데모/디버깅용 트레이싱 |

## 미결정 사항

| 항목 | 옵션 | 비고 |
|------|------|------|
| 저장소 | 파일 / DB / S3 | 스크린샷, 분석 결과 저장 |
| 배포 환경 | 기존 인프라 / 별도 | 인프라팀 확인 필요 |
| 알림 수신 | 슬랙 웹훅 / 로그 스트림 | 기존 시스템에 따라 |
| 인증 관리 | 장비사 로그인 정보 | 보안 고려 필요 |

---

## 파일 구조 (예정)

```
web-analysis-agent/
├── docs/
│   └── plans/
│       └── 2026-01-20-web-analysis-agent-design.md  # 상세 설계
├── src/
│   ├── alert-receiver/     # 슬랙 웹훅 처리
│   ├── analyzer/           # Playwright 기반 사이트 분석
│   ├── ai-engine/          # 휴리스틱 + LLM 분석
│   ├── action-dispatcher/  # 슬랙/GitHub 액션
│   └── specs/              # 장비사별 spec JSON
├── .env.example            # 환경 변수 템플릿
├── langgraph.json          # LangGraph Studio 설정
├── HANDOFF.md              # 이 파일
└── package.json
```

## LangSmith 설정 (데모/디버깅용)

### 환경 변수
```bash
# .env
LANGSMITH_API_KEY=<your-api-key>      # https://smith.langchain.com 에서 발급
LANGSMITH_PROJECT=web-analysis-agent
LANGSMITH_TRACING=true
```

### LangGraph Studio (선택)
로컬에서 에이전트 플로우를 시각적으로 실행/디버깅:
1. LangGraph Studio 설치: https://github.com/langchain-ai/langgraph-studio
2. Docker 필요
3. `langgraph.json` 설정 파일 필요

### 활용
- **데모**: LangSmith 대시보드에서 실시간 에이전트 실행 추적
- **디버깅**: 각 노드별 입출력, 토큰 사용량, 지연 시간 확인
- **평가**: 에이전트 성능 측정 및 비교

---

## MVP 로드맵

### Phase 1: 실패 분석 기본 (MVP)
- Alert Receiver: 슬랙 웹훅 연동
- Analyzer: Playwright 사이트 분석
- AI Engine: 휴리스틱 기반 분류 (LLM 없이)
- Action Dispatcher: 슬랙 알림만

### Phase 2: 자동 수정
- Spec 저장소 구축
- LLM 연동
- GitHub PR 자동 생성
- 기존 50개 장비사 spec 생성

### Phase 3: 신규 연동 자동화
- 새 사이트 분석 → spec 자동 생성
- spec → TypeScript 코드 생성

---

## 현재 구현 상태 (2026-01-26)

### Phase 1 MVP 완료 ✅ + MCP 에이전트 🚧

**방향 전환**: HTTP 서버보다 에이전트 품질 검증 우선
- CLI로 개별 에이전트 테스트 가능하도록 구성
- mock-input.json으로 수동 입력 제공
- LLM 연동 완료 (Internal AI Router / Gemini / OpenAI / Anthropic)

### 에이전트 개발 우선순위
1. ✅ **LLM 연동** - 각 에이전트가 LLM으로 분석
2. ✅ **MCP 기반 자율 에이전트** - LLM이 Playwright 도구 직접 호출
3. 🔜 **Secure Login Agent** - 비밀번호 노출 없이 MCP로 로그인
4. 📋 **Spec 비교** - 비용 절감용 캐시 (나중에)

### CLI 사용법

```bash
# 환경 변수 설정 필수 (하나 이상)
echo "INTERNAL_AI_URL=... INTERNAL_AI_KEY=..." > .env
# 또는 GOOGLE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY

# 개별 에이전트 실행
pnpm agent:dom        # DOM 에이전트 (로그인 플로우 포함)
pnpm agent:network    # Network 에이전트
pnpm agent:policy     # Policy 에이전트
pnpm agent:dom-mcp    # 🆕 MCP 기반 자율 에이전트 (LLM이 도구 직접 호출)

# 전체 병렬 실행
pnpm agent:all
```

### mock-input.json 구조

```json
{
  "systemCode": "vendor-sample",
  "url": "https://example.com",
  "id": "test-user",
  "pwd": "test-pass",
  "discountId": "DISCOUNT001",
  "carNum": "12가3456"
}
```

| 필드 | 설명 | LLM 전달 |
|------|------|----------|
| systemCode | 장비사 식별자 (구 vendorId) | ✅ |
| url | 장비사 사이트 URL | ✅ |
| id | 로그인 아이디 | ❌ (HasCredentials만) |
| pwd | 로그인 비밀번호 | ❌ 절대 안넘김 |
| discountId | 할인키 (구 discountKey) | ✅ |
| carNum | 차량번호 (구 vehicleNumber) | ✅ |

### 에이전트별 LLM 분석 내용

| Agent | Playwright 캡처 | LLM 분석 | 출력 |
|-------|----------------|----------|------|
| **DOM** | HTML 스냅샷 | 로그인폼, 검색폼, 할인버튼 셀렉터 | JSON (pageType, elements, issues) |
| **Network** | 요청/응답 로그 | API 엔드포인트, 파라미터 패턴 | JSON (apiType, endpoints, issues) |
| **Policy** | - | 설정값 포맷 검증 | JSON (validations, recommendations) |

### 보안 원칙 (구현됨)

```
LLM에게 절대 안 넘기는 것:
- pwd (비밀번호)
- token, session, cookie
- Authorization 헤더

LLM에게 넘기는 것:
- systemCode, url, discountId, carNum
- HTML (script/style 제거)
- 요청/응답 (민감정보 마스킹: "token":"***")
```

### 파일 구조

```
src/
├── cli.ts                        # 🆕 CLI 진입점 (LLM 연동)
├── index.ts                      # HTTP 서버 진입점
├── schemas/                      # Zod 스키마
├── analyzer/                     # Playwright 분석기
├── engine/                       # 휴리스틱 엔진
├── dispatcher/                   # Slack 발송 (mock 지원)
├── graph/                        # LangGraph 워크플로우
│   ├── agents/                   # 에이전트 (stub → LLM 연동 중)
│   └── ...
├── alert-receiver/               # HTTP 서버
└── __tests__/                    # 통합 테스트

mock-input.json                   # 🆕 수동 입력 데이터
```

### 다음 작업: Login Agent (새 설계)

**목표**: MCP 기반 로그인 에이전트 - 로그인 수행 + 프로세스 분석 + Spec 생성/비교 + 변경 감지

**상세 계획**: `docs/plans/2026-01-26-login-agent.md`

```
현재: dom-mcp 에이전트가 pwd를 프롬프트에 직접 포함 (보안 문제)
목표: secure_fill_credential 도구로 LLM 없이 pwd 주입
```

**아키텍처**:
```
LLM ──▶ secure_fill_credential(field: "password", element: "...")
                    │
                    ▼
         CredentialManager.getFieldValue(systemCode, "password")
                    │
                    ▼
         browser_type(element, text: "actual_password")
```

**구현 태스크**:
1. CredentialManager 클래스 - systemCode별 credential 저장/조회
2. secure_fill_credential 도구 - LLM은 field만 지정, 실제 값은 내부 주입
3. LoginResult 스키마 - SUCCESS/INVALID_CREDENTIALS/FORM_CHANGED/API_CHANGED
4. SecureLoginAgent 클래스 - MCP + CredentialManager 통합
5. CLI 연결 - `pnpm agent:secure-login`

**분석 목표**:
- 로그인 성공/실패 판정
- id/pwd 틀림 vs 폼 구조 변경 구분
- API 엔드포인트 변경 감지

---

## 참고 문서

- [상세 설계서](./docs/plans/2026-01-20-web-analysis-agent-design.md)
- [Phase 1 MVP 구현](./docs/plans/2026-01-24-phase1-mvp-implementation.md)
- [Secure Login Agent 설계](./docs/plans/2026-01-26-secure-login-agent.md)

---

## 연락처

- 프로젝트 오너: (TBD)
- 배치 시스템 담당: (TBD)
- 인프라 담당: (TBD)
