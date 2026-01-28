// src/agents/pr-graph/nodes/load-context.ts
import type { PRGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';

/**
 * loadContext node - GitHub MCP로 기존 배치 코드 읽기
 *
 * 파일 경로 convention: src/v1/biz/service/{systemCode}/search.ts
 */
export async function loadContext(
  state: PRGraphStateType
): Promise<Partial<PRGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, repoOwner, repoName } = ctx;

  // 파일 경로 결정 (convention 기반)
  const batchCodePath = `src/v1/biz/service/${state.systemCode}/search.ts`;

  console.log(`  [loadContext] Loading ${batchCodePath} from ${repoOwner}/${repoName}`);

  try {
    const result = await mcpClient.callTool({
      name: 'get_file_contents',
      arguments: {
        owner: repoOwner,
        repo: repoName,
        path: batchCodePath,
      },
    });

    const contents = result.content as any[];
    const existingCode = contents
      ?.map((c: any) => c.text || '')
      .join('\n') || '';

    if (!existingCode) {
      console.log(`  [loadContext] File not found or empty`);
      return {
        batchCodePath,
        existingCode: '',
        status: 'failed',
        errorMessage: `파일을 찾을 수 없음: ${batchCodePath}`,
      };
    }

    console.log(`  [loadContext] Loaded ${existingCode.length} chars`);

    return {
      batchCodePath,
      existingCode,
    };
  } catch (e) {
    console.log(`  [loadContext] Error: ${(e as Error).message}`);
    return {
      batchCodePath,
      existingCode: '',
      status: 'failed',
      errorMessage: `파일 로드 실패: ${(e as Error).message}`,
    };
  }
}
