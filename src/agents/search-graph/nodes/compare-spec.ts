// src/agents/search-graph/nodes/compare-spec.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, SpecChanges } from '../state.js';
import { getNodeContext } from '../index.js';

const COMPARE_SPEC_PROMPT = `You are comparing captured network requests from a browser session with the expected API specification.

## Your Task
Analyze the captured network requests and compare them with the spec's search API definition to detect any changes.

## Input You'll Receive
1. Captured network requests (URLs, methods, response status)
2. Spec's expected search API (endpoint pattern, method)

## What to Compare

### API Endpoint Comparison
- The spec may use template variables like \`{{siteId}}\`, \`{{storeId}}\` - these should be treated as wildcards
- Compare the PATH portion of URLs, not query parameters
- Example: spec "/in.store/{{siteId}}" should match captured "/in.store/12345"
- Example: spec "/api/v1/search" does NOT match captured "/api/v2/search" - this is a CHANGE

### HTTP Method Comparison
- Compare GET vs POST vs PUT etc.
- Method change indicates API signature change

## Response Format (JSON only, no markdown)
{
  "hasChanges": true/false,
  "changeType": "api" | "dom" | "both" | null,
  "changes": [
    "API 엔드포인트 변경: /old/path -> /new/path",
    "API 메서드 변경: GET -> POST"
  ],
  "codeWillBreak": true/false,
  "reasoning": "Explanation of comparison"
}

If no search-related API calls were captured:
{
  "hasChanges": false,
  "changeType": null,
  "changes": [],
  "codeWillBreak": false,
  "reasoning": "No search API calls were captured to compare"
}`;

/**
 * Extract search API info from spec (handles multiple formats)
 */
function getSearchApiFromSpec(spec: any): { endpoint: string; method: string } | null {
  if (spec.api?.endpoint) {
    return { endpoint: spec.api.endpoint, method: spec.api.method || 'GET' };
  }
  if (spec.steps?.search?.endpoint) {
    return { endpoint: spec.steps.search.endpoint, method: spec.steps.search.method || 'GET' };
  }
  return null;
}

/**
 * compareSpec node - Uses LLM to compare captured network requests with spec.
 *
 * Changed to createAgent pattern because:
 * - Template variable matching requires flexible interpretation
 * - Multiple spec formats need intelligent handling
 * - URL normalization and comparison is nuanced
 */
export async function compareSpec(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const existingSpec = state.spec as any;

  console.log('  [compareSpec] Starting LLM-based spec comparison...');

  // If no spec, nothing to compare
  if (!existingSpec) {
    console.log('  [compareSpec] No existing spec to compare');
    return {
      specChanges: {
        hasChanges: false,
        changeType: null,
        changes: [],
        codeWillBreak: false,
      },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }

  // Extract search API from spec
  const searchApi = getSearchApiFromSpec(existingSpec);
  if (!searchApi) {
    console.log('  [compareSpec] No search API found in spec');
    return {
      specChanges: {
        hasChanges: false,
        changeType: null,
        changes: [],
        codeWillBreak: false,
      },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }

  // If no captured requests, nothing to compare
  if (state.capturedRequests.length === 0) {
    console.log('  [compareSpec] No network requests captured');
    return {
      specChanges: {
        hasChanges: false,
        changeType: null,
        changes: [],
        codeWillBreak: false,
      },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }

  console.log(`  [compareSpec] Spec search API: ${searchApi.method} ${searchApi.endpoint}`);
  console.log(`  [compareSpec] Captured ${state.capturedRequests.length} network requests`);

  // Build context for LLM
  const capturedRequestsSummary = state.capturedRequests.map(r => ({
    url: r.url,
    method: r.method || 'GET',
    status: r.responseStatus,
  }));

  // Create a simple tool to get comparison data
  const getComparisonDataTool = tool(
    async () => {
      return JSON.stringify({
        specSearchApi: searchApi,
        capturedRequests: capturedRequestsSummary,
      }, null, 2);
    },
    {
      name: 'get_comparison_data',
      description: 'Get the spec search API and captured network requests for comparison',
      schema: z.object({
        _unused: z.string().optional(),
      }),
    }
  );

  try {
    const agent = createAgent({
      model: ctx.llm,
      tools: [getComparisonDataTool],
      systemPrompt: COMPARE_SPEC_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('Compare the captured network requests with the spec search API. Use get_comparison_data tool first.')] },
      { recursionLimit: 6 }
    );

    // Extract response
    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        finalResponse = msg.content;
        break;
      }
    }

    console.log(`  [compareSpec] LLM response: ${finalResponse.slice(0, 300)}...`);

    // Parse result
    let specChanges: SpecChanges = {
      hasChanges: false,
      changeType: null,
      changes: [],
      codeWillBreak: false,
    };

    try {
      const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        specChanges = {
          hasChanges: parsed.hasChanges || false,
          changeType: parsed.changeType || null,
          changes: parsed.changes || [],
          codeWillBreak: parsed.codeWillBreak || false,
        };
      }
    } catch (e) {
      console.log(`  [compareSpec] Failed to parse response: ${(e as Error).message}`);
    }

    if (specChanges.hasChanges) {
      console.log(`  [compareSpec] Changes detected (${specChanges.changes.length}):`);
      for (const change of specChanges.changes) {
        console.log(`    - ${change}`);
      }
    } else {
      console.log('  [compareSpec] No changes detected');
    }

    const readyForDiscount = state.status === 'SUCCESS' && !specChanges.hasChanges;
    if (readyForDiscount) {
      console.log('  [compareSpec] Ready for DiscountGraph handoff');
    }

    return { specChanges, readyForDiscount };
  } catch (e) {
    console.log(`  [compareSpec] Error: ${(e as Error).message}`);
    return {
      specChanges: {
        hasChanges: false,
        changeType: null,
        changes: [],
        codeWillBreak: false,
      },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }
}
