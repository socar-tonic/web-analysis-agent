import { AgentState, AgentAnalysisResult } from '../state.js';

/**
 * Policy Agent - Validates internal configuration
 * Checks discount keys, credentials validity, vehicle number formats
 */
export async function policyAgentNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log(`[Policy Agent] Validating internal config for vendor: ${state.vendorId}`);

  const siteAnalysis = state.siteAnalysis;
  if (!siteAnalysis) {
    return {
      agentResults: [{
        agent: 'policy',
        hasIssue: false,
        diagnosis: 'NO_ISSUE',
        details: 'No site analysis available for policy validation',
        confidence: 0,
      }],
    };
  }

  // TODO: In Phase 2, integrate with DB MCP to check internal config
  // For now, return a stub result
  const result: AgentAnalysisResult = {
    agent: 'policy',
    hasIssue: false,
    diagnosis: 'NO_ISSUE',
    details: `Policy validation complete for vendor: ${state.vendorId}`,
    confidence: 0.8,
  };

  // Simulate policy check scenarios (for demo)
  // In real implementation, query DB for discount keys, credentials status

  // Example: Check if vendor ID contains "invalid" (for testing)
  if (state.vendorId.includes('invalid-config')) {
    result.hasIssue = true;
    result.diagnosis = 'INTERNAL_ERROR';
    result.details = 'Discount key configuration mismatch detected';
    result.confidence = 0.95;
    result.suggestedFix = 'Update discount key in database';
  }

  // Example: Check for data error scenario
  if (state.vendorId.includes('bad-vehicle')) {
    result.hasIssue = true;
    result.diagnosis = 'DATA_ERROR';
    result.details = 'Vehicle number format validation failed';
    result.confidence = 0.9;
    result.suggestedFix = 'Check vehicle number format: expected format "12가3456"';
  }

  console.log(`[Policy Agent] Result: ${result.diagnosis} (confidence: ${result.confidence})`);

  return { agentResults: [result] };
}
