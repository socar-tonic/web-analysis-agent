// src/agents/login-graph/nodes/screenshot-fallback.ts
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { writeFileSync } from 'fs';
import type { LoginGraphStateType, FormElements } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

const SCREENSHOT_ANALYZE_PROMPT = `Analyze this login page screenshot and the DOM snapshot to find login form elements.

**YOUR TASK:**
1. Look at the screenshot to visually identify the login form
2. Match what you see to element refs in the DOM snapshot
3. Return the refs for username, password, and submit button

**SNAPSHOT FORMAT:**
The DOM snapshot shows elements with refs like "e12", "e18". Example:
  e12: <input type="text" name="username" placeholder="아이디">
  e18: <input type="password" name="password">
  e24: <button type="submit">로그인</button>

**FINDING LOGIN ELEMENTS:**

1. Username field - In screenshot, look for:
   - Text input labeled "아이디", "ID", "사용자", "Username", "Email"
   - Usually the first input field in the form

2. Password field - In screenshot, look for:
   - Input showing dots/asterisks (password mask)
   - Labeled "비밀번호", "Password", "PW"
   - Usually below the username field

3. Submit button - In screenshot, look for:
   - Button labeled "로그인", "Login", "확인", "Sign in", "접속"
   - Usually at the bottom of the form

**CONTEXT TIPS:**
- Match visual elements to refs in the DOM snapshot
- Ignore CAPTCHA fields or "Remember me" checkboxes
- The submit button is usually the most prominent button in the form

Return ONLY valid JSON with refs AND element attributes from the snapshot (no markdown, no explanation):
{
  "usernameRef": "e12",
  "usernameSelector": "input[name='username']",
  "passwordRef": "e18",
  "passwordSelector": "input[name='password']",
  "submitRef": "e24",
  "submitSelector": "button[type='submit']"
}

For selectors, use the most specific attribute you can find:
- Prefer name attribute: input[name='j_username']
- Or id attribute: input#userId
- Or type+placeholder: input[type='text'][placeholder='아이디']

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
      usernameRef: null, usernameSelector: null,
      passwordRef: null, passwordSelector: null,
      submitRef: null, submitSelector: null,
    };

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        formElements = {
          usernameRef: parsed.usernameRef || null,
          usernameSelector: parsed.usernameSelector || null,
          passwordRef: parsed.passwordRef || null,
          passwordSelector: parsed.passwordSelector || null,
          submitRef: parsed.submitRef || null,
          submitSelector: parsed.submitSelector || null,
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
