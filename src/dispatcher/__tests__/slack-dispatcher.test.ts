import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackDispatcher } from '../slack-dispatcher.js';
import { Diagnosis } from '../../schemas/index.js';

// Mock fetch
global.fetch = vi.fn();

describe('SlackDispatcher', () => {
  describe('real mode', () => {
    let dispatcher: SlackDispatcher;

    beforeEach(() => {
      vi.resetAllMocks();
      dispatcher = new SlackDispatcher('https://hooks.slack.com/test');
    });

    it('should send SERVER_OR_FIREWALL notification', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 타임아웃 - 서버 다운 또는 방화벽',
        timestamp: new Date().toISOString(),
      };

      await dispatcher.sendDiagnosis(diagnosis);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/test');

      const body = JSON.parse(options?.body as string);
      expect(body.text).toContain('vendor-abc');
      expect(body.text).toContain('서버/방화벽');
    });

    it('should send UNKNOWN notification', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'UNKNOWN',
        confidence: 0.3,
        summary: '접속 성공, 상세 분석 필요',
        timestamp: new Date().toISOString(),
      };

      await dispatcher.sendDiagnosis(diagnosis);

      const [, options] = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(options?.body as string);
      expect(body.text).toContain('수동 확인 필요');
    });

    it('should throw on failed request', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: 'test',
        timestamp: new Date().toISOString(),
      };

      await expect(dispatcher.sendDiagnosis(diagnosis)).rejects.toThrow('Slack');
    });
  });

  describe('mock mode', () => {
    let dispatcher: SlackDispatcher;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.resetAllMocks();
      dispatcher = new SlackDispatcher('mock');
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should log to console instead of sending to Slack', async () => {
      const diagnosis: Diagnosis = {
        vendorId: 'vendor-abc',
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 타임아웃 - 서버 다운 또는 방화벽',
        timestamp: new Date().toISOString(),
      };

      await dispatcher.sendDiagnosis(diagnosis);

      expect(fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      expect(logOutput).toContain('[MOCK SLACK]');
      expect(logOutput).toContain('vendor-abc');
    });
  });
});
