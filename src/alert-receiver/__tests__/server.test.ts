import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../server.js';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockRejectedValue(new Error('Navigation timeout of 30000ms exceeded')),
        close: vi.fn(),
        on: vi.fn(),
      }),
      close: vi.fn(),
    }),
  },
}));

describe('Alert Receiver Server', () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createServer({
      slackWebhookUrl: 'mock',
      vendorUrlMap: {
        'vendor-abc': 'https://example.com',
      },
    });
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });
  });

  describe('POST /webhook/alert', () => {
    it('should process valid failure alert', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({ vendorId: 'vendor-abc' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.diagnosis).toBe('SERVER_OR_FIREWALL');
    });

    it('should reject alert without vendorId', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({ timestamp: new Date().toISOString() });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('vendorId');
    });

    it('should reject unknown vendor', async () => {
      const response = await request(app)
        .post('/webhook/alert')
        .send({ vendorId: 'unknown-vendor' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Unknown vendor');
    });
  });
});
