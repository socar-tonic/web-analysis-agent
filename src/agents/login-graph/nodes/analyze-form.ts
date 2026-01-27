// src/agents/login-graph/nodes/analyze-form.ts
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { LoginGraphStateType, FormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const ANALYZE_FORM_PROMPT = `Analyze the DOM snapshot and find login form elements.

Look for:
- Username/ID field: input with name/id containing "user", "id", "login", "email", "account", "j_username", or type="text" near password field
- Password field: input with type="password" or name/id containing "pass", "pw", "pwd", "j_password"
- Submit button: button or input with type="submit", or text like "로그인", "Login", "Sign in", "확인"

IMPORTANT: Return element refs like "e12", "e18" from the snapshot, NOT CSS selectors like "#username".

Return ONLY valid JSON (no markdown, no explanation):
{
  "usernameRef": "e12",
  "passwordRef": "e18",
  "submitRef": "e14"
}

If you cannot find a field, use null for that field.`;

export async function analyzeForm(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm } = ctx;

  console.log('  [analyzeForm] Taking snapshot and analyzing with LLM...');

  try {
    // Take snapshot
    const snapshotResult = await mcpClient.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const snapshot = extractTextFromMcpResult(snapshotResult);

    // Ask LLM to analyze
    const response = await llm.invoke([
      new SystemMessage(ANALYZE_FORM_PROMPT),
      new HumanMessage(`DOM Snapshot:\n${snapshot}`),
    ]);

    const content = typeof response.content === 'string' ? response.content : '';
    console.log(`  [analyzeForm] LLM response: ${content.slice(0, 200)}...`);

    // Parse JSON response
    let formElements: FormElements = {
      usernameRef: null,
      passwordRef: null,
      submitRef: null,
    };

    try {
      // Try to extract JSON from response
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
      console.log(`  [analyzeForm] Failed to parse LLM response: ${(e as Error).message}`);
    }

    console.log(`  [analyzeForm] Found: username=${formElements.usernameRef}, password=${formElements.passwordRef}, submit=${formElements.submitRef}`);

    return {
      snapshot,
      formElements,
    };
  } catch (e) {
    console.log(`  [analyzeForm] Error: ${(e as Error).message}`);
    return {
      formElements: {
        usernameRef: null,
        passwordRef: null,
        submitRef: null,
      },
    };
  }
}
