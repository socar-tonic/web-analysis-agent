import { describe, it, expect } from 'vitest';
import { classifyConnectionError, ConnectionErrorInfo } from '../login-agent.js';

describe('classifyConnectionError', () => {
  describe('timeout errors', () => {
    it('should detect navigation timeout', () => {
      const error = new Error('Navigation timeout of 30000ms exceeded');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('timeout');
      expect(result.confidence).toBe(1.0);
      expect(result.summary).toContain('타임아웃');
    });

    it('should detect generic timeout (case insensitive)', () => {
      const error = new Error('Request Timeout after 10s');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('timeout');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('connection refused errors', () => {
    it('should detect net::ERR_CONNECTION_REFUSED', () => {
      const error = new Error('net::ERR_CONNECTION_REFUSED');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('connection_refused');
      expect(result.confidence).toBe(1.0);
      expect(result.summary).toContain('연결 거부');
    });

    it('should detect ECONNREFUSED (Node.js style)', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:8080');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('connection_refused');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('DNS failures', () => {
    it('should detect getaddrinfo ENOTFOUND', () => {
      const error = new Error('getaddrinfo ENOTFOUND invalid.domain');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('dns_failed');
      expect(result.confidence).toBe(1.0);
      expect(result.summary).toContain('DNS');
    });

    it('should detect ERR_NAME_NOT_RESOLVED', () => {
      const error = new Error('net::ERR_NAME_NOT_RESOLVED');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('dns_failed');
      expect(result.confidence).toBe(1.0);
    });

    it('should detect ENOTFOUND without getaddrinfo prefix', () => {
      const error = new Error('ENOTFOUND nonexistent.example.com');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('dns_failed');
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('SSL/TLS errors', () => {
    it('should detect ERR_CERT_AUTHORITY_INVALID', () => {
      const error = new Error('net::ERR_CERT_AUTHORITY_INVALID');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('ssl_error');
      expect(result.confidence).toBe(0.95);
      expect(result.summary).toContain('SSL');
    });

    it('should detect certificate error', () => {
      const error = new Error('self-signed certificate in certificate chain');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('ssl_error');
      expect(result.confidence).toBe(0.95);
    });

    it('should detect SSL handshake failure', () => {
      const error = new Error('SSL handshake failed');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('ssl_error');
      expect(result.confidence).toBe(0.95);
    });
  });

  describe('network errors', () => {
    it('should detect net::ERR_INTERNET_DISCONNECTED', () => {
      const error = new Error('net::ERR_INTERNET_DISCONNECTED');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('network_error');
      expect(result.confidence).toBe(0.9);
      expect(result.summary).toContain('네트워크');
    });

    it('should detect ECONNRESET', () => {
      const error = new Error('read ECONNRESET');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('network_error');
      expect(result.confidence).toBe(0.9);
    });

    it('should detect generic network error', () => {
      const error = new Error('Network error occurred');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('network_error');
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('server errors (5xx)', () => {
    it('should detect HTTP 503 Service Unavailable', () => {
      const error = new Error('HTTP 503 Service Unavailable');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('server_error');
      expect(result.confidence).toBe(0.9);
      expect(result.summary).toContain('서버 오류');
    });

    it('should detect HTTP 500 Internal Server Error', () => {
      const error = new Error('Request failed with status 500');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('server_error');
      expect(result.confidence).toBe(0.9);
    });

    it('should detect 502 Bad Gateway', () => {
      const error = new Error('502 Bad Gateway');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(true);
      expect(result.errorType).toBe('server_error');
      expect(result.confidence).toBe(0.9);
    });

    it('should not match 4xx errors as server errors', () => {
      const error = new Error('404 Not Found');
      const result = classifyConnectionError(error);

      // 404 should NOT be classified as server_error
      expect(result.errorType).not.toBe('server_error');
    });
  });

  describe('non-connection errors', () => {
    it('should not classify "Element not found" as connection error', () => {
      const error = new Error('Element not found');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(false);
      expect(result.errorType).toBe('unknown');
      expect(result.confidence).toBe(0);
      expect(result.summary).toBe('Element not found');
    });

    it('should not classify "Click failed" as connection error', () => {
      const error = new Error('Click failed: element is not visible');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(false);
      expect(result.errorType).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('should not classify "Invalid selector" as connection error', () => {
      const error = new Error('Invalid selector: #login-button');
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(false);
      expect(result.errorType).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('should preserve original error message in summary for unknown errors', () => {
      const errorMessage = 'Some unexpected error occurred';
      const error = new Error(errorMessage);
      const result = classifyConnectionError(error);

      expect(result.isConnectionError).toBe(false);
      expect(result.summary).toBe(errorMessage);
    });
  });

  describe('type safety', () => {
    it('should return correct ConnectionErrorInfo structure', () => {
      const error = new Error('Navigation timeout');
      const result: ConnectionErrorInfo = classifyConnectionError(error);

      expect(result).toHaveProperty('isConnectionError');
      expect(result).toHaveProperty('errorType');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('summary');
      expect(typeof result.isConnectionError).toBe('boolean');
      expect(typeof result.errorType).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(typeof result.summary).toBe('string');
    });
  });
});
