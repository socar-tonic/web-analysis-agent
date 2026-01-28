// src/agents/pr-graph/state.ts
import { Annotation } from '@langchain/langgraph';
import type { CapturedApiSchema } from '../search-graph/state.js';

export type PRStatus = 'pending' | 'success' | 'failed';

export const PRGraphState = Annotation.Root({
  // Input (from Orchestrator)
  systemCode: Annotation<string>,
  changeType: Annotation<'dom' | 'api'>({ reducer: (_, b) => b, default: () => 'api' }),
  changes: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  capturedApiSchema: Annotation<CapturedApiSchema | null>({ reducer: (_, b) => b, default: () => null }),

  // Context (loadContext에서 설정)
  batchCodePath: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  existingCode: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),

  // Output (generateFix에서 설정)
  fixedCode: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  commitMessage: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  prTitle: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  prBody: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),

  // Result
  status: Annotation<PRStatus>({ reducer: (_, b) => b, default: () => 'pending' }),
  prUrl: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  prNumber: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),
  branchName: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  errorMessage: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
});

export type PRGraphStateType = typeof PRGraphState.State;
