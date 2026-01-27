// src/agents/login-graph/nodes/click-login.ts
import type { LoginGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

export async function clickLogin(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient } = ctx;
  const { formElements } = state;

  if (!formElements.submitRef) {
    console.log('  [clickLogin] No submit button ref found');
    return {
      errorMessage: 'Submit button not found',
      status: 'FORM_NOT_FOUND',
    };
  }

  console.log(`  [clickLogin] Clicking login button: ${formElements.submitRef}`);

  try {
    // Click the submit button
    await mcpClient.callTool({
      name: 'browser_click',
      arguments: { ref: formElements.submitRef },
    });

    // Wait for page response
    console.log('  [clickLogin] Waiting for page response...');
    await mcpClient.callTool({
      name: 'browser_wait_for',
      arguments: { time: 3000 },
    });

    // Capture network requests
    console.log('  [clickLogin] Capturing network requests...');
    const networkResult = await mcpClient.callTool({
      name: 'browser_network_requests',
      arguments: { includeStatic: false },
    });
    const networkText = extractTextFromMcpResult(networkResult);

    // Parse network requests (simple extraction)
    let networkRequests: any[] = [];
    try {
      // Try to extract JSON from network result
      const jsonMatch = networkText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        networkRequests = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Keep raw text as fallback
      networkRequests = [{ raw: networkText }];
    }

    // Get current URL
    const snapshotResult = await mcpClient.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const snapshotText = extractTextFromMcpResult(snapshotResult);
    const urlMatch = snapshotText.match(/Page URL: ([^\n]+)/);
    const currentUrl = urlMatch ? urlMatch[1].trim() : state.currentUrl;

    console.log(`  [clickLogin] Login clicked, current URL: ${currentUrl}`);

    return {
      loginClicked: true,
      networkRequests,
      currentUrl,
    };
  } catch (e) {
    console.log(`  [clickLogin] Error: ${(e as Error).message}`);
    return {
      errorMessage: `Click login failed: ${(e as Error).message}`,
      status: 'UNKNOWN_ERROR',
    };
  }
}
