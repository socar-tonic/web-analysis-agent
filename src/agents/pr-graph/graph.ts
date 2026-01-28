// src/agents/pr-graph/graph.ts
import { END, START, StateGraph } from '@langchain/langgraph';
import { PRGraphState } from './state.js';
import { routeAfterLoadContext, routeAfterGenerateFix } from './routes.js';
import { loadContext } from './nodes/load-context.js';
import { generateFix } from './nodes/generate-fix.js';
import { createPR } from './nodes/create-pr.js';

export function buildPRGraph() {
  const workflow = new StateGraph(PRGraphState)
    .addNode('loadContext', loadContext)
    .addNode('generateFix', generateFix)
    .addNode('createPR', createPR)

    .addEdge(START, 'loadContext')
    .addConditionalEdges('loadContext', routeAfterLoadContext, {
      generateFix: 'generateFix',
      [END]: END,
    })
    .addConditionalEdges('generateFix', routeAfterGenerateFix, {
      createPR: 'createPR',
      [END]: END,
    })
    .addEdge('createPR', END);

  return workflow.compile();
}
