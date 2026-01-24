import { AgentState, AgentAnalysisResult } from './state.js';
import { Analyzer } from '../analyzer/index.js';
import { HeuristicEngine } from '../engine/index.js';
import { SlackDispatcher } from '../dispatcher/index.js';
import { Diagnosis, DiagnosisType } from '../schemas/index.js';

export interface WorkflowConfig {
  slackWebhookUrl: string;
}

/**
 * Analyze Node - Uses Playwright to analyze the vendor site
 */
export function createAnalyzeNode() {
  const analyzer = new Analyzer();

  return async (state: AgentState): Promise<Partial<AgentState>> => {
    console.log(`[Analyze] Starting site analysis for: ${state.vendorId}`);

    try {
      const siteAnalysis = await analyzer.analyzeSite(state.vendorId, state.vendorUrl);

      // Determine if LLM analysis is needed
      const requiresLLMAnalysis = siteAnalysis.connectionStatus === 'success' &&
        siteAnalysis.httpStatus !== undefined &&
        siteAnalysis.httpStatus < 500;

      console.log(`[Analyze] Connection: ${siteAnalysis.connectionStatus}, HTTP: ${siteAnalysis.httpStatus}, RequiresLLM: ${requiresLLMAnalysis}`);

      return {
        siteAnalysis,
        requiresLLMAnalysis,
      };
    } catch (error) {
      console.error(`[Analyze] Error:`, error);
      return {
        error: error instanceof Error ? error.message : 'Analysis failed',
        requiresLLMAnalysis: false,
      };
    }
  };
}

/**
 * Heuristic Diagnose Node - Quick rule-based diagnosis for server/firewall issues
 */
export function createHeuristicDiagnoseNode() {
  const engine = new HeuristicEngine();

  return async (state: AgentState): Promise<Partial<AgentState>> => {
    console.log(`[Heuristic] Running rule-based diagnosis`);

    if (!state.siteAnalysis) {
      return { error: 'No site analysis available' };
    }

    const diagnosis = engine.diagnose(state.siteAnalysis);
    console.log(`[Heuristic] Diagnosis: ${diagnosis.diagnosis}`);

    return { diagnosis };
  };
}

/**
 * Aggregator Node - Combines results from parallel agent analysis
 */
export function createAggregatorNode() {
  return async (state: AgentState): Promise<Partial<AgentState>> => {
    console.log(`[Aggregator] Combining ${state.agentResults.length} agent results`);

    const agentResults = state.agentResults;

    // Find the most severe issue
    const issueResults = agentResults.filter(r => r.hasIssue);

    if (issueResults.length === 0) {
      // No issues found by any agent
      const diagnosis: Diagnosis = {
        vendorId: state.vendorId,
        diagnosis: 'UNKNOWN',
        confidence: 0.5,
        summary: '멀티에이전트 분석 완료, 명확한 문제 미발견 - 수동 확인 권장',
        details: agentResults.map(r => `[${r.agent}] ${r.details}`).join('\n'),
        timestamp: new Date().toISOString(),
      };
      return { diagnosis };
    }

    // Priority: INTERNAL_ERROR > DATA_ERROR > SIGNATURE_CHANGED
    const priorityOrder: Record<string, number> = {
      'INTERNAL_ERROR': 3,
      'DATA_ERROR': 2,
      'SIGNATURE_CHANGED': 1,
      'UNKNOWN': 0,
      'NO_ISSUE': -1,
    };

    const sortedIssues = issueResults.sort((a, b) =>
      (priorityOrder[b.diagnosis] || 0) - (priorityOrder[a.diagnosis] || 0)
    );

    const primaryIssue = sortedIssues[0];
    const diagnosisType: DiagnosisType = primaryIssue.diagnosis === 'NO_ISSUE'
      ? 'UNKNOWN'
      : primaryIssue.diagnosis as DiagnosisType;

    const diagnosis: Diagnosis = {
      vendorId: state.vendorId,
      diagnosis: diagnosisType,
      confidence: primaryIssue.confidence,
      summary: `[${primaryIssue.agent.toUpperCase()}] ${primaryIssue.details}`,
      details: agentResults.map(r => `[${r.agent}] ${r.diagnosis}: ${r.details}`).join('\n'),
      suggestedFix: primaryIssue.suggestedFix,
      timestamp: new Date().toISOString(),
    };

    console.log(`[Aggregator] Final diagnosis: ${diagnosis.diagnosis} from ${primaryIssue.agent} agent`);

    return { diagnosis };
  };
}

/**
 * Notify Node - Sends diagnosis to Slack (or mock)
 */
export function createNotifyNode(config: WorkflowConfig) {
  const dispatcher = new SlackDispatcher(config.slackWebhookUrl);

  return async (state: AgentState): Promise<Partial<AgentState>> => {
    console.log(`[Notify] Sending notification for diagnosis: ${state.diagnosis?.diagnosis}`);

    if (!state.diagnosis) {
      return { error: 'No diagnosis available' };
    }

    try {
      await dispatcher.sendDiagnosis(state.diagnosis);
      return { notificationSent: true };
    } catch (error) {
      console.error(`[Notify] Error:`, error);
      return {
        notificationSent: false,
        error: error instanceof Error ? error.message : 'Notification failed',
      };
    }
  };
}
