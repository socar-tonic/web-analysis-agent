import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer } from '../alert-receiver/index.js';

// Mock playwright for different scenarios
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

describe('Integration: Full Analysis Flow', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({
      slackWebhookUrl: 'mock',
      vendorUrlMap: {
        'vendor-timeout': 'https://timeout.example.com',
        'vendor-success': 'https://success.example.com',
        'vendor-invalid-config': 'https://invalid.example.com',
      },
    });
  });

  describe('Connection Failed Flow', () => {
    it('should diagnose SERVER_OR_FIREWALL for timeout', async () => {
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockRejectedValue(new Error('Navigation timeout of 30000ms exceeded')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      } as any);

      const response = await request(app)
        .post('/webhook/alert')
        .send({ vendorId: 'vendor-timeout' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        vendorId: 'vendor-timeout',
        diagnosis: 'SERVER_OR_FIREWALL',
        notificationSent: true,
      });
    });
  });

  describe('Multi-Agent Parallel Flow', () => {
    it('should run all agents and aggregate results', async () => {
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

      const response = await request(app)
        .post('/webhook/alert')
        .send({ vendorId: 'vendor-success' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.agentResults).toHaveLength(3);
      expect(response.body.agentResults.map((r: any) => r.agent).sort())
        .toEqual(['dom', 'network', 'policy']);
    });

    it('should detect INTERNAL_ERROR from policy agent', async () => {
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

      const response = await request(app)
        .post('/webhook/alert')
        .send({ vendorId: 'vendor-invalid-config' });

      expect(response.status).toBe(200);
      expect(response.body.diagnosis).toBe('INTERNAL_ERROR');
      expect(response.body.agentResults.find((r: any) => r.agent === 'policy')?.diagnosis)
        .toBe('INTERNAL_ERROR');
    });
  });
});
