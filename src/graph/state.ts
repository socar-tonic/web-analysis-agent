import { Annotation } from '@langchain/langgraph';
import { SiteAnalysis, Diagnosis } from '../schemas/index.js';

// Agent analysis result interface
export interface AgentAnalysisResult {
  agent: 'dom' | 'network' | 'policy';
  hasIssue: boolean;
  diagnosis: 'SIGNATURE_CHANGED' | 'INTERNAL_ERROR' | 'DATA_ERROR' | 'NO_ISSUE' | 'UNKNOWN';
  details: string;
  confidence: number;
  suggestedFix?: string;
}

// Define state using LangGraph Annotation
export const AgentStateAnnotation = Annotation.Root({
  // Input
  vendorId: Annotation<string>,
  vendorUrl: Annotation<string>,

  // Site analysis result
  siteAnalysis: Annotation<SiteAnalysis | undefined>,

  // Individual agent results (using reducer to collect parallel results)
  agentResults: Annotation<AgentAnalysisResult[]>({
    reducer: (current, update) => {
      if (!current) return update;
      if (!update) return current;
      return [...current, ...update];
    },
    default: () => [],
  }),

  // Final diagnosis
  diagnosis: Annotation<Diagnosis | undefined>,

  // Workflow control
  requiresLLMAnalysis: Annotation<boolean>({
    default: () => false,
  }),

  // Output
  notificationSent: Annotation<boolean>({
    default: () => false,
  }),
  error: Annotation<string | undefined>,
});

export type AgentState = typeof AgentStateAnnotation.State;
