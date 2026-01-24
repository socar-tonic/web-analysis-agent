import { AgentState, AgentAnalysisResult } from '../state.js';

/**
 * Network Agent - Analyzes API endpoint/format changes
 * Detects changes in API endpoints, request/response formats
 */
export async function networkAgentNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log(`[Network Agent] Analyzing network logs for vendor: ${state.vendorId}`);

  const siteAnalysis = state.siteAnalysis;
  if (!siteAnalysis || siteAnalysis.connectionStatus !== 'success') {
    return {
      agentResults: [{
        agent: 'network',
        hasIssue: false,
        diagnosis: 'NO_ISSUE',
        details: 'Site not accessible, skipping network analysis',
        confidence: 0,
      }],
    };
  }

  // TODO: In Phase 2, integrate with LLM to analyze API changes
  // For now, return a stub result based on network logs
  const networkLogs = siteAnalysis.networkLogs || [];

  const apiEndpoints = networkLogs
    .filter(log => log.url.includes('/api/'))
    .map(log => `${log.method} ${new URL(log.url).pathname}`);

  const result: AgentAnalysisResult = {
    agent: 'network',
    hasIssue: false,
    diagnosis: 'NO_ISSUE',
    details: `Network analysis complete. Found ${networkLogs.length} requests, ${apiEndpoints.length} API calls.`,
    confidence: 0.7,
  };

  // Check for error responses
  const errorResponses = networkLogs.filter(log => log.status >= 400);
  if (errorResponses.length > 0) {
    const errorEndpoints = errorResponses.map(log => `${log.method} ${log.url} (${log.status})`);
    result.hasIssue = true;
    result.diagnosis = 'SIGNATURE_CHANGED';
    result.details = `API endpoints returning errors: ${errorEndpoints.join(', ')}`;
    result.confidence = 0.85;
    result.suggestedFix = 'Check if API endpoints or request format has changed';
  }

  console.log(`[Network Agent] Result: ${result.diagnosis} (confidence: ${result.confidence})`);

  return { agentResults: [result] };
}
