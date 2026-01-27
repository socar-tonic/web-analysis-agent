// src/agents/login-graph/utils.ts

export interface ConnectionErrorInfo {
  isConnectionError: boolean;
  errorType: 'timeout' | 'connection_refused' | 'dns_failed' | 'ssl_error' | 'network_error' | 'server_error' | 'unknown';
  confidence: number;
  summary: string;
}

export function classifyConnectionError(error: Error): ConnectionErrorInfo {
  const message = error.message.toLowerCase();

  // Timeout
  if (message.includes('timeout') || error.message.includes('Timeout')) {
    return {
      isConnectionError: true,
      errorType: 'timeout',
      confidence: 1.0,
      summary: '접속 타임아웃 - 서버 다운 또는 방화벽 차단 추정',
    };
  }

  // Connection refused
  if (message.includes('econnrefused') || message.includes('err_connection_refused')) {
    return {
      isConnectionError: true,
      errorType: 'connection_refused',
      confidence: 1.0,
      summary: '연결 거부됨 - 서버가 연결을 받지 않음',
    };
  }

  // DNS resolution failed
  if (message.includes('enotfound') || message.includes('err_name_not_resolved') || message.includes('getaddrinfo')) {
    return {
      isConnectionError: true,
      errorType: 'dns_failed',
      confidence: 1.0,
      summary: 'DNS 해석 실패 - 도메인이 존재하지 않거나 DNS 서버 접근 불가',
    };
  }

  // SSL/TLS errors
  if (message.includes('ssl') || message.includes('err_cert') || message.includes('certificate')) {
    return {
      isConnectionError: true,
      errorType: 'ssl_error',
      confidence: 0.95,
      summary: 'SSL/TLS 오류 - 인증서 문제 또는 HTTPS 설정 오류',
    };
  }

  // Generic network errors
  if (message.includes('net::err_') || message.includes('econnreset') || message.includes('network')) {
    return {
      isConnectionError: true,
      errorType: 'network_error',
      confidence: 0.9,
      summary: '네트워크 오류 - 연결 중단 또는 접근 불가',
    };
  }

  // Server errors (5xx)
  if (/\b5\d{2}\b/.test(error.message)) {
    return {
      isConnectionError: true,
      errorType: 'server_error',
      confidence: 0.9,
      summary: '서버 오류 - 서비스 일시 중단',
    };
  }

  return {
    isConnectionError: false,
    errorType: 'unknown',
    confidence: 0,
    summary: error.message,
  };
}

export function classifyConnectionErrorFromText(text: string): ConnectionErrorInfo {
  return classifyConnectionError(new Error(text));
}

export function extractTextFromMcpResult(result: any): string {
  const contents = result.content as any[];
  return contents?.map((c: any) => c.text || '').join('\n') || '';
}
