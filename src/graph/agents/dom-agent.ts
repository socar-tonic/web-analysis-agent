import { AgentState, AgentAnalysisResult } from '../state.js';

/**
 * DOM Agent - Analyzes DOM structure changes
 * Detects UI selector changes (forms, buttons, inputs)
 */
export async function domAgentNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log(`[DOM Agent] Analyzing DOM for vendor: ${state.vendorId}`);

  const siteAnalysis = state.siteAnalysis;
  if (!siteAnalysis || siteAnalysis.connectionStatus !== 'success') {
    return {
      agentResults: [{
        agent: 'dom',
        hasIssue: false,
        diagnosis: 'NO_ISSUE',
        details: 'Site not accessible, skipping DOM analysis',
        confidence: 0,
      }],
    };
  }

  // TODO: In Phase 2, integrate with LLM to analyze DOM changes
  // For now, return a stub result based on DOM snapshot presence
  const domSnapshot = siteAnalysis.domSnapshot;

  const result: AgentAnalysisResult = {
    agent: 'dom',
    hasIssue: false,
    diagnosis: 'NO_ISSUE',
    details: domSnapshot
      ? `DOM analysis complete. Found forms: login=${!!domSnapshot.loginForm}, search=${!!domSnapshot.searchForm}`
      : 'No DOM snapshot available for analysis',
    confidence: 0.7,
  };

  // Simulate detecting a DOM change (for demo purposes)
  // In real implementation, compare with stored spec
  if (domSnapshot?.loginForm === 'changed') {
    result.hasIssue = true;
    result.diagnosis = 'SIGNATURE_CHANGED';
    result.details = 'Login form selector has changed';
    result.confidence = 0.9;
    result.suggestedFix = 'Update login selector from #login-btn to .new-login-btn';
  }

  console.log(`[DOM Agent] Result: ${result.diagnosis} (confidence: ${result.confidence})`);

  return { agentResults: [result] };
}
