// src/agents/search-graph/nodes/screenshot-fallback.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, SearchFormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const SCREENSHOT_PROMPT = `DOM analysis failed to find search elements. Use visual analysis of a screenshot to find the vehicle search UI.

## Your Task
1. Take a screenshot to visually see the page
2. Take a DOM snapshot to cross-reference element refs
3. Match what you see visually with element refs in the DOM

## What to Look For

**Search Input Field:**
- Text input for vehicle/car number (차량번호, 번호판, 차량검색)
- May show placeholder text like "차량번호 입력", "검색어 입력"
- Usually a visible text box near the top or center

**Numeric Keypad:**
- Buttons 0-9 arranged in grid (like phone keypad or calculator)
- Used for entering vehicle number digits
- May have delete/clear button

**Search Button:**
- Button labeled: 조회, 검색, Search, 찾기, 확인
- Usually prominent/highlighted button
- Often blue or primary colored

## Response Format (JSON)
Return ONLY valid JSON:
{
  "found": true,
  "inputType": "text|keypad",
  "searchInputRef": "e12",
  "searchInputSelector": "input[name='carNo']",
  "searchButtonRef": "e18",
  "searchButtonSelector": "button.search-btn",
  "description": "Found text input with placeholder '차량번호' and blue 조회 button"
}

If elements are NOT found:
{
  "found": false,
  "inputType": null,
  "searchInputRef": null,
  "searchInputSelector": null,
  "searchButtonRef": null,
  "searchButtonSelector": null,
  "description": "Could not identify search UI elements in the screenshot"
}`;

export async function screenshotFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [screenshotFallback] Starting visual analysis with agent...');

  // Build tools for the agent
  const browserScreenshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_take_screenshot',
        arguments: { type: 'png' },
      });
      const contents = result.content as any[];
      for (const c of contents) {
        if (c.type === 'image' && c.data) {
          const filename = `search-screenshot-${Date.now()}.png`;
          writeFileSync(filename, Buffer.from(c.data, 'base64'));
          console.log(`      [screenshotFallback] Screenshot saved: ${filename}`);
          return `Screenshot saved to ${filename}. Analyze this image to find search UI elements like input fields, keypads, or search buttons.`;
        }
      }
      return 'No screenshot captured';
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take a screenshot of the current page for visual analysis of search UI',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

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
      description: 'Take a DOM snapshot to cross-reference with visual findings and get element refs',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserScreenshotTool, browserSnapshotTool],
      systemPrompt: SCREENSHOT_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('Take a screenshot and analyze it to find the vehicle search UI elements.')] },
      { recursionLimit: 8 }
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

    console.log(`  [screenshotFallback] Agent response: ${finalResponse.slice(0, 200)}...`);

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

        console.log(`  [screenshotFallback] Found: ${parsed.description}`);
        console.log(
          `  [screenshotFallback] Elements: input=${formElements.searchInputRef}, button=${formElements.searchButtonRef}, type=${parsed.inputType}`
        );

        return {
          searchMethod: 'dom',
          analysisSource: 'screenshot',
          formElements,
        };
      }
    }

    console.log('  [screenshotFallback] Visual analysis could not find search UI');
    return { searchMethod: 'unknown' };
  } catch (e) {
    console.log(`  [screenshotFallback] Error: ${(e as Error).message}`);
    return { searchMethod: 'unknown' };
  }
}
