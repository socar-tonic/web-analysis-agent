// src/agents/pr-graph/routes.ts
import { END } from '@langchain/langgraph';
import type { PRGraphStateType } from './state.js';

export function routeAfterLoadContext(state: PRGraphStateType): string {
  if (state.status === 'failed') {
    return END;
  }
  return 'generateFix';
}

export function routeAfterGenerateFix(state: PRGraphStateType): string {
  if (state.status === 'failed') {
    return END;
  }
  return 'createPR';
}
