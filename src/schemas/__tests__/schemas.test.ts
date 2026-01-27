import { describe, it, expect } from 'vitest';
import {
  FailureAlertSchema,
  SiteAnalysisSchema,
  DiagnosisSchema,
  DiagnosisType,
} from '../index.js';
import { SearchResultSchema } from '../search-result.schema.js';
import { SearchSpecSchema } from '../search-spec.schema.js';

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

describe('SearchResultSchema', () => {
  it('should validate successful search result', () => {
    const result = {
      status: 'SUCCESS',
      confidence: 0.95,
      details: {
        vehicleFound: true,
        searchMethod: 'api',
        resultCount: 1,
      },
      vehicle: {
        id: '12345',
        plateNumber: '12가3456',
        inTime: '2026-01-27T10:00:00Z',
      },
      timestamp: new Date().toISOString(),
    };
    expect(() => SearchResultSchema.parse(result)).not.toThrow();
  });

  it('should validate not found result', () => {
    const result = {
      status: 'NOT_FOUND',
      confidence: 0.9,
      details: {
        vehicleFound: false,
        searchMethod: 'dom',
        resultCount: 0,
      },
      timestamp: new Date().toISOString(),
    };
    expect(() => SearchResultSchema.parse(result)).not.toThrow();
  });
});

describe('SearchSpecSchema', () => {
  it('should validate API-based search spec', () => {
    const spec = {
      systemCode: 'humax-parcs-api',
      url: 'https://console.humax-parcs.com',
      capturedAt: new Date().toISOString(),
      searchType: 'api',
      api: {
        endpoint: '/in.store/{siteId}',
        method: 'GET',
        params: ['searchType', 'plateNumber', 'fromAt', 'toAt'],
        responseFields: ['id', 'plateNumber', 'inTime'],
      },
      resultIndicators: {
        successField: 'resultCode',
        successValue: 'SUCCESS',
      },
      version: 1,
    };
    expect(() => SearchSpecSchema.parse(spec)).not.toThrow();
  });

  it('should validate DOM-based search spec', () => {
    const spec = {
      systemCode: 'vendor-dom',
      url: 'https://vendor.com',
      capturedAt: new Date().toISOString(),
      searchType: 'dom',
      form: {
        searchInputSelector: 'input[name="carNum"]',
        searchButtonSelector: 'button.search-btn',
        resultTableSelector: 'table.result-list',
        resultRowSelector: 'tr.vehicle-row',
      },
      resultIndicators: {
        noResultText: '검색 결과가 없습니다',
      },
      version: 1,
    };
    expect(() => SearchSpecSchema.parse(spec)).not.toThrow();
  });
});
