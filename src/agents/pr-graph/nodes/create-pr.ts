// src/agents/pr-graph/nodes/create-pr.ts
import type { PRGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';

/**
 * createPR node - GitHub MCP로 branch → commit → Draft PR 생성
 */
export async function createPR(
  state: PRGraphStateType
): Promise<Partial<PRGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, repoOwner, repoName, systemCode } = ctx;

  // 이미 실패 상태면 스킵
  if (state.status === 'failed') {
    return {};
  }

  // fixedCode가 없으면 실패
  if (!state.fixedCode) {
    return {
      status: 'failed',
      errorMessage: '수정된 코드가 없습니다',
    };
  }

  const branchName = `fix/${systemCode}-signature-${Date.now()}`;

  console.log(`  [createPR] Creating branch: ${branchName}`);

  try {
    // 1. 기본 브랜치의 최신 SHA 가져오기
    const refResult = await mcpClient.callTool({
      name: 'get_ref',
      arguments: {
        owner: repoOwner,
        repo: repoName,
        ref: 'heads/main',
      },
    });

    const refContents = refResult.content as any[];
    const refText = refContents?.map((c: any) => c.text || '').join('') || '';
    const shaMatch = refText.match(/"sha"\s*:\s*"([^"]+)"/);
    const baseSha = shaMatch?.[1];

    if (!baseSha) {
      throw new Error('Failed to get base branch SHA');
    }

    console.log(`  [createPR] Base SHA: ${baseSha.slice(0, 7)}`);

    // 2. 새 브랜치 생성
    await mcpClient.callTool({
      name: 'create_ref',
      arguments: {
        owner: repoOwner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      },
    });

    console.log(`  [createPR] Branch created`);

    // 3. 파일 수정 커밋
    await mcpClient.callTool({
      name: 'create_or_update_file',
      arguments: {
        owner: repoOwner,
        repo: repoName,
        path: state.batchCodePath,
        message: state.commitMessage,
        content: Buffer.from(state.fixedCode).toString('base64'),
        branch: branchName,
      },
    });

    console.log(`  [createPR] File committed`);

    // 4. Draft PR 생성
    const prResult = await mcpClient.callTool({
      name: 'create_pull_request',
      arguments: {
        owner: repoOwner,
        repo: repoName,
        title: state.prTitle,
        body: state.prBody + '\n\n---\n> 이 PR은 web-analysis-agent에 의해 자동 생성되었습니다.',
        head: branchName,
        base: 'main',
        draft: true,
      },
    });

    const prContents = prResult.content as any[];
    const prText = prContents?.map((c: any) => c.text || '').join('') || '';

    // PR URL과 번호 추출
    const urlMatch = prText.match(/"html_url"\s*:\s*"([^"]+)"/);
    const numberMatch = prText.match(/"number"\s*:\s*(\d+)/);

    const prUrl = urlMatch?.[1];
    const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : null;

    if (!prUrl) {
      throw new Error('Failed to get PR URL from response');
    }

    console.log(`  [createPR] PR created: #${prNumber} ${prUrl}`);

    return {
      status: 'success',
      prUrl,
      prNumber,
      branchName,
    };
  } catch (e) {
    console.log(`  [createPR] Error: ${(e as Error).message}`);
    return {
      status: 'failed',
      errorMessage: `PR 생성 실패: ${(e as Error).message}`,
    };
  }
}
