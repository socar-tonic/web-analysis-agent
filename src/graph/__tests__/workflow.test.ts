import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkflow } from '../workflow.js';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

// Mock fetch for Slack
global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

describe('Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Connection Failed Path', () => {
    it('should use heuristic diagnosis for timeout', async () => {
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockRejectedValue(new Error('Navigation timeout of 30000ms exceeded')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      } as any);

      const workflow = createWorkflow({ slackWebhookUrl: 'mock' });

      const result = await workflow.invoke({
        vendorId: 'vendor-abc',
        vendorUrl: 'https://example.com',
      });

      expect(result.diagnosis?.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.notificationSent).toBe(true);
      // Should not have agent results (skipped LLM path)
      expect(result.agentResults.length).toBe(0);
    });

    it('should use heuristic diagnosis for 5xx error', async () => {
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue({ status: () => 503 }),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      } as any);

      const workflow = createWorkflow({ slackWebhookUrl: 'mock' });

      const result = await workflow.invoke({
        vendorId: 'vendor-abc',
        vendorUrl: 'https://example.com',
      });

      expect(result.diagnosis?.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.notificationSent).toBe(true);
    });
  });

  describe('Multi-Agent Parallel Path', () => {
    it('should run all agents in parallel for successful connection', async () => {
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue({ status: () => 200 }),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      } as any);

      const workflow = createWorkflow({ slackWebhookUrl: 'mock' });

      const result = await workflow.invoke({
        vendorId: 'vendor-abc',
        vendorUrl: 'https://example.com',
      });

      // Should have results from all 3 agents
      expect(result.agentResults.length).toBe(3);
      expect(result.agentResults.map(r => r.agent).sort()).toEqual(['dom', 'network', 'policy']);
      expect(result.notificationSent).toBe(true);
    });

    it('should aggregate results and produce final diagnosis', async () => {
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue({ status: () => 200 }),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      } as any);

      const workflow = createWorkflow({ slackWebhookUrl: 'mock' });

      // Use invalid-config to trigger INTERNAL_ERROR from policy agent
      const result = await workflow.invoke({
        vendorId: 'vendor-invalid-config',
        vendorUrl: 'https://example.com',
      });

      expect(result.agentResults.length).toBe(3);
      // Policy agent should detect INTERNAL_ERROR
      const policyResult = result.agentResults.find(r => r.agent === 'policy');
      expect(policyResult?.diagnosis).toBe('INTERNAL_ERROR');

      // Final diagnosis should be INTERNAL_ERROR (highest priority)
      expect(result.diagnosis?.diagnosis).toBe('INTERNAL_ERROR');
    });
  });
});
