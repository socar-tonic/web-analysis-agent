// src/agents/search-graph/nodes/compare-spec.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, SpecChanges, CapturedApiSchema } from '../state.js';
import { getNodeContext } from '../index.js';

const COMPARE_SPEC_PROMPT = `You are comparing captured network requests from a browser session with the expected API specification.

## Your Task
1. Compare the captured search API with the spec to detect any changes
2. If changes detected, extract the FULL schema of the new API for spec updates

## Input You'll Receive
1. Captured network requests (URLs, methods, request/response bodies)
2. Spec's expected search API (endpoint pattern, method)

## What to Compare

### API Endpoint Comparison
- The spec may use template variables like \`{{siteId}}\`, \`{{storeId}}\` - these should be treated as wildcards
- Compare the PATH portion of URLs, not query parameters
- Example: spec "/in.store/{{siteId}}" should match captured "/in.store/12345"
- Example: spec "/api/v1/search" does NOT match captured "/api/v2/search" - this is a CHANGE

### HTTP Method Comparison
- Compare GET vs POST vs PUT etc.

## Response Format (JSON only, no markdown)

When changes ARE detected:
{
  "hasChanges": true,
  "changeType": "api",
  "changes": ["API 엔드포인트 변경: /old/path -> /new/path"],
  "codeWillBreak": true,
  "capturedApiSchema": {
    "endpoint": "/o.traffic/{{siteId}}",
    "method": "GET",
    "params": {
      "sortBy": "string (예: inTime-1)",
      "searchType": "string (예: NOT_OUT)",
      "plateNumber": "string (차량번호 4자리)",
      "inTimeGTE": "number (timestamp, 검색 시작일)",
      "inTimeLTE": "number (timestamp, 검색 종료일)",
      "rows": "number (결과 개수)"
    },
    "responseSchema": {
      "type": "array",
      "fields": ["id", "plateNumber", "inTime", "outTime", "parkingFee"],
      "sample": {"id": "...", "plateNumber": "1234", "inTime": 1234567890}
    }
  },
  "reasoning": "Explanation"
}

When NO changes detected or no API calls captured:
{
  "hasChanges": false,
  "changeType": null,
  "changes": [],
  "codeWillBreak": false,
  "reasoning": "Explanation"
}

IMPORTANT: For capturedApiSchema:
- endpoint: Replace dynamic IDs with template variables like {{siteId}}, {{storeId}}
- params: Describe each query parameter with its type and example
- responseSchema: Extract field names from the response, include sample values`;

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

  // Build full context for LLM (including request/response bodies for schema extraction)
  const capturedRequestsFull = state.capturedRequests.map(r => {
    // Parse query params from URL
    let params: Record<string, string> = {};
    try {
      const urlObj = new URL(r.url);
      urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
      });
    } catch { /* ignore invalid URLs */ }

    return {
      url: r.url,
      method: r.method || 'GET',
      status: r.responseStatus,
      params: Object.keys(params).length > 0 ? params : undefined,
      requestBody: r.requestBody,
      responseBody: r.responseBody,
    };
  });

  // Create a tool to get comparison data with full details
  const getComparisonDataTool = tool(
    async () => {
      return JSON.stringify({
        specSearchApi: searchApi,
        capturedRequests: capturedRequestsFull,
      }, null, 2);
    },
    {
      name: 'get_comparison_data',
      description: 'Get the spec search API and captured network requests (including params and response bodies) for comparison and schema extraction',
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
      // Handle markdown code blocks
      let jsonStr = finalResponse;
      const codeBlockMatch = finalResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        specChanges = {
          hasChanges: parsed.hasChanges || false,
          changeType: parsed.changeType || null,
          changes: parsed.changes || [],
          codeWillBreak: parsed.codeWillBreak || false,
        };

        // Extract captured API schema if present
        if (parsed.capturedApiSchema) {
          specChanges.capturedApiSchema = {
            endpoint: parsed.capturedApiSchema.endpoint,
            method: parsed.capturedApiSchema.method,
            params: parsed.capturedApiSchema.params,
            requestBody: parsed.capturedApiSchema.requestBody,
            responseSchema: parsed.capturedApiSchema.responseSchema,
          };
        }
      }
    } catch (e) {
      console.log(`  [compareSpec] Failed to parse response: ${(e as Error).message}`);
    }

    if (specChanges.hasChanges) {
      console.log(`  [compareSpec] Changes detected (${specChanges.changes.length}):`);
      for (const change of specChanges.changes) {
        console.log(`    - ${change}`);
      }

      // Log captured API schema if present
      if (specChanges.capturedApiSchema) {
        console.log('  [compareSpec] Captured API Schema:');
        console.log(`    endpoint: ${specChanges.capturedApiSchema.method} ${specChanges.capturedApiSchema.endpoint}`);
        if (specChanges.capturedApiSchema.params) {
          console.log('    params:', JSON.stringify(specChanges.capturedApiSchema.params, null, 2).split('\n').map(l => '      ' + l).join('\n'));
        }
        if (specChanges.capturedApiSchema.responseSchema) {
          console.log('    responseSchema:', JSON.stringify(specChanges.capturedApiSchema.responseSchema, null, 2).split('\n').map(l => '      ' + l).join('\n'));
        }
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
