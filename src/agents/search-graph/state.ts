// src/agents/search-graph/state.ts
import { Annotation } from '@langchain/langgraph';
import type { SearchSpec } from '../../schemas/index.js';
import type { SessionInfo } from '../login-graph/state.js';

export type SearchStatus =
  | 'pending'
  | 'SUCCESS'              // 차량 발견
  | 'NOT_FOUND'            // 입차 기록 없음 (정상)
  | 'FORM_CHANGED'         // DOM UI 변경 감지
  | 'API_CHANGED'          // API 변경 감지
  | 'SESSION_EXPIRED'      // 세션 만료
  | 'CONNECTION_ERROR'     // 연결 오류
  | 'TIMEOUT_ERROR'        // 타임아웃
  | 'UNKNOWN_ERROR';

export type SearchMethodType = 'dom' | 'api' | 'unknown';
export type AnalysisSource = 'dom_analysis' | 'screenshot' | 'hint' | 'spec_fallback';

export interface SearchFormElements {
  searchInputRef: string | null;
  searchInputSelector: string | null;
  searchButtonRef: string | null;
  searchButtonSelector: string | null;
}

export interface VehicleInfo {
  id?: string;
  plateNumber: string;
  inTime: string;
  outTime?: string;
  parkingFee?: number;
}

export interface CapturedNetworkRequest {
  url: string;
  method: string;
  requestBody?: any;
  responseStatus: number;
  responseBody?: any;
  timestamp: number;
}

// Captured API schema for spec update suggestions
export interface CapturedApiSchema {
  endpoint: string;
  method: string;
  params?: Record<string, string>;
  requestBody?: Record<string, any>;
  responseSchema?: {
    type: 'object' | 'array' | 'primitive';
    fields?: string[];
    sample?: any;
  };
}

export interface SpecChanges {
  hasChanges: boolean;
  changeType: 'dom' | 'api' | 'both' | null;
  changes: string[];
  codeWillBreak: boolean;
  // New: captured API details for spec updates
  capturedApiSchema?: CapturedApiSchema;
}

export const SearchGraphState = Annotation.Root({
  // Input (from LoginGraph)
  systemCode: Annotation<string>,
  url: Annotation<string>,
  carNum: Annotation<string>,
  session: Annotation<SessionInfo>({ reducer: (_, b) => b, default: () => ({}) }),

  // Spec
  spec: Annotation<SearchSpec | null>({ reducer: (_, b) => b, default: () => null }),

  // Analysis state
  snapshot: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  screenshot: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  searchMethod: Annotation<SearchMethodType>({ reducer: (_, b) => b, default: () => 'unknown' }),
  analysisSource: Annotation<AnalysisSource | null>({ reducer: (_, b) => b, default: () => null }),
  formElements: Annotation<SearchFormElements>({
    reducer: (_, b) => b,
    default: () => ({ searchInputRef: null, searchInputSelector: null, searchButtonRef: null, searchButtonSelector: null }),
  }),

  // Network capture
  capturedRequests: Annotation<CapturedNetworkRequest[]>({ reducer: (_, b) => b, default: () => [] }),

  // Results
  vehicle: Annotation<VehicleInfo | null>({ reducer: (_, b) => b, default: () => null }),
  resultCount: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // Output
  status: Annotation<SearchStatus>({ reducer: (_, b) => b, default: () => 'pending' }),
  confidence: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  errorMessage: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  specChanges: Annotation<SpecChanges | null>({ reducer: (_, b) => b, default: () => null }),

  // For DiscountGraph handoff
  readyForDiscount: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
});

export type SearchGraphStateType = typeof SearchGraphState.State;
