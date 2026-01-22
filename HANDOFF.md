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
- **기술 스택**: Node.js + TypeScript + Playwright
- **GitHub 연동**: GitHub MCP로 Draft PR 생성
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

## 미결정 사항

| 항목 | 옵션 | 비고 |
|------|------|------|
| LLM | OpenAI / Claude / 로컬 | 비용, 성능 고려 필요 |
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
├── HANDOFF.md              # 이 파일
└── package.json
```

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

## 다음 에이전트가 해야 할 일

### 즉시 시작 가능
1. **프로젝트 초기화**: `npm init`, TypeScript, Playwright 셋업
2. **Analyzer PoC**: 샘플 사이트 하나로 DOM/네트워크 캡처 구현
3. **휴리스틱 엔진**: 위 분류 로직 구현

### 확인 필요
- 슬랙 웹훅 설정 방법 (기존 시스템)
- 배치 레포 위치 및 코드 구조
- 장비사 로그인 정보 접근 방법
- 배포 환경 결정

---

## 참고 문서

- [상세 설계서](./docs/plans/2026-01-20-web-analysis-agent-design.md)

---

## 연락처

- 프로젝트 오너: (TBD)
- 배치 시스템 담당: (TBD)
- 인프라 담당: (TBD)
