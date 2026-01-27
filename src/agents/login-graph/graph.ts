// src/agents/login-graph/graph.ts
import { END, START, StateGraph } from '@langchain/langgraph';
import { LoginGraphState } from './state.js';
import {
  routeAfterConnection,
  routeAfterAnalysis,
  routeAfterScreenshot,
  routeAfterVerify,
} from './routes.js';

// Node imports (will be implemented in Task 2 & 3)
import { checkConnection } from './nodes/check-connection.js';
import { analyzeForm } from './nodes/analyze-form.js';
import { screenshotFallback } from './nodes/screenshot-fallback.js';
import { fillCredentials } from './nodes/fill-credentials.js';
import { clickLogin } from './nodes/click-login.js';
import { verifyResult } from './nodes/verify-result.js';
import { extractSession } from './nodes/extract-session.js';

export function buildLoginGraph() {
  const workflow = new StateGraph(LoginGraphState)
    // Add nodes
    .addNode('checkConnection', checkConnection)
    .addNode('analyzeForm', analyzeForm)
    .addNode('screenshotFallback', screenshotFallback)
    .addNode('fillCredentials', fillCredentials)
    .addNode('clickLogin', clickLogin)
    .addNode('verifyResult', verifyResult)
    .addNode('extractSession', extractSession)

    // Entry point
    .addEdge(START, 'checkConnection')

    // Conditional edges
    .addConditionalEdges('checkConnection', routeAfterConnection, {
      analyzeForm: 'analyzeForm',
      [END]: END,
    })
    .addConditionalEdges('analyzeForm', routeAfterAnalysis, {
      fillCredentials: 'fillCredentials',
      screenshotFallback: 'screenshotFallback',
    })
    .addConditionalEdges('screenshotFallback', routeAfterScreenshot, {
      fillCredentials: 'fillCredentials',
      [END]: END,
    })

    // Fixed edges
    .addEdge('fillCredentials', 'clickLogin')
    .addEdge('clickLogin', 'verifyResult')

    // Conditional edge after verify
    .addConditionalEdges('verifyResult', routeAfterVerify, {
      extractSession: 'extractSession',
      [END]: END,
    })

    // Final edge
    .addEdge('extractSession', END);

  return workflow.compile();
}
