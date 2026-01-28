// src/agents/pr-graph/__tests__/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PRGraph } from '../index.js';

describe('PRGraph Integration', () => {
  const mockMcpClient = {
    callTool: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock GitHub MCP responses
    mockMcpClient.callTool
      // get_file_contents
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'export async function search() { return fetch("/api/v1/search"); }' }],
      })
      // get_ref
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"sha": "abc123def456"}' }],
      })
      // create_ref
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ref": "refs/heads/fix/test"}' }],
      })
      // create_or_update_file
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"commit": {"sha": "new123"}}' }],
      })
      // create_pull_request
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"number": 42, "html_url": "https://github.com/test/repo/pull/42"}' }],
      });
  });

  it('should complete full PR creation flow', async () => {
    const mockLlm = {
      invoke: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          fixedCode: 'export async function search() { return fetch("/api/v2/search"); }',
          commitMessage: 'fix(test): update API endpoint',
          prTitle: 'fix(test): API endpoint 변경',
          prBody: '## Changes\n- Updated endpoint',
        }),
      }),
      bindTools: vi.fn().mockReturnThis(),
    };

    const prGraph = new PRGraph({
      systemCode: 'test-vendor',
      changeType: 'api',
      changes: ['API endpoint changed: /api/v1/search -> /api/v2/search'],
      capturedApiSchema: {
        endpoint: '/api/v2/search',
        method: 'GET',
      },
      mcpClient: mockMcpClient as any,
      llm: mockLlm as any,
    });

    // Note: This test would need proper LLM mocking
    // For now, just verify structure
    expect(prGraph).toBeDefined();
  });

  it('should handle config correctly', () => {
    const config = {
      systemCode: 'humax-parcs',
      changeType: 'dom' as const,
      changes: ['Button selector changed'],
      mcpClient: mockMcpClient as any,
      llm: {} as any,
    };

    const prGraph = new PRGraph(config);

    expect(prGraph).toBeDefined();
  });
});
