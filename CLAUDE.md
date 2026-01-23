# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

주차 할인권 적용 배치 실패 시 자동으로 원인을 분석하고, UI/API 시그니처 변경이면 Draft PR까지 생성하는 AI 에이전트 시스템.

**현재 상태**: 설계 완료, 구현 대기

## Tech Stack

- Runtime: Node.js + TypeScript
- Package Manager: pnpm
- Agent Framework: LangGraph.js
- Structured Output: Zod
- Memory: LangGraph Checkpoints
- Browser Automation: Playwright MCP
- Version Control: GitHub MCP

## Architecture

```
Alert Receiver → Analyzer (Playwright) → AI Engine (멀티 에이전트) → Action Dispatcher
                                              │                            ↓
                                    ┌─────────┼─────────┐       Slack 알림 / GitHub PR
                                    │         │         │
                                DOM Agent  Network   Policy
                                           Agent    Agent
```

### Core Components

1. **Alert Receiver**: 슬랙 웹훅으로 실패 알림 수신, vendorId 추출
2. **Analyzer**: Playwright로 사이트 접속, DOM/네트워크 캡처
3. **AI Engine**: Orchestrator + 3개 전문 에이전트 (DOM/Network/Policy)
4. **Action Dispatcher**: 진단 결과에 따라 Slack 알림 또는 GitHub Draft PR 생성

### Analysis Flow

1. 접속 실패 → `SERVER_OR_FIREWALL` (LLM 불필요, 규칙 기반 즉시 판정)
2. 접속 성공 → 멀티 에이전트 병렬 분석 → `SIGNATURE_CHANGED` / `INTERNAL_ERROR` / `DATA_ERROR` / `UNKNOWN`
3. `SIGNATURE_CHANGED` → 기존 코드와 비교 → 수정 코드 생성 → Draft PR

### Security Architecture

**원칙: LLM은 비밀번호, 세션 토큰, 쿠키를 절대 알지 못함**

- LLM이 아는 것: vendorId, sessionId, vehicleNumber, 결과
- LLM이 모르는 것: username, password, cookies, auth tokens
- Credential Vault + Session Manager 패턴으로 분리

## Development Guidelines

### LangGraph 구현 시

LangGraph.js 코드 작성 시 반드시 `use context7`를 사용하여 최신 문서를 참조할 것.

```
// 프롬프트 예시
LangGraph StateGraph 구현해줘 use context7
```

### Zod Schemas

에이전트 간 통신은 반드시 Zod 스키마로 구조화:
- `AnalysisRequestSchema`: Orchestrator → Agent 요청
- `DOMAnalysisResultSchema`: DOM Agent 결과
- `NetworkAnalysisResultSchema`: Network Agent 결과
- `PolicyAnalysisResultSchema`: Policy Agent 결과
- `FinalDiagnosisSchema`: 종합 진단 결과

### Vendor Spec

장비사별 기대 구조를 JSON으로 관리:
- `implementationType`: 'dom' | 'api'
- `currentImplementation`: 셀렉터 또는 API 엔드포인트 정보
- `batchCodeRef`: 연결된 배치 코드 위치

## Key Documentation

- `HANDOFF.md`: 프로젝트 개요 및 아키텍처 결정 사항
- `docs/architecture-overview.md`: 아키텍처 다이어그램
- `docs/plans/2026-01-20-web-analysis-agent-design.md`: 상세 설계서 (Zod 스키마, 코드 예시 포함)

## MVP Phases

1. **Phase 1**: 휴리스틱 기반 분류 (LLM 없이) + Slack 알림
2. **Phase 2**: LLM 연동 + Spec 저장소 + GitHub PR 자동 생성
3. **Phase 3**: 신규 장비사 자동 분석 → spec → 코드 생성
