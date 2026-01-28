// src/agents/search-graph/graph.ts
import { END, START, StateGraph } from '@langchain/langgraph';
import { SearchGraphState } from './state.js';
import {
  routeAfterAnalyze,
  routeAfterScreenshot,
  routeAfterHint,
  routeAfterSpecFallback,
  routeAfterApiSearch,
  routeAfterSearch,
  routeAfterCapture,
} from './routes.js';

// Node imports
import { loadSpec } from './nodes/load-spec.js';
import { analyzeSearchMethod } from './nodes/analyze-search-method.js';
import { screenshotFallback } from './nodes/screenshot-fallback.js';
import { hintFallback } from './nodes/hint-fallback.js';
import { specFallback } from './nodes/spec-fallback.js';
import { executeApiSearch } from './nodes/execute-api-search.js';
import { executeSearch } from './nodes/execute-search.js';
import { captureResults } from './nodes/capture-results.js';
import { compareSpec } from './nodes/compare-spec.js';

export function buildSearchGraph() {
  const workflow = new StateGraph(SearchGraphState)
    // Add all 9 nodes
    .addNode('loadSpec', loadSpec)
    .addNode('analyzeSearchMethod', analyzeSearchMethod)
    .addNode('screenshotFallback', screenshotFallback)
    .addNode('hintFallback', hintFallback)
    .addNode('specFallback', specFallback)
    .addNode('executeApiSearch', executeApiSearch)
    .addNode('executeSearch', executeSearch)
    .addNode('captureResults', captureResults)
    .addNode('compareSpec', compareSpec)

    // Entry point: START -> loadSpec -> analyzeSearchMethod
    .addEdge(START, 'loadSpec')
    .addEdge('loadSpec', 'analyzeSearchMethod')

    // Fallback chain with conditional routing
    // analyzeSearchMethod -> screenshotFallback | executeSearch | executeApiSearch
    .addConditionalEdges('analyzeSearchMethod', routeAfterAnalyze, {
      screenshotFallback: 'screenshotFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })

    // screenshotFallback -> hintFallback | executeSearch | executeApiSearch
    .addConditionalEdges('screenshotFallback', routeAfterScreenshot, {
      hintFallback: 'hintFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })

    // hintFallback -> specFallback | executeSearch | executeApiSearch
    .addConditionalEdges('hintFallback', routeAfterHint, {
      specFallback: 'specFallback',
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
    })

    // specFallback -> executeSearch | executeApiSearch | END
    .addConditionalEdges('specFallback', routeAfterSpecFallback, {
      executeSearch: 'executeSearch',
      executeApiSearch: 'executeApiSearch',
      [END]: END,
    })

    // Search execution paths
    // executeApiSearch -> compareSpec | END (API는 다음 화면 불가하지만 spec 비교는 필요)
    .addConditionalEdges('executeApiSearch', routeAfterApiSearch, {
      compareSpec: 'compareSpec',
      [END]: END,
    })

    // executeSearch -> captureResults | END
    .addConditionalEdges('executeSearch', routeAfterSearch, {
      captureResults: 'captureResults',
      [END]: END,
    })

    // Results analysis and spec comparison
    // captureResults -> compareSpec | END
    .addConditionalEdges('captureResults', routeAfterCapture, {
      compareSpec: 'compareSpec',
      [END]: END,
    })

    // compareSpec -> END (final node)
    .addEdge('compareSpec', END);

  return workflow.compile();
}
