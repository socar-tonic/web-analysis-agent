// src/agents/pr-graph/nodes/generate-fix.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import type { PRGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';

const GENERATE_FIX_PROMPT = `당신은 주차 배치 시스템 코드를 수정하는 전문가입니다.

## 작업
기존 코드를 분석하고, 감지된 변경 사항을 반영하여 수정된 코드를 생성하세요.

## 입력 정보
1. 기존 코드 (existingCode)
2. 감지된 변경 사항 (changes)
3. 새로 캡처된 API 스키마 (capturedApiSchema) - API 변경 시

## 수정 원칙
- 기존 코드 스타일 유지
- 변경이 필요한 부분만 최소한으로 수정
- API 엔드포인트, 파라미터, 응답 처리 로직 업데이트
- 타입 정의가 필요하면 추가

## 출력 (반드시 JSON 형식)
{
  "fixedCode": "... 전체 수정된 코드 (파일 전체) ...",
  "commitMessage": "fix(시스템코드): 간단한 변경 설명",
  "prTitle": "fix(시스템코드): PR 제목",
  "prBody": "## 변경 사항\\n- 변경 내용 1\\n- 변경 내용 2\\n\\n## 테스트\\n- [ ] 테스트 차량으로 검증"
}`;

/**
 * generateFix node - LLM이 기존 코드를 분석하고 수정 코드 생성
 *
 * createAgent 패턴 사용: 필요시 추가 파일 읽기 가능
 */
export async function generateFix(
  state: PRGraphStateType
): Promise<Partial<PRGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm, repoOwner, repoName } = ctx;

  // 이미 실패 상태면 스킵
  if (state.status === 'failed') {
    return {};
  }

  console.log('  [generateFix] Starting LLM-based code generation...');

  // Tool: 추가 파일 읽기 (import 확인 등)
  const readFileTool = tool(
    async ({ path }: { path: string }) => {
      try {
        const result = await mcpClient.callTool({
          name: 'get_file_contents',
          arguments: { owner: repoOwner, repo: repoName, path },
        });
        const contents = result.content as any[];
        return contents?.map((c: any) => c.text || '').join('\n') || 'File not found';
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    },
    {
      name: 'read_file',
      description: 'Read additional file from the repository (for checking imports, types, etc.)',
      schema: z.object({
        path: z.string().describe('File path relative to repo root'),
      }),
    }
  );

  // Tool: 코드 검색
  const searchCodeTool = tool(
    async ({ query }: { query: string }) => {
      try {
        const result = await mcpClient.callTool({
          name: 'search_code',
          arguments: { owner: repoOwner, repo: repoName, query },
        });
        const contents = result.content as any[];
        return contents?.map((c: any) => c.text || '').join('\n') || 'No results';
      } catch (e) {
        return `Error searching: ${(e as Error).message}`;
      }
    },
    {
      name: 'search_code',
      description: 'Search for code patterns in the repository',
      schema: z.object({
        query: z.string().describe('Search query'),
      }),
    }
  );

  // 입력 컨텍스트 구성
  const inputContext = `
## 기존 코드 (${state.batchCodePath})
\`\`\`typescript
${state.existingCode}
\`\`\`

## 감지된 변경 사항
${state.changes.map(c => `- ${c}`).join('\n')}

## 캡처된 API 스키마
${state.capturedApiSchema ? JSON.stringify(state.capturedApiSchema, null, 2) : '없음 (DOM 변경)'}

## 시스템 코드
${state.systemCode}
`;

  try {
    const agent = createAgent({
      model: llm,
      tools: [readFileTool, searchCodeTool],
      systemPrompt: GENERATE_FIX_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(inputContext)] },
      { recursionLimit: 10 }
    );

    // 응답 추출
    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        finalResponse = msg.content;
        break;
      }
    }

    console.log(`  [generateFix] LLM response length: ${finalResponse.length}`);

    // JSON 파싱
    try {
      // Markdown 코드 블록 처리
      let jsonStr = finalResponse;
      const codeBlockMatch = finalResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (!parsed.fixedCode) {
          throw new Error('fixedCode not found in response');
        }

        console.log(`  [generateFix] Generated fix: ${parsed.commitMessage}`);

        return {
          fixedCode: parsed.fixedCode,
          commitMessage: parsed.commitMessage || `fix(${state.systemCode}): update signature`,
          prTitle: parsed.prTitle || `fix(${state.systemCode}): 시그니처 변경 반영`,
          prBody: parsed.prBody || `## 변경 사항\n${state.changes.map(c => `- ${c}`).join('\n')}`,
        };
      }
    } catch (parseError) {
      console.log(`  [generateFix] Parse error: ${(parseError as Error).message}`);
    }

    // 파싱 실패
    return {
      status: 'failed',
      errorMessage: 'LLM 응답에서 코드를 추출할 수 없습니다',
    };
  } catch (e) {
    console.log(`  [generateFix] Error: ${(e as Error).message}`);
    return {
      status: 'failed',
      errorMessage: `코드 생성 실패: ${(e as Error).message}`,
    };
  }
}
