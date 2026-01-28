// src/agents/search-graph/nodes/analyze-search-method.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, SearchFormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const ANALYZE_PROMPT = `You are analyzing a page after successful login to find vehicle search functionality.

## Your Task
Find the search input field, search button, or numeric keypad used for vehicle number search.

## How to Search

1. First use browser_snapshot to get the current DOM structure
2. Look for search-related elements:
   - Text input for vehicle/car number (type="text", name/id containing: car, vehicle, 차량, 번호, carNo, plateNo, searchKey)
   - Search button (text: 조회, 검색, Search, 찾기, 확인)
   - Numeric keypad (buttons 0-9 arranged for digit input)
3. Use browser_evaluate to verify selectors work if needed

## Element Reference Format
The snapshot shows elements with refs like "e12", "e18". Example:
  e12: <input type="text" name="carNo" placeholder="차량번호">
  e18: <button type="button">조회</button>
  e30-e39: <button>0</button> ... <button>9</button> (keypad)

## Response Format (JSON)
Return ONLY valid JSON:
{
  "found": true,
  "searchInputRef": "e12",
  "searchInputSelector": "input[name='carNo']",
  "searchButtonRef": "e18",
  "searchButtonSelector": "button:contains('조회')",
  "isKeypad": false,
  "confidence": 0.9,
  "reasoning": "Found input with name='carNo' and search button"
}

If elements are not found:
{
  "found": false,
  "searchInputRef": null,
  "searchInputSelector": null,
  "searchButtonRef": null,
  "searchButtonSelector": null,
  "isKeypad": false,
  "confidence": 0,
  "reasoning": "Could not find search input or button in the DOM"
}`;

export async function analyzeSearchMethod(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [analyzeSearchMethod] Starting agent-based DOM analysis...');

  // Build tools for the agent
  const browserSnapshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {},
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_snapshot',
      description: 'Take a DOM snapshot of the current page to analyze structure',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  const browserEvaluateTool = tool(
    async ({ code }: { code: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_evaluate',
      description: 'Evaluate JavaScript to find elements or test selectors. Pass JavaScript code that returns a value.',
      schema: z.object({
        code: z.string().describe('JavaScript code to evaluate in the browser'),
      }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserEvaluateTool],
      systemPrompt: ANALYZE_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('Analyze the page and find the vehicle search method.')] },
      { recursionLimit: 10 }
    );

    // Extract final response from last AI message
    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        finalResponse = msg.content;
        break;
      }
    }

    console.log(`  [analyzeSearchMethod] Agent response: ${finalResponse.slice(0, 200)}...`);

    // Parse JSON response
    const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.found) {
        const formElements: SearchFormElements = {
          searchInputRef: parsed.searchInputRef || null,
          searchInputSelector: parsed.searchInputSelector || null,
          searchButtonRef: parsed.searchButtonRef || null,
          searchButtonSelector: parsed.searchButtonSelector || null,
        };

        console.log(
          `  [analyzeSearchMethod] Found: input=${formElements.searchInputRef}, button=${formElements.searchButtonRef}, isKeypad=${parsed.isKeypad}`
        );

        return {
          searchMethod: 'dom',
          analysisSource: 'dom_analysis',
          formElements,
          confidence: parsed.confidence || 0.8,
        };
      }
    }

    console.log('  [analyzeSearchMethod] Agent could not find search elements');
    return { searchMethod: 'unknown' };
  } catch (e) {
    console.log(`  [analyzeSearchMethod] Error: ${(e as Error).message}`);
    return { searchMethod: 'unknown' };
  }
}
