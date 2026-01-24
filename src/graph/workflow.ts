import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentStateAnnotation, AgentState } from './state.js';
import {
  createAnalyzeNode,
  createHeuristicDiagnoseNode,
  createAggregatorNode,
  createNotifyNode,
  WorkflowConfig,
} from './nodes.js';
import { domAgentNode } from './agents/dom-agent.js';
import { networkAgentNode } from './agents/network-agent.js';
import { policyAgentNode } from './agents/policy-agent.js';

/**
 * Routing function: determines whether to run LLM agents or skip to heuristic
 */
function routeAfterAnalysis(state: AgentState): string[] {
  if (state.error) {
    return ['heuristic_diagnose'];
  }

  if (!state.requiresLLMAnalysis) {
    // Connection failed or server error - use heuristic diagnosis
    return ['heuristic_diagnose'];
  }

  // Connection successful - run all agents in parallel
  return ['dom_agent', 'network_agent', 'policy_agent'];
}

/**
 * Creates the multi-agent analysis workflow
 *
 * Flow:
 * 1. analyze: Playwright site analysis
 * 2. Route based on connection status:
 *    - Connection failed → heuristic_diagnose → notify
 *    - Connection success → [dom_agent, network_agent, policy_agent] (parallel) → aggregator → notify
 */
export function createWorkflow(config: WorkflowConfig) {
  const analyzeNode = createAnalyzeNode();
  const heuristicDiagnoseNode = createHeuristicDiagnoseNode();
  const aggregatorNode = createAggregatorNode();
  const notifyNode = createNotifyNode(config);

  const workflow = new StateGraph(AgentStateAnnotation)
    // Core nodes
    .addNode('analyze', analyzeNode)
    .addNode('heuristic_diagnose', heuristicDiagnoseNode)

    // Multi-agent nodes (run in parallel)
    .addNode('dom_agent', domAgentNode)
    .addNode('network_agent', networkAgentNode)
    .addNode('policy_agent', policyAgentNode)

    // Aggregator and output
    .addNode('aggregator', aggregatorNode)
    .addNode('notify', notifyNode)

    // Edges
    .addEdge(START, 'analyze')

    // Conditional routing after analysis
    .addConditionalEdges('analyze', routeAfterAnalysis, [
      'heuristic_diagnose',
      'dom_agent',
      'network_agent',
      'policy_agent',
    ])

    // Heuristic path
    .addEdge('heuristic_diagnose', 'notify')

    // Multi-agent path: all agents → aggregator
    .addEdge('dom_agent', 'aggregator')
    .addEdge('network_agent', 'aggregator')
    .addEdge('policy_agent', 'aggregator')
    .addEdge('aggregator', 'notify')

    // End
    .addEdge('notify', END);

  return workflow.compile();
}
