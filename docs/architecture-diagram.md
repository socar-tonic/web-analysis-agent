# Web Analysis Agent - 아키텍처 다이어그램

> GitHub에서 바로 렌더링됨. PNG export는 [mermaid.live](https://mermaid.live)에서 가능

---

## 🎯 High-Level Overview

```mermaid
flowchart LR
    A[배치 실패] --> B[분석 에이전트]
    B --> C{멀티 AI 분석}
    C -->|서버 문제| D[슬랙 알림]
    C -->|코드 수정 필요| E[Draft PR]

    style C fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```

```mermaid
flowchart LR
    subgraph AI["⭐ 멀티 에이전트"]
        DOM[DOM]
        NET[Network]
        POL[Policy]
    end

    FAIL[실패] --> AI --> DIAG[종합 진단] --> ACT[PR / 알림]

    style AI fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```

## 🔄 핵심 사이클

```mermaid
flowchart TB
    FAIL[할인권 적용 실패] --> AGENT[🤖 분석 에이전트]
    AGENT --> AI[⭐ AI가 원인 분석 + 코드 수정 제안]
    AI --> VALIDATE{테스트 차량 있음?}
    VALIDATE -->|Yes| TEST[🚗 테스트 차량으로 검증]
    VALIDATE -->|No| PR
    TEST -->|성공| PR[📝 Draft PR ✅검증완료]
    TEST -->|실패| RETRY[재분석 또는 수동 확인]
    PR --> REVIEW[👀 운영팀 리뷰]
    REVIEW --> MERGE[✅ 머지]
    MERGE --> FIX[배치 정상화]

    style AI fill:#fff3cd,stroke:#ffc107,stroke-width:2px
    style TEST fill:#e8f5e9,stroke:#4caf50,stroke-width:2px
```

## 🤖 멀티 에이전트 구조

```mermaid
flowchart TB
    FAIL[실패 알림] --> ORCH[Orchestrator]

    ORCH --> DOM[🔍 DOM Agent]
    ORCH --> NET[🌐 Network Agent]
    ORCH --> POL[📋 Policy Agent]

    DOM --> |셀렉터 변경?| AGG[종합 진단]
    NET --> |API 변경?| AGG
    POL --> |연동정보 오류?| AGG

    AGG --> RESULT[최종 진단 + 해결책]
    RESULT --> ACTION[Draft PR / 슬랙 알림]

    style DOM fill:#e3f2fd,stroke:#2196f3
    style NET fill:#fff3cd,stroke:#ffc107
    style POL fill:#f3e5f5,stroke:#9c27b0
    style AGG fill:#c8e6c9,stroke:#4caf50
```

## 🚗 테스트 차량 검증

```mermaid
flowchart LR
    subgraph INPUT["입력"]
        V[테스트 차량번호<br/>12가3456]
        C[수정된 코드]
    end

    subgraph EXEC["Playwright MCP 실행"]
        E1[로그인] --> E2[검색] --> E3[할인적용] --> E4[확인]
    end

    subgraph RESULT["결과"]
        R1[✅ 성공<br/>PR에 검증완료 태그]
        R2[❌ 실패<br/>재분석/수동확인]
    end

    INPUT --> EXEC
    EXEC -->|전체 성공| R1
    EXEC -->|실패| R2

    style EXEC fill:#e8f5e9,stroke:#4caf50
```

## 💡 안정성 제안 기능

```mermaid
flowchart LR
    subgraph CURRENT["현재 (DOM 방식)"]
        C1[셀렉터 기반]
        C2[UI 변경에 취약]
    end

    subgraph DISCOVER["에이전트 발견"]
        D1[Network 로그 분석]
        D2[API 엔드포인트 발견]
    end

    subgraph RECOMMEND["제안"]
        R1[API 방식 전환 추천]
        R2[마이그레이션 가이드]
    end

    CURRENT --> DISCOVER --> RECOMMEND

    style DISCOVER fill:#fff3cd,stroke:#ffc107
    style RECOMMEND fill:#c8e6c9,stroke:#4caf50
```

## 📊 에이전트별 역할

```mermaid
flowchart LR
    subgraph DOM["🔍 DOM Agent"]
        D1[셀렉터 변경 감지]
        D2[폼 구조 변경]
        D3[버튼/입력필드 위치]
    end

    subgraph NET["🌐 Network Agent"]
        N1[API 엔드포인트 변경]
        N2[요청/응답 포맷]
        N3[인증 방식 변경]
    end

    subgraph POL["📋 Policy Agent"]
        P1[DB 할인키 검증]
        P2[연동 설정 확인]
        P3[차량번호 포맷 검증]
    end

    style DOM fill:#e3f2fd,stroke:#2196f3
    style NET fill:#fff3cd,stroke:#ffc107
    style POL fill:#f3e5f5,stroke:#9c27b0
```

## 📂 Spec 하이브리드 조회

```mermaid
flowchart TB
    START[분석 시작] --> CHECK{Spec 존재?}

    CHECK -->|있음| FRESH{최신?}
    CHECK -->|없음| CODE

    FRESH -->|Yes| SPEC[Fast Path<br/>Spec JSON 사용]
    FRESH -->|No| CODE[Deep Path<br/>GitHub MCP로<br/>TypeScript 코드 읽기]

    SPEC --> ANALYZE[분석 수행]
    CODE --> ANALYZE

    style SPEC fill:#c8e6c9,stroke:#4caf50
    style CODE fill:#fff3cd,stroke:#ffc107
```

## 🔄 Spec 동기화

```mermaid
flowchart LR
    subgraph BATCH["배치 레포"]
        TS[vendor-abc.ts]
    end

    subgraph CI["CI/CD"]
        EXTRACT[Spec 추출]
    end

    subgraph SPEC["Spec 저장소"]
        JSON[vendor-abc.json]
    end

    TS -->|PR 머지| EXTRACT
    EXTRACT -->|자동 생성| JSON

    style CI fill:#e3f2fd,stroke:#2196f3
```

---

## 전체 흐름

```mermaid
flowchart TB
    subgraph BATCH["📦 배치 서버 (기존)"]
        B1[로그인] --> B2[차량검색] --> B3[할인권적용] --> B4[확인]
        B3 -->|실패| ALERT[슬랙 알림 발송]
    end

    ALERT --> AR

    subgraph AGENT["🤖 Web Analysis Agent"]
        AR[1. Alert Receiver<br/>장비사 ID 추출]
        AR --> AN[2. Analyzer<br/>Playwright 접속]

        AN -->|접속 실패| RULE[규칙 기반 판정<br/>LLM 불필요]
        AN -->|접속 성공| AI

        subgraph AI_BOX["⭐ AI / LLM"]
            AI[DOM + 네트워크 캡처]
            AI --> AI1[1. DOM diff 분석]
            AI1 --> AI2[2. 변경점 파악]
            AI2 --> AI3[3. 수정 코드 생성]
        end

        RULE --> ACT1[SERVER_OR_FIREWALL]
        AI3 --> ACT2[SIGNATURE_CHANGED]

        subgraph DISPATCH["3. Action Dispatcher"]
            ACT1 --> SLACK1[슬랙 알림<br/>서버 다운 추정]
            ACT2 --> GH[GitHub MCP<br/>Draft PR 생성]
            GH --> SLACK2[슬랙 알림<br/>@운영팀 + PR링크]
        end
    end

    style AI_BOX fill:#fff3cd,stroke:#ffc107,stroke-width:2px
    style BATCH fill:#e3f2fd,stroke:#2196f3
    style AGENT fill:#f5f5f5,stroke:#666
```

## AI 역할 상세

```mermaid
flowchart LR
    subgraph INPUT["입력"]
        I1[캡처된 DOM]
        I2[네트워크 로그]
        I3[기존 Spec]
        I4[배치 코드]
    end

    subgraph LLM["⭐ AI / LLM 분석"]
        direction TB
        L1["어떤 셀렉터가<br/>변경되었는가?"]
        L2["변경 전 vs 후<br/>차이점은?"]
        L3["코드를 어떻게<br/>수정해야 하는가?"]
        L1 --> L2 --> L3
    end

    subgraph OUTPUT["출력"]
        O1[진단 결과]
        O2[변경점 설명]
        O3[수정 코드 제안]
    end

    INPUT --> LLM --> OUTPUT

    style LLM fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```

## 진단 분기

```mermaid
flowchart TD
    START[실패 알림 수신] --> CONNECT{사이트 접속}

    CONNECT -->|timeout<br/>connection refused<br/>5xx| SERVER[SERVER_OR_FIREWALL]
    CONNECT -->|성공| ANALYZE[AI 분석]

    ANALYZE --> SIG{시그니처 변경?}
    SIG -->|Yes| CHANGED[SIGNATURE_CHANGED]
    SIG -->|No| OTHER[INTERNAL_ERROR<br/>DATA_ERROR<br/>UNKNOWN]

    SERVER --> S1[📢 슬랙 알림]
    CHANGED --> PR[📝 Draft PR 생성]
    PR --> S2[📢 슬랙 + PR링크]
    OTHER --> S3[📢 슬랙 알림]

    style SERVER fill:#ffcdd2
    style CHANGED fill:#c8e6c9
    style ANALYZE fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```

## 핵심 흐름 (간단 버전)

```mermaid
flowchart LR
    A[실패 알림] --> B{접속}
    B -->|실패| C[규칙] --> D[서버/방화벽] --> E[슬랙]
    B -->|성공| F[AI/LLM] --> G[시그니처 변경] --> H[Draft PR] --> I[슬랙]

    style F fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```
