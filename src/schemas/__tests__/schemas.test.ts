import { describe, it, expect } from 'vitest';
import {
  FailureAlertSchema,
  SiteAnalysisSchema,
  DiagnosisSchema,
  DiagnosisType,
} from '../index';

describe('FailureAlertSchema', () => {
  it('should parse valid failure alert', () => {
    const input = {
      vendorId: 'vendor-abc',
      vehicleNumber: '12가3456',
      failedStep: 'login',
      errorMessage: 'timeout',
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should parse minimal failure alert (vendorId only)', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject alert without vendorId', () => {
    const input = {
      timestamp: new Date().toISOString(),
    };
    const result = FailureAlertSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('SiteAnalysisSchema', () => {
  it('should parse connection failure', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
      connectionStatus: 'timeout',
    };
    const result = SiteAnalysisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should parse successful connection with http status', () => {
    const input = {
      vendorId: 'vendor-abc',
      timestamp: new Date().toISOString(),
      connectionStatus: 'success',
      httpStatus: 200,
      networkLogs: [],
      screenshots: [],
    };
    const result = SiteAnalysisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe('DiagnosisSchema', () => {
  it('should parse SERVER_OR_FIREWALL diagnosis', () => {
    const input = {
      vendorId: 'vendor-abc',
      diagnosis: 'SERVER_OR_FIREWALL' as DiagnosisType,
      confidence: 1.0,
      summary: '접속 타임아웃 - 서버 다운 또는 방화벽',
      timestamp: new Date().toISOString(),
    };
    const result = DiagnosisSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
