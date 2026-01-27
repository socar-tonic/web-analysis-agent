// src/agents/login-graph/nodes/screenshot-fallback.ts
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { writeFileSync } from 'fs';
import type { LoginGraphStateType, FormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const SCREENSHOT_ANALYZE_PROMPT = `Analyze this login page screenshot and the DOM snapshot.

Find the login form elements by looking at:
1. The visual layout in the screenshot
2. The element refs in the DOM snapshot

Look for:
- Username/ID input field
- Password input field
- Login/Submit button

IMPORTANT: Return element refs like "e12", "e18" from the DOM snapshot, NOT CSS selectors.

Return ONLY valid JSON (no markdown, no explanation):
{
  "usernameRef": "e12",
  "passwordRef": "e18",
  "submitRef": "e14"
}

If you cannot find a field, use null for that field.`;

export async function screenshotFallback(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [screenshotFallback] Taking screenshot for visual analysis...');

  try {
    // Take screenshot
    const screenshotResult = await mcpClient.callTool({
      name: 'browser_take_screenshot',
      arguments: { type: 'png' },
    });

    // Save screenshot and get base64 data
    const contents = screenshotResult.content as any[];
    let screenshotBase64: string | null = null;
    let screenshotPath: string | null = null;

    for (const c of contents) {
      if (c.type === 'image' && c.data) {
        screenshotBase64 = c.data;
        screenshotPath = `login-screenshot-${Date.now()}.png`;
        writeFileSync(screenshotPath, Buffer.from(c.data, 'base64'));
        console.log(`  [screenshotFallback] Screenshot saved: ${screenshotPath}`);
        break;
      }
    }

    if (!screenshotBase64) {
      console.log('  [screenshotFallback] No screenshot data received');
      return {
        screenshot: null,
        formElements: state.formElements, // Keep existing
      };
    }

    // Take fresh snapshot
    const snapshotResult = await mcpClient.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const snapshot = extractTextFromMcpResult(snapshotResult);

    // Ask LLM to analyze with both image and snapshot
    const response = await llm.invoke([
      new SystemMessage(SCREENSHOT_ANALYZE_PROMPT),
      new HumanMessage([
        { type: 'text', text: `DOM Snapshot:\n${snapshot}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
      ]),
    ]);

    const content = typeof response.content === 'string' ? response.content : '';
    console.log(`  [screenshotFallback] LLM response: ${content.slice(0, 200)}...`);

    // Parse JSON response
    let formElements: FormElements = {
      usernameRef: null,
      passwordRef: null,
      submitRef: null,
    };

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        formElements = {
          usernameRef: parsed.usernameRef || null,
          passwordRef: parsed.passwordRef || null,
          submitRef: parsed.submitRef || null,
        };
      }
    } catch (e) {
      console.log(`  [screenshotFallback] Failed to parse LLM response: ${(e as Error).message}`);
    }

    console.log(`  [screenshotFallback] Found: username=${formElements.usernameRef}, password=${formElements.passwordRef}, submit=${formElements.submitRef}`);

    // If still no form elements, set status
    if (!formElements.usernameRef && !formElements.submitRef) {
      return {
        screenshot: screenshotPath,
        snapshot,
        formElements,
        status: 'FORM_NOT_FOUND',
        errorMessage: 'Could not find login form elements after screenshot analysis',
      };
    }

    return {
      screenshot: screenshotPath,
      snapshot,
      formElements,
    };
  } catch (e) {
    console.log(`  [screenshotFallback] Error: ${(e as Error).message}`);
    return {
      formElements: state.formElements,
      status: 'UNKNOWN_ERROR',
      errorMessage: `Screenshot analysis failed: ${(e as Error).message}`,
    };
  }
}
