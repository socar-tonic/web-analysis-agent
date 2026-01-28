// src/agents/login-graph/state.ts
import { Annotation } from '@langchain/langgraph';
import type { LoginSpec } from '../../schemas/index.js';

// Network request captured during login
export interface CapturedNetworkRequest {
  url: string;
  method: string;
  requestBody?: any;
  responseStatus: number;
  responseBody?: any;
  timestamp: number;
}

// Spec comparison result
export interface SpecChanges {
  hasChanges: boolean;
  changeType: 'dom' | 'api' | 'both' | null;
  changes: string[];
}

export interface SessionInfo {
  type?: 'jwt' | 'cookie' | 'session' | 'mixed';
  accessToken?: string;
  cookies?: string[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface FormElements {
  usernameRef: string | null;
  passwordRef: string | null;
  submitRef: string | null;
}

export type LoginStatus =
  | 'pending'
  | 'SUCCESS'
  | 'INVALID_CREDENTIALS'
  | 'FORM_CHANGED'
  | 'FORM_NOT_FOUND'
  | 'CONNECTION_ERROR'
  | 'UNKNOWN_ERROR';

export const LoginGraphState = Annotation.Root({
  // Input
  systemCode: Annotation<string>,
  url: Annotation<string>,

  // Current page state
  currentUrl: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  snapshot: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  screenshot: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),

  // Form analysis results
  formElements: Annotation<FormElements>({
    reducer: (_, b) => b,
    default: () => ({ usernameRef: null, passwordRef: null, submitRef: null }),
  }),

  // Execution state
  credentialsFilled: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  loginClicked: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  networkRequests: Annotation<any[]>({ reducer: (_, b) => b, default: () => [] }),

  // Spec for comparison
  spec: Annotation<LoginSpec | null>({ reducer: (_, b) => b, default: () => null }),
  capturedNetworkRequests: Annotation<CapturedNetworkRequest[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // Result
  status: Annotation<LoginStatus>({ reducer: (_, b) => b, default: () => 'pending' }),
  confidence: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  session: Annotation<SessionInfo | null>({ reducer: (_, b) => b, default: () => null }),
  errorMessage: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  specChanges: Annotation<SpecChanges | null>({ reducer: (_, b) => b, default: () => null }),
});

export type LoginGraphStateType = typeof LoginGraphState.State;
