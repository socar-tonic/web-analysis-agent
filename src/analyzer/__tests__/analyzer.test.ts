import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Analyzer } from '../analyzer.js';
import { SiteAnalysisSchema } from '../../schemas/index.js';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

describe('Analyzer', () => {
  let analyzer: Analyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer();
  });

  describe('analyzeSite', () => {
    it('should return timeout status when page times out', async () => {
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockRejectedValue(new Error('Navigation timeout of 30000ms exceeded')),
          close: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('timeout');
      expect(result.vendorId).toBe('vendor-abc');
      expect(SiteAnalysisSchema.safeParse(result).success).toBe(true);
    });

    it('should return success status when page loads', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        content: vi.fn().mockResolvedValue('<html></html>'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
        close: vi.fn(),
        on: vi.fn(),
      };
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('success');
      expect(result.httpStatus).toBe(200);
      expect(SiteAnalysisSchema.safeParse(result).success).toBe(true);
    });

    it('should return error status on 5xx response', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 503 }),
        content: vi.fn().mockResolvedValue('<html></html>'),
        close: vi.fn(),
        on: vi.fn(),
      };
      const mockBrowser = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn(),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const result = await analyzer.analyzeSite('vendor-abc', 'https://example.com');

      expect(result.connectionStatus).toBe('success');
      expect(result.httpStatus).toBe(503);
    });
  });
});
