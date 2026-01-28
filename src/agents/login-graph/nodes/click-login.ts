// src/agents/login-graph/nodes/click-login.ts
import type { LoginGraphStateType, CapturedNetworkRequest } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

/**
 * Parse Playwright MCP browser_network_requests text output
 * Format: "[METHOD] URL => [STATUS]" per line
 */
function parseNetworkRequestsText(text: string): CapturedNetworkRequest[] {
  const requests: CapturedNetworkRequest[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    // Match pattern: [GET] https://example.com/path => [200]
    const match = line.match(/^\[([A-Z]+)\]\s+(.+?)\s+=>\s+\[(\d+)\]/);
    if (match) {
      requests.push({
        method: match[1],
        url: match[2],
        responseStatus: parseInt(match[3], 10),
        timestamp: Date.now(),
      });
    }
  }

  return requests;
}

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
      arguments: {},
    });
    const networkText = extractTextFromMcpResult(networkResult);

    // Parse network requests from MCP text format (basic info)
    const basicRequests = parseNetworkRequestsText(networkText);
    console.log(`  [clickLogin] MCP captured ${basicRequests.length} network requests`);

    // Also get detailed requests from JS interceptor (includes request/response bodies)
    console.log('  [clickLogin] Reading captured API requests with bodies...');
    let capturedNetworkRequests: CapturedNetworkRequest[] = [];
    try {
      const jsResult = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: '() => JSON.stringify(window.__capturedApiRequests || [])' },
      });
      const jsText = extractTextFromMcpResult(jsResult);

      // Find JSON array in the result - handle escaped strings
      let jsonStr = jsText;
      // If wrapped in quotes (escaped JSON string), try to extract
      const quotedMatch = jsText.match(/"(\[.*\])"/s);
      if (quotedMatch) {
        jsonStr = quotedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else {
        const arrayMatch = jsText.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }
      }

      const detailedRequests = JSON.parse(jsonStr);
      capturedNetworkRequests = detailedRequests.map((req: any) => ({
        url: req.url || '',
        method: req.method || 'GET',
        requestBody: req.requestBody || undefined,
        responseStatus: req.responseStatus || 0,
        responseBody: req.responseBody || undefined,
        timestamp: req.timestamp || Date.now(),
      }));
      console.log(`  [clickLogin] JS interceptor captured ${capturedNetworkRequests.length} requests with bodies`);
    } catch (e) {
      console.log(`  [clickLogin] JS interceptor read failed: ${(e as Error).message}`);
      // Fallback to basic requests
      capturedNetworkRequests = basicRequests;
    }

    // Log captured requests with body info
    if (capturedNetworkRequests.length > 0) {
      capturedNetworkRequests.forEach((req, i) => {
        const hasBody = req.requestBody ? ' [has requestBody]' : '';
        const hasResponse = req.responseBody ? ' [has responseBody]' : '';
        console.log(`    [${i}] ${req.method} ${req.url} -> ${req.responseStatus}${hasBody}${hasResponse}`);
      });
    }

    const networkRequests = capturedNetworkRequests;

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
      capturedNetworkRequests,
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
