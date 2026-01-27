// src/agents/login-graph/nodes/analyze-form.ts
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { LoginGraphStateType, FormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const ANALYZE_FORM_PROMPT = `Analyze the Playwright MCP DOM snapshot and find login form elements.

**SNAPSHOT FORMAT:**
The snapshot shows elements with refs like "e12", "e18". Each line shows:
- Element ref (e.g., "e12")
- Element type and attributes
- Visible text

Example:
  e12: <input type="text" name="username" placeholder="아이디">
  e18: <input type="password" name="password">
  e24: <button type="submit">로그인</button>

**FINDING LOGIN ELEMENTS:**

1. Username field - Look for:
   - type="text" or type="email"
   - name/id containing: user, id, login, email, j_username, member, admin
   - Korean patterns: 아이디, 사용자, ID 입력
   - placeholder with login-related text
   - Usually appears before the password field

2. Password field - Look for:
   - type="password" (most reliable indicator)
   - name/id containing: pass, pw, pwd, j_password, secret
   - Korean patterns: 비밀번호, 패스워드

3. Submit button - Look for:
   - type="submit" or role="button"
   - text: 로그인, Login, 확인, Sign in, 접속, Submit, Enter
   - Usually appears after the password field

**CONTEXT TIPS:**
- Prefer fields inside <form> tags
- Ignore hidden inputs (type="hidden")
- Ignore CAPTCHA-related inputs
- The submit button is usually the last element in the form

Return ONLY valid JSON with refs from the snapshot (no markdown, no explanation):
{
  "usernameRef": "e12",
  "passwordRef": "e18",
  "submitRef": "e24"
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
