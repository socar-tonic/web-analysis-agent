// src/agents/search-graph/__tests__/utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  extractTextFromMcpResult,
  extractLast4Digits,
  NETWORK_INTERCEPTOR_JS,
  GET_CAPTURED_REQUESTS_JS,
} from '../utils.js';

describe('utils', () => {
  describe('extractTextFromMcpResult', () => {
    it('should extract text from MCP result with multiple content items', () => {
      const result = { content: [{ text: 'Hello' }, { text: ' World' }] };
      expect(extractTextFromMcpResult(result)).toBe('Hello\n World');
    });

    it('should return empty string for empty content array', () => {
      const result = { content: [] };
      expect(extractTextFromMcpResult(result)).toBe('');
    });

    it('should handle missing text property', () => {
      const result = { content: [{ type: 'image' }, { text: 'Only text' }] };
      expect(extractTextFromMcpResult(result)).toBe('\nOnly text');
    });

    it('should return empty string for null/undefined result', () => {
      expect(extractTextFromMcpResult(null)).toBe('');
      expect(extractTextFromMcpResult(undefined)).toBe('');
    });
  });

  describe('extractLast4Digits', () => {
    it('should extract last 4 digits from Korean plate format', () => {
      expect(extractLast4Digits('12가3456')).toBe('3456');
      expect(extractLast4Digits('서울12가3456')).toBe('3456');
    });

    it('should handle plate with less than 4 digits', () => {
      expect(extractLast4Digits('가123')).toBe('123');
    });

    it('should handle plate with only digits', () => {
      expect(extractLast4Digits('1234')).toBe('1234');
    });

    it('should handle empty string', () => {
      expect(extractLast4Digits('')).toBe('');
    });
  });

  describe('NETWORK_INTERCEPTOR_JS', () => {
    it('should be defined and be a string', () => {
      expect(NETWORK_INTERCEPTOR_JS).toBeDefined();
      expect(typeof NETWORK_INTERCEPTOR_JS).toBe('string');
    });

    it('should be an arrow function for browser_evaluate', () => {
      expect(NETWORK_INTERCEPTOR_JS.trim()).toMatch(/^\(\) => \{/);
    });

    it('should capture requests to window.__capturedApiRequests', () => {
      expect(NETWORK_INTERCEPTOR_JS).toContain('window.__capturedApiRequests');
    });

    it('should intercept fetch and XMLHttpRequest', () => {
      expect(NETWORK_INTERCEPTOR_JS).toContain('window.fetch');
      expect(NETWORK_INTERCEPTOR_JS).toContain('XMLHttpRequest');
    });
  });

  describe('GET_CAPTURED_REQUESTS_JS', () => {
    it('should be defined and be a string', () => {
      expect(GET_CAPTURED_REQUESTS_JS).toBeDefined();
      expect(typeof GET_CAPTURED_REQUESTS_JS).toBe('string');
    });

    it('should be an arrow function that returns captured requests', () => {
      expect(GET_CAPTURED_REQUESTS_JS).toContain('window.__capturedApiRequests');
      expect(GET_CAPTURED_REQUESTS_JS).toContain('JSON.stringify');
    });
  });
});
