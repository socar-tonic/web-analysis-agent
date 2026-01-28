# MVP Phase 2: LLM + Spec Storage + GitHub PR Automation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** LoginGraph/SearchGraph에서 감지된 UI/API 시그니처 변경을 자동으로 분석하고, 수정 코드가 포함된 Draft PR을 GitHub에 생성하는 시스템 완성

**Architecture:**
- `SIGNATURE_CHANGED` 진단 → Code Generator로 수정 코드 생성 → GitHub Dispatcher로 Draft PR 생성 → Slack으로 PR 링크 알림
- 기존 LoginGraph/SearchGraph의 `specChanges.codeWillBreak` 트리거 활용
- Octokit (GitHub REST API) 직접 사용 (GitHub MCP 대신)

**Tech Stack:**
- Octokit (@octokit/rest) - GitHub API
- Zod schemas for PR/Code generation
- Existing: LangGraph, Playwright MCP, LangChain

---

## What's Already Built (Phase 1 + Current)

| Component | Status | Location |
|-----------|--------|----------|
| LoginGraph | Complete | `src/agents/login-graph/` |
| SearchGraph | Complete | `src/agents/search-graph/` |
| SpecStore (file-based) | Complete | `src/specs/spec-store.ts` |
| LLM Factory | Complete | `src/llm/llm-factory.ts` |
| SlackDispatcher | Complete | `src/dispatcher/slack-dispatcher.ts` |
| Zod Schemas | Complete | `src/schemas/` |
| CLI | Complete | `src/cli.ts` |
| Change Detection | Complete | `compare-spec.ts` with `capturedApiSchema` |

## What Needs to Be Built (Phase 2)

| Component | Description |
|-----------|-------------|
| **GitHub Dispatcher** | Create Draft PR with code changes |
| **Code Generator** | Generate TypeScript code from spec changes |
| **PR Schema** | Zod schema for PR request/response |
| **Orchestrator Integration** | Wire everything together |
| **Slack Enhancement** | Include PR link in notifications |

---

## Task 1: Add Octokit Dependency

**Files:**
- Modify: `package.json`

**Step 1: Install @octokit/rest**

Run: `pnpm add @octokit/rest`

**Step 2: Verify installation**

Run: `pnpm list @octokit/rest`
Expected: `@octokit/rest` listed in dependencies

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add @octokit/rest for GitHub API"
```

---

## Task 2: GitHub PR Schema Definition

**Files:**
- Create: `src/schemas/github-pr.schema.ts`
- Modify: `src/schemas/index.ts`
- Test: `src/schemas/__tests__/github-pr.schema.test.ts`

**Step 1: Write failing test**

```typescript
// src/schemas/__tests__/github-pr.schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  PRRequestSchema,
  PRResponseSchema,
  CodeChangeSchema,
  type PRRequest,
  type PRResponse,
  type CodeChange,
} from '../github-pr.schema.js';

describe('GitHub PR Schema', () => {
  it('should validate PRRequest', () => {
    const request: PRRequest = {
      systemCode: 'vendor-abc',
      title: 'fix(vendor-abc): update search API endpoint',
      body: '## Summary\n- API endpoint changed',
      branch: 'fix/vendor-abc-api-change',
      baseBranch: 'main',
      codeChanges: [
        {
          filePath: 'src/vendors/vendor-abc/search.ts',
          changeType: 'modify',
          oldContent: 'const endpoint = "/api/v1/search"',
          newContent: 'const endpoint = "/api/v2/search"',
          lineStart: 15,
          lineEnd: 15,
        },
      ],
      metadata: {
        diagnosisType: 'SIGNATURE_CHANGED',
        changeType: 'api',
        confidence: 0.95,
      },
    };
    expect(() => PRRequestSchema.parse(request)).not.toThrow();
  });

  it('should validate PRResponse', () => {
    const response: PRResponse = {
      success: true,
      prNumber: 123,
      prUrl: 'https://github.com/org/repo/pull/123',
      branchName: 'fix/vendor-abc-api-change',
      createdAt: '2026-01-28T10:00:00Z',
    };
    expect(() => PRResponseSchema.parse(response)).not.toThrow();
  });

  it('should validate CodeChange', () => {
    const change: CodeChange = {
      filePath: 'src/vendors/vendor-abc/config.ts',
      changeType: 'modify',
      oldContent: 'selector: "#old-input"',
      newContent: 'selector: "#new-input"',
      lineStart: 42,
      lineEnd: 42,
    };
    expect(() => CodeChangeSchema.parse(change)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/schemas/__tests__/github-pr.schema.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Implement schema**

```typescript
// src/schemas/github-pr.schema.ts
import { z } from 'zod';

/**
 * Represents a single code change within a file
 */
export const CodeChangeSchema = z.object({
  filePath: z.string().describe('Relative path from repo root'),
  changeType: z.enum(['create', 'modify', 'delete']),
  oldContent: z.string().optional().describe('Original content (for modify/delete)'),
  newContent: z.string().describe('New content (for create/modify)'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  description: z.string().optional().describe('Human-readable change description'),
});

export type CodeChange = z.infer<typeof CodeChangeSchema>;

/**
 * Request to create a GitHub PR
 */
export const PRRequestSchema = z.object({
  systemCode: z.string().describe('Vendor system code'),
  title: z.string().max(100).describe('PR title (max 100 chars)'),
  body: z.string().describe('PR body in markdown'),
  branch: z.string().describe('New branch name'),
  baseBranch: z.string().default('main'),
  codeChanges: z.array(CodeChangeSchema).min(1),
  metadata: z.object({
    diagnosisType: z.enum([
      'SIGNATURE_CHANGED',
      'FORM_CHANGED',
      'API_CHANGED',
    ]),
    changeType: z.enum(['dom', 'api', 'both']),
    confidence: z.number().min(0).max(1),
    capturedApiSchema: z.any().optional(),
    breakingChanges: z.array(z.string()).optional(),
  }),
  isDraft: z.boolean().default(true),
});

export type PRRequest = z.infer<typeof PRRequestSchema>;

/**
 * Response from GitHub PR creation
 */
export const PRResponseSchema = z.object({
  success: z.boolean(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  branchName: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export type PRResponse = z.infer<typeof PRResponseSchema>;

/**
 * Code generation request
 */
export const CodeGenRequestSchema = z.object({
  systemCode: z.string(),
  changeType: z.enum(['dom', 'api', 'both']),
  changes: z.array(z.string()).describe('List of detected changes'),
  capturedApiSchema: z.object({
    endpoint: z.string(),
    method: z.string(),
    params: z.record(z.string()).optional(),
    requestBody: z.any().optional(),
    responseSchema: z.any().optional(),
  }).optional(),
  existingSpec: z.any().optional(),
  batchCodePath: z.string().optional().describe('Path to existing batch code'),
});

export type CodeGenRequest = z.infer<typeof CodeGenRequestSchema>;

/**
 * Code generation result
 */
export const CodeGenResultSchema = z.object({
  success: z.boolean(),
  codeChanges: z.array(CodeChangeSchema),
  specUpdate: z.any().optional().describe('Updated spec to save'),
  summary: z.string(),
  error: z.string().optional(),
});

export type CodeGenResult = z.infer<typeof CodeGenResultSchema>;
```

**Step 4: Export from index**

```typescript
// src/schemas/index.ts - add line
export * from './github-pr.schema.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/schemas/__tests__/github-pr.schema.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/schemas/github-pr.schema.ts src/schemas/index.ts src/schemas/__tests__/github-pr.schema.test.ts
git commit -m "feat(schemas): add GitHub PR and code generation schemas"
```

---

## Task 3: Code Generator Module

**Files:**
- Create: `src/code-generator/index.ts`
- Create: `src/code-generator/templates.ts`
- Test: `src/code-generator/__tests__/code-generator.test.ts`

**Step 1: Write failing test**

```typescript
// src/code-generator/__tests__/code-generator.test.ts
import { describe, it, expect } from 'vitest';
import { CodeGenerator } from '../index.js';
import type { CodeGenRequest } from '../../schemas/index.js';

describe('CodeGenerator', () => {
  const generator = new CodeGenerator();

  it('should generate code changes for API endpoint change', async () => {
    const request: CodeGenRequest = {
      systemCode: 'humax-parcs',
      changeType: 'api',
      changes: ['API 엔드포인트 변경: /in.store/{{siteId}} -> /o.traffic/{{siteId}}'],
      capturedApiSchema: {
        endpoint: '/o.traffic/{{siteId}}',
        method: 'GET',
        params: {
          sortBy: 'string',
          searchType: 'string',
          plateNumber: 'string',
        },
      },
      batchCodePath: 'src/vendors/humax-parcs/search.ts',
    };

    const result = await generator.generate(request);

    expect(result.success).toBe(true);
    expect(result.codeChanges.length).toBeGreaterThan(0);
    expect(result.codeChanges[0].changeType).toBe('modify');
    expect(result.summary).toContain('endpoint');
  });

  it('should generate code changes for DOM selector change', async () => {
    const request: CodeGenRequest = {
      systemCode: 'vendor-abc',
      changeType: 'dom',
      changes: ['검색 입력 셀렉터 변경: #carNo -> #vehicleNumber'],
      existingSpec: {
        form: {
          searchInputSelector: '#carNo',
          searchButtonSelector: '#searchBtn',
        },
      },
      batchCodePath: 'src/vendors/vendor-abc/search.ts',
    };

    const result = await generator.generate(request);

    expect(result.success).toBe(true);
    expect(result.codeChanges.length).toBeGreaterThan(0);
  });

  it('should return error for unsupported change type', async () => {
    const request: CodeGenRequest = {
      systemCode: 'unknown',
      changeType: 'both',
      changes: ['Complex mixed change'],
    };

    const result = await generator.generate(request);

    // 'both' type requires manual review
    expect(result.success).toBe(false);
    expect(result.error).toContain('manual');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/code-generator/__tests__/code-generator.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Create templates module**

```typescript
// src/code-generator/templates.ts

/**
 * Template for API endpoint change in batch code
 */
export function generateApiEndpointChange(
  oldEndpoint: string,
  newEndpoint: string,
  method: string = 'GET'
): string {
  return `// Updated API endpoint
const SEARCH_ENDPOINT = '${newEndpoint}';
const SEARCH_METHOD = '${method}';`;
}

/**
 * Template for DOM selector change in batch code
 */
export function generateSelectorChange(
  selectorType: 'input' | 'button' | 'form',
  oldSelector: string,
  newSelector: string
): string {
  const varName = {
    input: 'SEARCH_INPUT_SELECTOR',
    button: 'SEARCH_BUTTON_SELECTOR',
    form: 'SEARCH_FORM_SELECTOR',
  }[selectorType];

  return `// Updated ${selectorType} selector
const ${varName} = '${newSelector}';`;
}

/**
 * Generate PR body template
 */
export function generatePRBody(
  systemCode: string,
  changeType: 'dom' | 'api' | 'both',
  changes: string[],
  confidence: number,
  capturedApiSchema?: any
): string {
  const changeList = changes.map(c => `- ${c}`).join('\n');

  let body = `## Summary

자동 감지된 ${changeType.toUpperCase()} 시그니처 변경에 대한 수정 코드입니다.

### 감지된 변경 사항
${changeList}

### 신뢰도
${Math.round(confidence * 100)}%
`;

  if (capturedApiSchema) {
    body += `
### 캡처된 API 스키마
\`\`\`json
${JSON.stringify(capturedApiSchema, null, 2)}
\`\`\`
`;
  }

  body += `
## Test Plan

- [ ] 테스트 차량으로 로그인 → 검색 → 할인적용 플로우 검증
- [ ] 기존 배치와 동일 결과 확인
- [ ] 에러 로그 모니터링

---
> 이 PR은 web-analysis-agent에 의해 자동 생성되었습니다.
`;

  return body;
}

/**
 * Generate PR title
 */
export function generatePRTitle(
  systemCode: string,
  changeType: 'dom' | 'api' | 'both'
): string {
  const typeLabel = {
    dom: 'DOM selector',
    api: 'API endpoint',
    both: 'UI/API signature',
  }[changeType];

  return `fix(${systemCode}): update ${typeLabel}`;
}

/**
 * Generate branch name
 */
export function generateBranchName(systemCode: string): string {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `fix/${systemCode}-signature-${timestamp}`;
}
```

**Step 4: Implement CodeGenerator**

```typescript
// src/code-generator/index.ts
import type { CodeGenRequest, CodeGenResult, CodeChange } from '../schemas/index.js';
import {
  generateApiEndpointChange,
  generateSelectorChange,
  generatePRBody,
  generatePRTitle,
  generateBranchName,
} from './templates.js';

export class CodeGenerator {
  /**
   * Generate code changes based on detected spec changes.
   *
   * This is a template-based generator. For complex changes,
   * it returns success=false with a suggestion for manual review.
   */
  async generate(request: CodeGenRequest): Promise<CodeGenResult> {
    const { systemCode, changeType, changes, capturedApiSchema, existingSpec, batchCodePath } = request;

    // 'both' type requires manual review (too complex for auto-gen)
    if (changeType === 'both') {
      return {
        success: false,
        codeChanges: [],
        summary: 'DOM과 API 동시 변경은 수동 검토가 필요합니다.',
        error: 'Complex changes require manual review',
      };
    }

    const codeChanges: CodeChange[] = [];

    try {
      if (changeType === 'api' && capturedApiSchema) {
        // API endpoint change
        const apiChange = this.generateApiChange(
          systemCode,
          capturedApiSchema,
          changes,
          batchCodePath
        );
        if (apiChange) {
          codeChanges.push(apiChange);
        }
      } else if (changeType === 'dom' && existingSpec) {
        // DOM selector change
        const domChanges = this.generateDomChanges(
          systemCode,
          existingSpec,
          changes,
          batchCodePath
        );
        codeChanges.push(...domChanges);
      }

      if (codeChanges.length === 0) {
        return {
          success: false,
          codeChanges: [],
          summary: '변경 사항에서 코드를 생성할 수 없습니다.',
          error: 'Could not generate code from detected changes',
        };
      }

      // Generate spec update
      const specUpdate = this.generateSpecUpdate(
        systemCode,
        changeType,
        capturedApiSchema,
        existingSpec
      );

      return {
        success: true,
        codeChanges,
        specUpdate,
        summary: `${changeType.toUpperCase()} 변경에 대한 ${codeChanges.length}개의 코드 수정 생성됨`,
      };
    } catch (e) {
      return {
        success: false,
        codeChanges: [],
        summary: `코드 생성 실패: ${(e as Error).message}`,
        error: (e as Error).message,
      };
    }
  }

  private generateApiChange(
    systemCode: string,
    capturedApiSchema: NonNullable<CodeGenRequest['capturedApiSchema']>,
    changes: string[],
    batchCodePath?: string
  ): CodeChange | null {
    const { endpoint, method, params } = capturedApiSchema;

    // Generate the new code
    const newContent = generateApiEndpointChange(
      '', // Old endpoint extracted from change message
      endpoint,
      method
    );

    // Generate params update if available
    let paramsContent = '';
    if (params && Object.keys(params).length > 0) {
      paramsContent = `\n\n// Updated search parameters\nconst SEARCH_PARAMS = ${JSON.stringify(params, null, 2)};`;
    }

    const filePath = batchCodePath || `src/vendors/${systemCode}/search.ts`;

    return {
      filePath,
      changeType: 'modify',
      newContent: newContent + paramsContent,
      description: `API endpoint updated to ${method} ${endpoint}`,
    };
  }

  private generateDomChanges(
    systemCode: string,
    existingSpec: any,
    changes: string[],
    batchCodePath?: string
  ): CodeChange[] {
    const codeChanges: CodeChange[] = [];

    for (const change of changes) {
      // Parse selector change from message
      // Format: "검색 입력 셀렉터 변경: #old -> #new"
      const selectorMatch = change.match(/셀렉터 변경:\s*([^\s]+)\s*(?:→|->)\s*([^\s]+)/);
      if (selectorMatch) {
        const [, oldSelector, newSelector] = selectorMatch;
        const type = change.includes('입력') ? 'input' :
                    change.includes('버튼') ? 'button' : 'form';

        const newContent = generateSelectorChange(type, oldSelector, newSelector);

        codeChanges.push({
          filePath: batchCodePath || `src/vendors/${systemCode}/search.ts`,
          changeType: 'modify',
          oldContent: `'${oldSelector}'`,
          newContent: `'${newSelector}'`,
          description: `${type} selector updated: ${oldSelector} -> ${newSelector}`,
        });
      }
    }

    return codeChanges;
  }

  private generateSpecUpdate(
    systemCode: string,
    changeType: 'dom' | 'api',
    capturedApiSchema?: any,
    existingSpec?: any
  ): any {
    const now = new Date().toISOString();
    const baseSpec = existingSpec || { systemCode, version: 0 };

    if (changeType === 'api' && capturedApiSchema) {
      return {
        ...baseSpec,
        api: {
          endpoint: capturedApiSchema.endpoint,
          method: capturedApiSchema.method,
          params: capturedApiSchema.params,
          responseSchema: capturedApiSchema.responseSchema,
        },
        searchType: 'api',
        updatedAt: now,
        version: (baseSpec.version || 0) + 1,
      };
    }

    return {
      ...baseSpec,
      updatedAt: now,
      version: (baseSpec.version || 0) + 1,
    };
  }
}

// Export templates for use in other modules
export * from './templates.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/code-generator/__tests__/code-generator.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/code-generator/
git commit -m "feat(code-generator): add template-based code generation"
```

---

## Task 4: GitHub Dispatcher

**Files:**
- Create: `src/dispatcher/github-dispatcher.ts`
- Test: `src/dispatcher/__tests__/github-dispatcher.test.ts`

**Step 1: Write failing test**

```typescript
// src/dispatcher/__tests__/github-dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubDispatcher } from '../github-dispatcher.js';
import type { PRRequest } from '../../schemas/index.js';

describe('GitHubDispatcher', () => {
  it('should create instance with token', () => {
    const dispatcher = new GitHubDispatcher({
      token: 'mock-token',
      owner: 'test-org',
      repo: 'test-repo',
    });
    expect(dispatcher).toBeDefined();
  });

  it('should mock PR creation in mock mode', async () => {
    const dispatcher = new GitHubDispatcher({
      token: 'mock',
      owner: 'test-org',
      repo: 'test-repo',
    });

    const request: PRRequest = {
      systemCode: 'vendor-abc',
      title: 'fix(vendor-abc): update API endpoint',
      body: '## Summary\nTest PR',
      branch: 'fix/vendor-abc-api',
      baseBranch: 'main',
      codeChanges: [
        {
          filePath: 'src/vendors/vendor-abc/search.ts',
          changeType: 'modify',
          newContent: 'const ENDPOINT = "/api/v2"',
        },
      ],
      metadata: {
        diagnosisType: 'SIGNATURE_CHANGED',
        changeType: 'api',
        confidence: 0.95,
      },
    };

    const response = await dispatcher.createPR(request);

    expect(response.success).toBe(true);
    expect(response.prNumber).toBeDefined();
    expect(response.prUrl).toContain('mock');
    expect(response.branchName).toBe('fix/vendor-abc-api');
  });

  it('should validate PR request', async () => {
    const dispatcher = new GitHubDispatcher({
      token: 'mock',
      owner: 'test-org',
      repo: 'test-repo',
    });

    const invalidRequest = {
      systemCode: 'test',
      title: 'test',
      // Missing required fields
    } as PRRequest;

    const response = await dispatcher.createPR(invalidRequest);
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/dispatcher/__tests__/github-dispatcher.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Implement GitHubDispatcher**

```typescript
// src/dispatcher/github-dispatcher.ts
import { Octokit } from '@octokit/rest';
import {
  PRRequestSchema,
  type PRRequest,
  type PRResponse,
} from '../schemas/index.js';

export interface GitHubDispatcherConfig {
  token: string;
  owner: string;
  repo: string;
}

export class GitHubDispatcher {
  private octokit: Octokit | null = null;
  private isMock: boolean;
  private owner: string;
  private repo: string;

  constructor(config: GitHubDispatcherConfig) {
    this.isMock = config.token === 'mock';
    this.owner = config.owner;
    this.repo = config.repo;

    if (!this.isMock) {
      this.octokit = new Octokit({ auth: config.token });
    }
  }

  /**
   * Create a Draft PR with code changes
   */
  async createPR(request: PRRequest): Promise<PRResponse> {
    // Validate request
    const validation = PRRequestSchema.safeParse(request);
    if (!validation.success) {
      return {
        success: false,
        error: `Invalid PR request: ${validation.error.message}`,
      };
    }

    const { title, body, branch, baseBranch, codeChanges, isDraft } = request;

    if (this.isMock) {
      return this.mockCreatePR(request);
    }

    try {
      // 1. Get base branch SHA
      const { data: baseRef } = await this.octokit!.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${baseBranch}`,
      });
      const baseSha = baseRef.object.sha;

      // 2. Create new branch
      await this.octokit!.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });

      // 3. Commit file changes
      for (const change of codeChanges) {
        if (change.changeType === 'delete') {
          await this.octokit!.repos.deleteFile({
            owner: this.owner,
            repo: this.repo,
            path: change.filePath,
            message: `chore: delete ${change.filePath}`,
            branch,
            sha: await this.getFileSha(change.filePath, branch),
          });
        } else {
          // Create or update file
          const existingSha = await this.getFileSha(change.filePath, branch).catch(() => undefined);

          await this.octokit!.repos.createOrUpdateFileContents({
            owner: this.owner,
            repo: this.repo,
            path: change.filePath,
            message: change.description || `fix: update ${change.filePath}`,
            content: Buffer.from(change.newContent).toString('base64'),
            branch,
            ...(existingSha && { sha: existingSha }),
          });
        }
      }

      // 4. Create Pull Request
      const { data: pr } = await this.octokit!.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        head: branch,
        base: baseBranch,
        draft: isDraft ?? true,
      });

      console.log(`[GitHubDispatcher] Created PR #${pr.number}: ${pr.html_url}`);

      return {
        success: true,
        prNumber: pr.number,
        prUrl: pr.html_url,
        branchName: branch,
        createdAt: pr.created_at,
      };
    } catch (e) {
      const error = e as Error;
      console.error(`[GitHubDispatcher] Failed to create PR: ${error.message}`);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async getFileSha(filePath: string, branch: string): Promise<string> {
    const { data } = await this.octokit!.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path: filePath,
      ref: branch,
    });

    if (Array.isArray(data)) {
      throw new Error(`${filePath} is a directory`);
    }

    return data.sha;
  }

  private mockCreatePR(request: PRRequest): PRResponse {
    const mockPrNumber = Math.floor(Math.random() * 1000) + 1;
    const mockUrl = `https://github.com/${this.owner}/${this.repo}/pull/${mockPrNumber}?mock=true`;

    console.log(`[MOCK GITHUB] Would create PR:`);
    console.log(`  Title: ${request.title}`);
    console.log(`  Branch: ${request.branch} -> ${request.baseBranch}`);
    console.log(`  Files: ${request.codeChanges.map(c => c.filePath).join(', ')}`);
    console.log(`  Draft: ${request.isDraft ?? true}`);

    return {
      success: true,
      prNumber: mockPrNumber,
      prUrl: mockUrl,
      branchName: request.branch,
      createdAt: new Date().toISOString(),
    };
  }
}
```

**Step 4: Export from dispatcher index**

```typescript
// src/dispatcher/index.ts
export * from './slack-dispatcher.js';
export * from './github-dispatcher.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/dispatcher/__tests__/github-dispatcher.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/dispatcher/github-dispatcher.ts src/dispatcher/index.ts src/dispatcher/__tests__/github-dispatcher.test.ts
git commit -m "feat(dispatcher): add GitHub PR dispatcher with Octokit"
```

---

## Task 5: Slack Dispatcher Enhancement (PR Link)

**Files:**
- Modify: `src/dispatcher/slack-dispatcher.ts`
- Test: Update existing test

**Step 1: Add sendPRNotification method**

```typescript
// Add to src/dispatcher/slack-dispatcher.ts

/**
 * Send notification with PR link
 */
async sendPRNotification(
  systemCode: string,
  prUrl: string,
  prNumber: number,
  summary: string
): Promise<void> {
  const messageText = `:rocket: *[${systemCode}]* Draft PR 생성됨\n` +
    `> ${summary}\n` +
    `:link: <${prUrl}|PR #${prNumber} 바로가기>`;

  if (this.isMock) {
    console.log(`[MOCK SLACK] ${messageText}`);
    return;
  }

  const message = { text: messageText };

  const response = await fetch(this.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
}

/**
 * Send analysis complete notification with optional PR link
 */
async sendAnalysisComplete(
  systemCode: string,
  status: string,
  summary: string,
  prInfo?: { url: string; number: number }
): Promise<void> {
  let messageText = `:white_check_mark: *[${systemCode}]* 분석 완료\n` +
    `> 상태: ${status}\n` +
    `> ${summary}`;

  if (prInfo) {
    messageText += `\n:link: <${prInfo.url}|Draft PR #${prInfo.number}>`;
  }

  if (this.isMock) {
    console.log(`[MOCK SLACK] ${messageText}`);
    return;
  }

  const message = { text: messageText };

  const response = await fetch(this.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
}
```

**Step 2: Update test**

```typescript
// Add to src/dispatcher/__tests__/slack-dispatcher.test.ts

it('should send PR notification in mock mode', async () => {
  const consoleSpy = vi.spyOn(console, 'log');
  const dispatcher = new SlackDispatcher('mock');

  await dispatcher.sendPRNotification(
    'vendor-abc',
    'https://github.com/org/repo/pull/123',
    123,
    'API endpoint 변경 감지'
  );

  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('Draft PR 생성됨')
  );
});

it('should send analysis complete with PR link', async () => {
  const consoleSpy = vi.spyOn(console, 'log');
  const dispatcher = new SlackDispatcher('mock');

  await dispatcher.sendAnalysisComplete(
    'vendor-abc',
    'SIGNATURE_CHANGED',
    '검색 API 엔드포인트 변경',
    { url: 'https://github.com/org/repo/pull/123', number: 123 }
  );

  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('Draft PR #123')
  );
});
```

**Step 3: Run tests**

Run: `pnpm test:run src/dispatcher/__tests__/slack-dispatcher.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/dispatcher/slack-dispatcher.ts src/dispatcher/__tests__/slack-dispatcher.test.ts
git commit -m "feat(slack): add PR notification methods"
```

---

## Task 6: Action Orchestrator

**Files:**
- Create: `src/orchestrator/action-orchestrator.ts`
- Create: `src/orchestrator/index.ts`
- Test: `src/orchestrator/__tests__/action-orchestrator.test.ts`

**Step 1: Write failing test**

```typescript
// src/orchestrator/__tests__/action-orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ActionOrchestrator } from '../action-orchestrator.js';
import type { SearchResult } from '../../schemas/index.js';

describe('ActionOrchestrator', () => {
  it('should trigger PR creation for SIGNATURE_CHANGED with codeWillBreak', async () => {
    const mockSlack = {
      sendDiagnosis: vi.fn(),
      sendPRNotification: vi.fn(),
      sendAnalysisComplete: vi.fn(),
    };
    const mockGitHub = {
      createPR: vi.fn().mockResolvedValue({
        success: true,
        prNumber: 123,
        prUrl: 'https://github.com/org/repo/pull/123',
        branchName: 'fix/vendor-abc-api',
      }),
    };
    const mockCodeGen = {
      generate: vi.fn().mockResolvedValue({
        success: true,
        codeChanges: [{ filePath: 'test.ts', changeType: 'modify', newContent: 'new' }],
        summary: 'API endpoint updated',
      }),
    };

    const orchestrator = new ActionOrchestrator({
      slackDispatcher: mockSlack as any,
      githubDispatcher: mockGitHub as any,
      codeGenerator: mockCodeGen as any,
    });

    const searchResult: SearchResult = {
      status: 'SUCCESS',
      confidence: 0.95,
      details: {
        vehicleFound: true,
        searchMethod: 'api',
        resultCount: 1,
      },
      changes: {
        hasChanges: true,
        codeWillBreak: true,
        breakingChanges: ['API endpoint changed'],
        summary: 'API endpoint changed',
      },
      timestamp: new Date().toISOString(),
    };

    const result = await orchestrator.processSearchResult('vendor-abc', searchResult, {
      capturedApiSchema: { endpoint: '/new/api', method: 'GET' },
    });

    expect(result.prCreated).toBe(true);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/123');
    expect(mockCodeGen.generate).toHaveBeenCalled();
    expect(mockGitHub.createPR).toHaveBeenCalled();
    expect(mockSlack.sendAnalysisComplete).toHaveBeenCalled();
  });

  it('should only send Slack notification for non-breaking changes', async () => {
    const mockSlack = {
      sendDiagnosis: vi.fn(),
      sendAnalysisComplete: vi.fn(),
    };
    const mockGitHub = { createPR: vi.fn() };
    const mockCodeGen = { generate: vi.fn() };

    const orchestrator = new ActionOrchestrator({
      slackDispatcher: mockSlack as any,
      githubDispatcher: mockGitHub as any,
      codeGenerator: mockCodeGen as any,
    });

    const searchResult: SearchResult = {
      status: 'SUCCESS',
      confidence: 0.95,
      details: {
        vehicleFound: true,
        searchMethod: 'api',
        resultCount: 1,
      },
      changes: {
        hasChanges: false,
        codeWillBreak: false,
      },
      timestamp: new Date().toISOString(),
    };

    const result = await orchestrator.processSearchResult('vendor-abc', searchResult);

    expect(result.prCreated).toBe(false);
    expect(mockCodeGen.generate).not.toHaveBeenCalled();
    expect(mockGitHub.createPR).not.toHaveBeenCalled();
    expect(mockSlack.sendAnalysisComplete).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:run src/orchestrator/__tests__/action-orchestrator.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Implement ActionOrchestrator**

```typescript
// src/orchestrator/action-orchestrator.ts
import type { SlackDispatcher } from '../dispatcher/slack-dispatcher.js';
import type { GitHubDispatcher } from '../dispatcher/github-dispatcher.js';
import type { CodeGenerator } from '../code-generator/index.js';
import type { SearchResult, CodeGenRequest, PRRequest } from '../schemas/index.js';
import { generatePRBody, generatePRTitle, generateBranchName } from '../code-generator/templates.js';

export interface ActionOrchestratorConfig {
  slackDispatcher: SlackDispatcher;
  githubDispatcher: GitHubDispatcher;
  codeGenerator: CodeGenerator;
}

export interface ProcessResult {
  prCreated: boolean;
  prUrl?: string;
  prNumber?: number;
  slackNotified: boolean;
  specUpdated: boolean;
  error?: string;
}

export class ActionOrchestrator {
  private slack: SlackDispatcher;
  private github: GitHubDispatcher;
  private codeGen: CodeGenerator;

  constructor(config: ActionOrchestratorConfig) {
    this.slack = config.slackDispatcher;
    this.github = config.githubDispatcher;
    this.codeGen = config.codeGenerator;
  }

  /**
   * Process search result and trigger appropriate actions:
   * - SIGNATURE_CHANGED + codeWillBreak → Generate code → Create PR → Slack
   * - Other cases → Slack notification only
   */
  async processSearchResult(
    systemCode: string,
    result: SearchResult,
    extra?: {
      capturedApiSchema?: any;
      existingSpec?: any;
      batchCodePath?: string;
    }
  ): Promise<ProcessResult> {
    const changes = result.changes;
    const shouldCreatePR = changes?.hasChanges && changes?.codeWillBreak;

    if (!shouldCreatePR) {
      // No breaking changes - just notify
      await this.slack.sendAnalysisComplete(
        systemCode,
        result.status,
        this.getSummary(result)
      );

      return {
        prCreated: false,
        slackNotified: true,
        specUpdated: false,
      };
    }

    // Breaking changes detected - generate code and create PR
    try {
      const changeType = this.inferChangeType(result);

      // 1. Generate code
      const codeGenRequest: CodeGenRequest = {
        systemCode,
        changeType,
        changes: changes.breakingChanges || [],
        capturedApiSchema: extra?.capturedApiSchema,
        existingSpec: extra?.existingSpec,
        batchCodePath: extra?.batchCodePath,
      };

      const codeGenResult = await this.codeGen.generate(codeGenRequest);

      if (!codeGenResult.success) {
        // Code generation failed - notify and suggest manual review
        await this.slack.sendAnalysisComplete(
          systemCode,
          'SIGNATURE_CHANGED',
          `코드 자동 생성 실패: ${codeGenResult.error}. 수동 검토 필요.`
        );

        return {
          prCreated: false,
          slackNotified: true,
          specUpdated: false,
          error: codeGenResult.error,
        };
      }

      // 2. Create PR
      const prRequest: PRRequest = {
        systemCode,
        title: generatePRTitle(systemCode, changeType),
        body: generatePRBody(
          systemCode,
          changeType,
          changes.breakingChanges || [],
          result.confidence,
          extra?.capturedApiSchema
        ),
        branch: generateBranchName(systemCode),
        baseBranch: 'main',
        codeChanges: codeGenResult.codeChanges,
        metadata: {
          diagnosisType: 'SIGNATURE_CHANGED',
          changeType,
          confidence: result.confidence,
          capturedApiSchema: extra?.capturedApiSchema,
          breakingChanges: changes.breakingChanges,
        },
        isDraft: true,
      };

      const prResponse = await this.github.createPR(prRequest);

      if (!prResponse.success) {
        await this.slack.sendAnalysisComplete(
          systemCode,
          'SIGNATURE_CHANGED',
          `PR 생성 실패: ${prResponse.error}. 수동 검토 필요.`
        );

        return {
          prCreated: false,
          slackNotified: true,
          specUpdated: false,
          error: prResponse.error,
        };
      }

      // 3. Notify Slack with PR link
      await this.slack.sendAnalysisComplete(
        systemCode,
        'SIGNATURE_CHANGED',
        codeGenResult.summary,
        { url: prResponse.prUrl!, number: prResponse.prNumber! }
      );

      return {
        prCreated: true,
        prUrl: prResponse.prUrl,
        prNumber: prResponse.prNumber,
        slackNotified: true,
        specUpdated: !!codeGenResult.specUpdate,
      };
    } catch (e) {
      const error = (e as Error).message;

      await this.slack.sendAnalysisComplete(
        systemCode,
        'SIGNATURE_CHANGED',
        `처리 중 오류: ${error}`
      );

      return {
        prCreated: false,
        slackNotified: true,
        specUpdated: false,
        error,
      };
    }
  }

  private inferChangeType(result: SearchResult): 'dom' | 'api' | 'both' {
    const searchMethod = result.details.searchMethod;
    if (searchMethod === 'api') return 'api';
    if (searchMethod === 'dom') return 'dom';
    return 'both';
  }

  private getSummary(result: SearchResult): string {
    if (result.status === 'SUCCESS') {
      return result.vehicle
        ? `차량 검색 성공: ${result.vehicle.plateNumber}`
        : '차량 검색 성공';
    }
    if (result.status === 'NOT_FOUND') {
      return '입차 기록 없음 (정상)';
    }
    return result.details.errorMessage || `상태: ${result.status}`;
  }
}
```

**Step 4: Create index export**

```typescript
// src/orchestrator/index.ts
export * from './action-orchestrator.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test:run src/orchestrator/__tests__/action-orchestrator.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/orchestrator/
git commit -m "feat(orchestrator): add action orchestrator for PR workflow"
```

---

## Task 7: CLI Integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

**Step 1: Add orchestrator commands to CLI**

```typescript
// Add to src/cli.ts (after existing imports)
import { ActionOrchestrator } from './orchestrator/index.js';
import { GitHubDispatcher } from './dispatcher/github-dispatcher.js';
import { CodeGenerator } from './code-generator/index.js';

// Add new command handler in the switch statement
case 'full-analysis':
  await runFullAnalysisCommand(inputFile);
  break;

// Add the function
async function runFullAnalysisCommand(inputFile: string) {
  const input = JSON.parse(readFileSync(inputFile, 'utf-8'));

  // 1. Run LoginGraph
  console.log('=== Phase 1: Login ===');
  const loginGraph = new LoginGraph({
    systemCode: input.systemCode,
    url: input.url,
    credentials: { id: input.id, pwd: input.pwd },
    specStore,
    llm: createLLM(),
  });

  const loginResult = await loginGraph.run();

  if (loginResult.result.status !== 'SUCCESS') {
    console.log('Login failed:', loginResult.result);
    const dispatcher = new SlackDispatcher(process.env.SLACK_WEBHOOK_URL || 'mock');
    await dispatcher.sendAnalysisComplete(
      input.systemCode,
      loginResult.result.status,
      loginResult.result.details?.errorMessage || 'Login failed'
    );
    return;
  }

  console.log('Login successful');

  // 2. Run SearchGraph
  console.log('\n=== Phase 2: Search ===');
  const searchGraph = new SearchGraph({
    systemCode: input.systemCode,
    url: input.url,
    carNum: input.carNum,
    session: loginResult.result.session!,
    specStore,
    llm: createLLM(),
    mcpClient: loginGraph.getMcpClient(),
  });

  const searchResult = await searchGraph.run();
  console.log('Search result:', searchResult.result.status);

  // 3. Process with ActionOrchestrator
  console.log('\n=== Phase 3: Action Dispatch ===');
  const orchestrator = new ActionOrchestrator({
    slackDispatcher: new SlackDispatcher(process.env.SLACK_WEBHOOK_URL || 'mock'),
    githubDispatcher: new GitHubDispatcher({
      token: process.env.GITHUB_TOKEN || 'mock',
      owner: process.env.GITHUB_OWNER || 'your-org',
      repo: process.env.GITHUB_REPO || 'batch-repo',
    }),
    codeGenerator: new CodeGenerator(),
  });

  const processResult = await orchestrator.processSearchResult(
    input.systemCode,
    searchResult.result,
    {
      capturedApiSchema: searchResult.result.changes?.hasChanges
        ? (searchGraph as any).getState()?.specChanges?.capturedApiSchema
        : undefined,
      existingSpec: searchResult.spec,
    }
  );

  console.log('\n=== Result ===');
  console.log('PR Created:', processResult.prCreated);
  if (processResult.prUrl) {
    console.log('PR URL:', processResult.prUrl);
  }
  console.log('Slack Notified:', processResult.slackNotified);
}
```

**Step 2: Add npm script**

```json
// Add to package.json scripts
"agent:full": "tsx src/cli.ts full-analysis"
```

**Step 3: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat(cli): add full-analysis command with PR automation"
```

---

## Task 8: Environment Configuration

**Files:**
- Modify: `.env.example`

**Step 1: Add GitHub environment variables**

```bash
# .env.example - add these lines

# GitHub PR Creation
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_OWNER=your-org
GITHUB_REPO=batch-repo

# Slack Notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/xxx/xxx
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add GitHub and Slack env vars to example"
```

---

## Task 9: Integration Test

**Files:**
- Create: `src/__tests__/phase2-integration.test.ts`

**Step 1: Write integration test**

```typescript
// src/__tests__/phase2-integration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionOrchestrator } from '../orchestrator/index.js';
import { CodeGenerator } from '../code-generator/index.js';
import type { SearchResult } from '../schemas/index.js';

describe('Phase 2 Integration', () => {
  const mockSlack = {
    sendDiagnosis: vi.fn(),
    sendPRNotification: vi.fn(),
    sendAnalysisComplete: vi.fn(),
  };

  const mockGitHub = {
    createPR: vi.fn().mockResolvedValue({
      success: true,
      prNumber: 42,
      prUrl: 'https://github.com/test/repo/pull/42',
      branchName: 'fix/test-vendor',
      createdAt: new Date().toISOString(),
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete full flow: detect change -> generate code -> create PR -> notify', async () => {
    const orchestrator = new ActionOrchestrator({
      slackDispatcher: mockSlack as any,
      githubDispatcher: mockGitHub as any,
      codeGenerator: new CodeGenerator(),
    });

    const searchResult: SearchResult = {
      status: 'SUCCESS',
      confidence: 0.92,
      details: {
        vehicleFound: true,
        searchMethod: 'api',
        resultCount: 1,
      },
      vehicle: {
        id: 'v123',
        plateNumber: '12가3456',
        inTime: '2026-01-28T10:00:00Z',
      },
      changes: {
        hasChanges: true,
        codeWillBreak: true,
        breakingChanges: [
          'API 엔드포인트 변경: /in.store/{{siteId}} -> /o.traffic/{{siteId}}',
        ],
        summary: 'Search API endpoint changed',
      },
      timestamp: new Date().toISOString(),
    };

    const result = await orchestrator.processSearchResult(
      'humax-parcs',
      searchResult,
      {
        capturedApiSchema: {
          endpoint: '/o.traffic/{{siteId}}',
          method: 'GET',
          params: {
            plateNumber: 'string',
            searchType: 'string',
          },
        },
      }
    );

    // Verify PR was created
    expect(result.prCreated).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toContain('github.com');

    // Verify GitHub was called with correct params
    expect(mockGitHub.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        systemCode: 'humax-parcs',
        title: expect.stringContaining('humax-parcs'),
        isDraft: true,
        codeChanges: expect.arrayContaining([
          expect.objectContaining({
            changeType: 'modify',
          }),
        ]),
      })
    );

    // Verify Slack was notified with PR link
    expect(mockSlack.sendAnalysisComplete).toHaveBeenCalledWith(
      'humax-parcs',
      'SIGNATURE_CHANGED',
      expect.any(String),
      expect.objectContaining({
        url: expect.stringContaining('github.com'),
        number: 42,
      })
    );
  });

  it('should only notify Slack when no breaking changes', async () => {
    const orchestrator = new ActionOrchestrator({
      slackDispatcher: mockSlack as any,
      githubDispatcher: mockGitHub as any,
      codeGenerator: new CodeGenerator(),
    });

    const searchResult: SearchResult = {
      status: 'SUCCESS',
      confidence: 0.95,
      details: {
        vehicleFound: true,
        searchMethod: 'dom',
        resultCount: 1,
      },
      timestamp: new Date().toISOString(),
    };

    const result = await orchestrator.processSearchResult('vendor-abc', searchResult);

    expect(result.prCreated).toBe(false);
    expect(mockGitHub.createPR).not.toHaveBeenCalled();
    expect(mockSlack.sendAnalysisComplete).toHaveBeenCalledWith(
      'vendor-abc',
      'SUCCESS',
      expect.stringContaining('차량 검색 성공')
    );
  });

  it('should handle code generation failure gracefully', async () => {
    const failingCodeGen = {
      generate: vi.fn().mockResolvedValue({
        success: false,
        codeChanges: [],
        summary: '',
        error: 'Unsupported change pattern',
      }),
    };

    const orchestrator = new ActionOrchestrator({
      slackDispatcher: mockSlack as any,
      githubDispatcher: mockGitHub as any,
      codeGenerator: failingCodeGen as any,
    });

    const searchResult: SearchResult = {
      status: 'SUCCESS',
      confidence: 0.8,
      details: {
        vehicleFound: true,
        searchMethod: 'hybrid',
        resultCount: 1,
      },
      changes: {
        hasChanges: true,
        codeWillBreak: true,
        breakingChanges: ['Complex mixed change'],
      },
      timestamp: new Date().toISOString(),
    };

    const result = await orchestrator.processSearchResult('complex-vendor', searchResult);

    expect(result.prCreated).toBe(false);
    expect(result.error).toContain('Unsupported');
    expect(mockGitHub.createPR).not.toHaveBeenCalled();
    expect(mockSlack.sendAnalysisComplete).toHaveBeenCalledWith(
      'complex-vendor',
      'SIGNATURE_CHANGED',
      expect.stringContaining('수동 검토')
    );
  });
});
```

**Step 2: Run integration test**

Run: `pnpm test:run src/__tests__/phase2-integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/__tests__/phase2-integration.test.ts
git commit -m "test: add Phase 2 integration tests"
```

---

## Task 10: Update Documentation

**Files:**
- Modify: `HANDOFF.md`
- Modify: `CLAUDE.md`

**Step 1: Update HANDOFF.md**

Add to "현재 구현 상태" section:

```markdown
## 현재 구현 상태 (2026-01-28)

### Phase 2 MVP 완료 ✅

**자동 PR 생성 파이프라인:**
1. LoginGraph + SearchGraph로 사이트 분석
2. `specChanges.codeWillBreak` 감지 시 자동 트리거
3. CodeGenerator로 수정 코드 생성
4. GitHubDispatcher로 Draft PR 생성
5. SlackDispatcher로 PR 링크 포함 알림

**새 컴포넌트:**
- `src/code-generator/` - 템플릿 기반 코드 생성
- `src/dispatcher/github-dispatcher.ts` - Octokit 기반 PR 생성
- `src/orchestrator/` - 전체 플로우 조율

**CLI 사용법:**
\`\`\`bash
# 전체 플로우 실행 (로그인 → 검색 → PR 생성)
pnpm agent:full inputs/humax-normal.json

# 환경 변수 설정 필요
GITHUB_TOKEN=ghp_xxx
GITHUB_OWNER=your-org
GITHUB_REPO=batch-repo
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
\`\`\`
```

**Step 2: Commit**

```bash
git add HANDOFF.md CLAUDE.md
git commit -m "docs: update handoff with Phase 2 completion"
```

---

## Summary

### Implemented Components

| Component | Path | Purpose |
|-----------|------|---------|
| PR Schema | `src/schemas/github-pr.schema.ts` | Zod schemas for PR request/response |
| Code Generator | `src/code-generator/` | Template-based code generation |
| GitHub Dispatcher | `src/dispatcher/github-dispatcher.ts` | Octokit-based PR creation |
| Slack Enhancement | `src/dispatcher/slack-dispatcher.ts` | PR link notifications |
| Action Orchestrator | `src/orchestrator/` | Flow coordination |
| CLI Integration | `src/cli.ts` | `full-analysis` command |

### Flow Diagram

```
Alert → LoginGraph → SearchGraph
              ↓
        specChanges.codeWillBreak?
              ↓ yes
        CodeGenerator.generate()
              ↓
        GitHubDispatcher.createPR()
              ↓
        SlackDispatcher.sendAnalysisComplete(prUrl)
```

### Test Coverage

- `github-pr.schema.test.ts` - Schema validation
- `code-generator.test.ts` - Code generation
- `github-dispatcher.test.ts` - PR creation (mock mode)
- `slack-dispatcher.test.ts` - Slack notifications
- `action-orchestrator.test.ts` - Orchestration logic
- `phase2-integration.test.ts` - End-to-end flow

---

**Plan complete and saved to `docs/plans/2026-01-28-mvp-phase2-implementation.md`.**

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
