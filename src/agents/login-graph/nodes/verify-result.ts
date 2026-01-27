// src/agents/login-graph/nodes/verify-result.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { LoginGraphStateType, LoginStatus } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const VERIFY_PROMPT = `You are analyzing the result of a login attempt.

Current URL: {currentUrl}
URL Changed: {urlChanged}
Network Requests: {networkRequests}

Your task:
1. Take a snapshot of the current page using browser_snapshot
2. Take a screenshot using browser_take_screenshot to see what the user would see
3. Analyze the page content and determine the login result

Determine the login status:
- SUCCESS: User is logged in (dashboard, welcome message, user info visible, URL changed to member area)
- INVALID_CREDENTIALS: Login failed due to wrong username/password (error message visible, "잘못된 비밀번호", "로그인 실패", etc.)
- FORM_CHANGED: The login form structure has changed (selectors don't match, form not found)
- UNKNOWN_ERROR: Cannot determine the result

After analysis, provide your final answer as JSON:
{
  "status": "SUCCESS|INVALID_CREDENTIALS|FORM_CHANGED|UNKNOWN_ERROR",
  "confidence": 0.0-1.0,
  "errorMessage": "optional error message"
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
    // Create agent with tools
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserScreenshotTool, browserEvaluateTool],
      systemPrompt: VERIFY_PROMPT
        .replace('{currentUrl}', state.currentUrl)
        .replace('{urlChanged}', String(state.currentUrl !== state.url))
        .replace('{networkRequests}', JSON.stringify(state.networkRequests.slice(0, 5))),
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

    try {
      const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        status = parsed.status || 'UNKNOWN_ERROR';
        confidence = parsed.confidence || 0.5;
        errorMessage = parsed.errorMessage || null;
      }
    } catch (e) {
      console.log(`  [verifyResult] Failed to parse response: ${(e as Error).message}`);
    }

    console.log(`  [verifyResult] Result: status=${status}, confidence=${confidence}`);

    return {
      status,
      confidence,
      errorMessage,
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
