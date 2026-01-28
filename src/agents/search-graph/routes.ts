// src/agents/search-graph/routes.ts
import { END } from '@langchain/langgraph';
import type { SearchGraphStateType } from './state.js';

// DOM 분석 후 라우팅
export function routeAfterAnalyze(state: SearchGraphStateType): string {
  if (state.searchMethod === 'dom' || state.searchMethod === 'api') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'screenshotFallback';
}

// 스크린샷 분석 후 라우팅
export function routeAfterScreenshot(state: SearchGraphStateType): string {
  if (state.searchMethod !== 'unknown') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'hintFallback';
}

// Hint 폴백 후 라우팅
export function routeAfterHint(state: SearchGraphStateType): string {
  if (state.searchMethod !== 'unknown') {
    return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
  }
  return 'specFallback';
}

// Spec 폴백 후 라우팅
export function routeAfterSpecFallback(state: SearchGraphStateType): string {
  // 에러 상태면 종료
  if (state.status !== 'pending') {
    return END;
  }
  return state.searchMethod === 'api' ? 'executeApiSearch' : 'executeSearch';
}

// API 검색 후 라우팅 (API는 다음 화면 불가하지만 spec 비교는 필요)
export function routeAfterApiSearch(state: SearchGraphStateType): string {
  // spec이 있고 capturedRequests가 있으면 비교 수행
  if (state.spec && state.capturedRequests.length > 0) {
    return 'compareSpec';
  }
  return END;
}

// DOM 검색 후 라우팅
export function routeAfterSearch(state: SearchGraphStateType): string {
  if (state.status !== 'pending') {
    return END;
  }
  return 'captureResults';
}

// 결과 캡처 후 라우팅
export function routeAfterCapture(state: SearchGraphStateType): string {
  // 에러/타임아웃/세션만료면 종료
  if (['TIMEOUT_ERROR', 'SESSION_EXPIRED', 'UNKNOWN_ERROR'].includes(state.status)) {
    return END;
  }
  return 'compareSpec';
}

// Spec 비교 후 라우팅 (항상 종료)
export function routeAfterCompare(_state: SearchGraphStateType): string {
  return END;
}
