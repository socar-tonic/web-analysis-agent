# PRGraph 설계 문서

> 멀티에이전트 워크플로우 중 "탈출" 상황 (API/UI 시그니처 변경) 발생 시 자동으로 Draft PR을 생성하는 컴포넌트

## 배경

LoginGraph → SearchGraph → DiscountGraph 워크플로우 중 다음 상황에서 "탈출"이 필요:

| 상황 | 액션 |
|------|------|
| 서버/방화벽 장애 | Slack 알림만 |
| API 시그니처 변경 | **Draft PR 생성** |
| UI (DOM) 변경 | **Draft PR 생성** |

PR 대상 레포: `socar-inc/modu-batch-webdc`

## 설계 결정 사항

| 항목 | 결정 | 이유 |
|------|------|------|
| 구현 형태 | PRGraph (StateGraph) | LoginGraph/SearchGraph와 일관된 패턴 |
| 코드 수정 방식 | LLM 기반 (createAgent) | capturedApiSchema 기반 유연한 코드 생성 |
| GitHub 접근 | GitHub MCP | Playwright MCP와 일관성, 읽기/쓰기 모두 |
| 실패 처리 | Slack 알림 폴백 | 자동화 실패 시 사람에게 전달 |
| 트리거 | 외부 Orchestrator | Graph 간 의존성 낮춤, 재사용성 |
| 레포 설정 | 환경변수 + spec | 레포는 env, 파일 경로는 spec/systemCode |

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                     AnalysisOrchestrator                         │
│  (LoginGraph/SearchGraph 결과 → 조건 판단 → PRGraph 호출)        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼ specChanges.codeWillBreak === true
┌─────────────────────────────────────────────────────────────────┐
│                          PRGraph                                 │
│                                                                  │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│   │ loadContext  │───▶│ generateFix  │───▶│  createPR    │     │
│   │  (단순노드)   │    │ (createAgent)│    │ (단순노드)   │     │
│   └──────────────┘    └──────────────┘    └──────────────┘     │
│          │                   │                    │              │
│          │ GitHub MCP        │ GitHub MCP         │ GitHub MCP   │
│          ▼                   ▼                    ▼              │
│                     ┌────────────────────────────────┐          │
│                     │   socar-inc/modu-batch-webdc   │          │
│                     └────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              성공: PR URL            실패: 에러 반환
              (Orchestrator가        (Orchestrator가
               Slack 공유)            Slack 알림)
```

## PRGraph State

```typescript
interface PRGraphState {
  // Input (from Orchestrator)
  systemCode: string;                      // "humax-parcs"
  changeType: 'dom' | 'api';               // 변경 유형
  changes: string[];                       // ["API 엔드포인트 변경: /old → /new"]
  capturedApiSchema?: CapturedApiSchema;   // 새 API 스키마

  // Context (loadContext에서 설정)
  batchCodePath: string;                   // "src/v1/biz/service/humax/search.ts"
  existingCode: string;                    // 기존 코드 내용

  // Output (generateFix에서 설정)
  fixedCode: string;                       // 수정된 코드
  commitMessage: string;                   // 커밋 메시지
  prTitle: string;                         // PR 제목
  prBody: string;                          // PR 본문

  // Result
  status: 'pending' | 'success' | 'failed';
  prUrl?: string;                          // 성공 시 PR URL
  errorMessage?: string;                   // 실패 시 에러
}
```

## 노드 상세

### 1. loadContext (단순 노드)

**역할**: spec에서 파일 경로 추출, GitHub MCP로 기존 코드 읽기

```typescript
async function loadContext(state: PRGraphState): Promise<Partial<PRGraphState>> {
  const { systemCode } = state;

  // 파일 경로 결정 (spec 또는 convention)
  const batchCodePath = `src/v1/biz/service/${systemCode}/search.ts`;

  // GitHub MCP로 파일 읽기
  const existingCode = await githubMcp.getFileContents({
    owner: process.env.BATCH_REPO_OWNER,
    repo: process.env.BATCH_REPO_NAME,
    path: batchCodePath,
  });

  return { batchCodePath, existingCode };
}
```

### 2. generateFix (createAgent)

**역할**: LLM이 기존 코드 + 변경 정보 분석 → 수정 코드 생성

**도구**:
| 도구 | GitHub MCP 매핑 | 용도 |
|------|----------------|------|
| `read_file` | `get_file_contents` | 추가 파일 읽기 |
| `search_code` | `search_code` | 관련 코드 검색 |

**프롬프트 핵심**:
```
당신은 주차 배치 시스템 코드를 수정하는 전문가입니다.

## 입력
- 기존 코드: {existingCode}
- 감지된 변경: {changes}
- 새 API 스키마: {capturedApiSchema}

## 작업
1. 기존 코드에서 변경 필요한 부분 파악
2. capturedApiSchema 기반으로 수정
3. 필요시 read_file로 관련 파일 확인

## 출력 (JSON)
{
  "fixedCode": "전체 수정된 코드",
  "commitMessage": "fix(humax): update search API endpoint",
  "prTitle": "fix(humax): 검색 API 엔드포인트 변경 반영",
  "prBody": "## 변경 사항\n..."
}
```

### 3. createPR (단순 노드)

**역할**: GitHub MCP로 branch 생성 → 파일 수정 commit → Draft PR 생성

```typescript
async function createPR(state: PRGraphState): Promise<Partial<PRGraphState>> {
  const branchName = `fix/${state.systemCode}-${Date.now()}`;

  // 1. Branch 생성
  await githubMcp.createBranch({ ... });

  // 2. 파일 수정 commit
  await githubMcp.createOrUpdateFile({
    path: state.batchCodePath,
    content: state.fixedCode,
    message: state.commitMessage,
    branch: branchName,
  });

  // 3. Draft PR 생성
  const pr = await githubMcp.createPullRequest({
    title: state.prTitle,
    body: state.prBody,
    head: branchName,
    base: 'main',
    draft: true,
  });

  return { status: 'success', prUrl: pr.html_url };
}
```

## Orchestrator

```typescript
class AnalysisOrchestrator {
  async run(input: AnalysisInput): Promise<AnalysisResult> {
    // 1. LoginGraph
    const loginResult = await this.loginGraph.run(input);

    if (loginResult.status === 'CONNECTION_ERROR') {
      await this.slack.notify({ type: 'SERVER_DOWN', ... });
      return { action: 'notified' };
    }

    if (loginResult.specChanges?.codeWillBreak) {
      return await this.handleSignatureChange(loginResult);
    }

    // 2. SearchGraph
    const searchResult = await this.searchGraph.run(...);

    if (searchResult.specChanges?.codeWillBreak) {
      return await this.handleSignatureChange(searchResult);
    }

    // 3. (미래) DiscountGraph...

    return { action: 'completed' };
  }

  private async handleSignatureChange(result): Promise<AnalysisResult> {
    const prResult = await this.prGraph.run({
      systemCode: result.systemCode,
      changeType: result.specChanges.changeType,
      changes: result.specChanges.changes,
      capturedApiSchema: result.specChanges.capturedApiSchema,
    });

    if (prResult.status === 'success') {
      await this.slack.notify({ type: 'PR_CREATED', prUrl: prResult.prUrl });
      return { action: 'pr_created', prUrl: prResult.prUrl };
    } else {
      await this.slack.notify({ type: 'SIGNATURE_CHANGED', changes: result.specChanges.changes });
      return { action: 'notified', error: prResult.errorMessage };
    }
  }
}
```

## Slack 알림 유형

| 상황 | 타입 | 메시지 예시 |
|------|------|------------|
| 서버 장애 | `SERVER_DOWN` | `:rotating_light: [humax] 서버 접속 불가` |
| PR 생성 성공 | `PR_CREATED` | `:rocket: [humax] Draft PR 생성됨 → PR #123` |
| PR 생성 실패 | `SIGNATURE_CHANGED` | `:warning: [humax] API 변경 감지 (자동 수정 실패)` |

## 환경 변수

```bash
# GitHub 레포 설정
BATCH_REPO_OWNER=socar-inc
BATCH_REPO_NAME=modu-batch-webdc

# GitHub MCP 인증
GITHUB_TOKEN=ghp_xxxxx
```

## 파일 경로 Convention

```
src/v1/biz/service/{systemCode}/search.ts   # 검색 로직
src/v1/biz/service/{systemCode}/login.ts    # 로그인 로직
src/v1/biz/service/{systemCode}/discount.ts # 할인 적용 로직
```

또는 spec에 `batchCodePath` 필드로 명시 가능.
