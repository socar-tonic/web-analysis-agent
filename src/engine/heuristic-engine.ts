import { SiteAnalysis, Diagnosis } from '../schemas/index.js';

export class HeuristicEngine {
  diagnose(analysis: SiteAnalysis): Diagnosis {
    const { vendorId, connectionStatus, httpStatus } = analysis;
    const timestamp = new Date().toISOString();

    // Rule 1: Connection timeout
    if (connectionStatus === 'timeout') {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 타임아웃 - 서버 다운 또는 방화벽 추정',
        timestamp,
      };
    }

    // Rule 2: Connection error
    if (connectionStatus === 'error') {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 1.0,
        summary: '접속 실패 - 서버 다운 또는 방화벽 추정',
        timestamp,
      };
    }

    // Rule 3: 5xx server error
    if (httpStatus && httpStatus >= 500) {
      return {
        vendorId,
        diagnosis: 'SERVER_OR_FIREWALL',
        confidence: 0.9,
        summary: `서버 에러 (HTTP ${httpStatus}) - 서버 장애 추정`,
        timestamp,
      };
    }

    // Rule 4: 4xx client error (potential signature change)
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return {
        vendorId,
        diagnosis: 'UNKNOWN',
        confidence: 0.5,
        summary: `클라이언트 에러 (HTTP ${httpStatus}) - LLM 분석 필요`,
        timestamp,
      };
    }

    // Default: Needs LLM analysis (Phase 2)
    return {
      vendorId,
      diagnosis: 'UNKNOWN',
      confidence: 0.3,
      summary: '접속 성공, 상세 분석 필요 - LLM 분석 필요 (Phase 2)',
      timestamp,
    };
  }
}
