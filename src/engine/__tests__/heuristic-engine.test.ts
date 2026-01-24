import { describe, it, expect } from 'vitest';
import { HeuristicEngine } from '../heuristic-engine.js';
import { SiteAnalysis } from '../../schemas/index.js';

describe('HeuristicEngine', () => {
  const engine = new HeuristicEngine();

  describe('diagnose', () => {
    it('should return SERVER_OR_FIREWALL for timeout', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'timeout',
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.confidence).toBe(1.0);
      expect(result.summary).toContain('타임아웃');
    });

    it('should return SERVER_OR_FIREWALL for connection error', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'error',
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.confidence).toBe(1.0);
    });

    it('should return SERVER_OR_FIREWALL for 5xx status', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'success',
        httpStatus: 503,
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('SERVER_OR_FIREWALL');
      expect(result.summary).toContain('503');
    });

    it('should return UNKNOWN for successful connection without issues', () => {
      const analysis: SiteAnalysis = {
        vendorId: 'vendor-abc',
        timestamp: new Date().toISOString(),
        connectionStatus: 'success',
        httpStatus: 200,
      };

      const result = engine.diagnose(analysis);

      expect(result.diagnosis).toBe('UNKNOWN');
      expect(result.summary).toContain('LLM 분석 필요');
    });
  });
});
