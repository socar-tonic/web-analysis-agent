// src/agents/login-graph/nodes/verify-result.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { LoginGraphStateType, LoginStatus, SpecChanges } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const VERIFY_PROMPT = `You are analyzing the result of a login attempt and comparing it against the existing spec.

## Current State
- Current URL: {currentUrl}
- URL Changed: {urlChanged}
- Form Elements Used: {formElements}
- Network Requests Captured: {capturedNetworkRequests}

## Existing Spec (for comparison)
{spec}

## Your Tasks

### 1. Verify Login Result
Take a snapshot and screenshot to analyze the login result:
- SUCCESS: User is logged in (dashboard, welcome message, user info visible, URL changed to member area)
- INVALID_CREDENTIALS: Login failed due to wrong username/password (error message visible, "잘못된 비밀번호", "로그인 실패", etc.)
- FORM_CHANGED: The login form structure has changed (selectors don't match, form not found)
- UNKNOWN_ERROR: Cannot determine the result

### 2. Compare with Spec (if spec exists)
Compare the captured behavior against the existing spec:

**For API-based specs (steps.login.type === "api"):**
- Check if the login endpoint URL matches spec.steps.login.endpoint
- Check if the HTTP method matches spec.steps.login.method
- Check if request fields match spec.steps.login.requestFields
- Check if response contains expected fields from spec.steps.login.responseFields

**For DOM-based specs (form or hints.login exists):**
- Check if the username selector matches spec.form.usernameSelector or spec.hints.login.usernameSelector
- Check if the password selector matches spec.form.passwordSelector or spec.hints.login.passwordSelector
- Check if the submit selector matches spec.form.submitSelector or spec.hints.login.submitSelector

Report any differences as spec changes.

## Response Format (JSON)
{
  "status": "SUCCESS|INVALID_CREDENTIALS|FORM_CHANGED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "errorMessage": "optional error message",
  "specChanges": {
    "hasChanges": true/false,
    "changeType": "dom|api|both|null",
    "changes": ["list of detected changes in Korean"]
  }
}`;

export async function verifyResult(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [verifyResult] Analyzing login result with agent...');

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
      description: 'Take a DOM snapshot of the current page',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  const browserScreenshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_take_screenshot',
        arguments: { type: 'png' },
      });
      const contents = result.content as any[];
      for (const c of contents) {
        if (c.type === 'image' && c.data) {
          const filename = `verify-screenshot-${Date.now()}.png`;
          writeFileSync(filename, Buffer.from(c.data, 'base64'));
          console.log(`      [verifyResult] Screenshot saved: ${filename}`);
          return `Screenshot saved to ${filename}. The page shows the current state after login attempt.`;
        }
      }
      return 'No screenshot captured';
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take a screenshot of the current page',
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
      description: 'Evaluate JavaScript code in the browser',
      schema: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
    }
  );

  try {
    // Prepare spec info for the prompt
    const specInfo = state.spec
      ? JSON.stringify(state.spec, null, 2)
      : 'No existing spec available for comparison.';

    // Create agent with tools
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserScreenshotTool, browserEvaluateTool],
      systemPrompt: VERIFY_PROMPT
        .replace('{currentUrl}', state.currentUrl)
        .replace('{urlChanged}', String(state.currentUrl !== state.url))
        .replace('{formElements}', JSON.stringify(state.formElements))
        .replace('{capturedNetworkRequests}', JSON.stringify(state.capturedNetworkRequests.slice(0, 10), null, 2))
        .replace('{spec}', specInfo),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('Analyze the login result and determine if login was successful.')] },
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

    console.log(`  [verifyResult] Agent response: ${finalResponse.slice(0, 300)}...`);

    // Parse result
    let status: LoginStatus = 'UNKNOWN_ERROR';
    let confidence = 0.5;
    let errorMessage: string | null = null;
    let specChanges: SpecChanges | null = null;

    try {
      // Extract JSON from response - handle markdown code blocks and multiple JSON objects
      let jsonStr = finalResponse;

      // Remove markdown code block if present
      const codeBlockMatch = finalResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // Find the first complete JSON object (handle nested braces)
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Try to parse, if fails try to find a valid JSON by trimming
        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          // Try to find a simpler JSON pattern (first object only)
          const simpleMatch = jsonStr.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
          if (simpleMatch) {
            parsed = JSON.parse(simpleMatch[0]);
          } else {
            throw new Error('No valid JSON found');
          }
        }
        status = parsed.status || 'UNKNOWN_ERROR';
        confidence = parsed.confidence || 0.5;
        errorMessage = parsed.errorMessage || null;

        // Parse spec changes if present
        if (parsed.specChanges) {
          specChanges = {
            hasChanges: parsed.specChanges.hasChanges || false,
            changeType: parsed.specChanges.changeType || null,
            changes: parsed.specChanges.changes || [],
          };
        }
      }
    } catch (e) {
      console.log(`  [verifyResult] Failed to parse response: ${(e as Error).message}`);
    }

    console.log(`  [verifyResult] Result: status=${status}, confidence=${confidence}`);
    if (specChanges?.hasChanges) {
      console.log(`  [verifyResult] Spec changes detected: ${specChanges.changes.join(', ')}`);
    }

    return {
      status,
      confidence,
      errorMessage,
      specChanges,
    };
  } catch (e) {
    console.log(`  [verifyResult] Error: ${(e as Error).message}`);
    return {
      status: 'UNKNOWN_ERROR',
      confidence: 0,
      errorMessage: `Verification failed: ${(e as Error).message}`,
    };
  }
}
