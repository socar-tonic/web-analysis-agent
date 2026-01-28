// src/agents/pr-graph/__tests__/load-context.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadContext } from '../nodes/load-context.js';
import { setNodeContext, clearNodeContext } from '../index.js';
import type { PRGraphStateType } from '../state.js';

describe('loadContext node', () => {
  const mockMcpClient = {
    callTool: vi.fn(),
  };

  beforeEach(() => {
    setNodeContext({
      mcpClient: mockMcpClient as any,
      llm: {} as any,
      systemCode: 'test-vendor',
      repoOwner: 'socar-inc',
      repoName: 'modu-batch-webdc',
    });
  });

  afterEach(() => {
    clearNodeContext();
    vi.clearAllMocks();
  });

  it('should load existing code from GitHub', async () => {
    mockMcpClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'export function search() {}' }],
    });

    const state: Partial<PRGraphStateType> = {
      systemCode: 'humax-parcs',
      changeType: 'api',
      changes: ['API endpoint changed'],
    };

    const result = await loadContext(state as PRGraphStateType);

    expect(result.batchCodePath).toContain('humax-parcs');
    expect(result.existingCode).toBe('export function search() {}');
    expect(mockMcpClient.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'get_file_contents',
      })
    );
  });

  it('should handle file not found', async () => {
    mockMcpClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
    });

    const state: Partial<PRGraphStateType> = {
      systemCode: 'unknown-vendor',
      changeType: 'api',
      changes: [],
    };

    const result = await loadContext(state as PRGraphStateType);

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('찾을 수 없음');
  });
});
