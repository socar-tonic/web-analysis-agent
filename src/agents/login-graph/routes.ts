// src/agents/login-graph/routes.ts
import { END } from '@langchain/langgraph';
import type { LoginGraphStateType } from './state.js';

export function routeAfterConnection(state: LoginGraphStateType): string {
  if (state.status === 'CONNECTION_ERROR') {
    return END;
  }
  return 'analyzeForm';
}

export function routeAfterAnalysis(state: LoginGraphStateType): string {
  const { formElements } = state;
  if (formElements.usernameRef && formElements.submitRef) {
    return 'fillCredentials';
  }
  return 'screenshotFallback';
}

export function routeAfterScreenshot(state: LoginGraphStateType): string {
  const { formElements } = state;
  if (formElements.usernameRef && formElements.submitRef) {
    return 'fillCredentials';
  }
  // Form not found even after screenshot analysis
  return END;
}

export function routeAfterVerify(state: LoginGraphStateType): string {
  // If spec changes were detected, report and end
  if (state.specChanges?.hasChanges) {
    console.log(`  [route] Spec changes detected (${state.specChanges.changeType}): ${state.specChanges.changes.join(', ')}`);
    return END;
  }

  // Continue to extract session if login was successful
  if (state.status === 'SUCCESS') {
    return 'extractSession';
  }
  return END;
}
