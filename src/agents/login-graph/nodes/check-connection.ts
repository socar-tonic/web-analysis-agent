// src/agents/login-graph/nodes/check-connection.ts
import type { LoginGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { classifyConnectionError, classifyConnectionErrorFromText, extractTextFromMcpResult } from '../utils.js';

export async function checkConnection(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient } = ctx;

  console.log(`  [checkConnection] Navigating to ${state.url}`);

  try {
    const result = await mcpClient.callTool({
      name: 'browser_navigate',
      arguments: { url: state.url },
    });

    const text = extractTextFromMcpResult(result);

    // Check for navigation errors in the response
    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('failed')) {
      const errorInfo = classifyConnectionErrorFromText(text);
      if (errorInfo.isConnectionError) {
        console.log(`  [checkConnection] Connection error: ${errorInfo.errorType}`);
        return {
          status: 'CONNECTION_ERROR',
          confidence: errorInfo.confidence,
          errorMessage: errorInfo.summary,
          currentUrl: state.url,
        };
      }
    }

    // Extract current URL from response
    const urlMatch = text.match(/Page URL: ([^\n]+)/);
    const currentUrl = urlMatch ? urlMatch[1].trim() : state.url;

    // Dismiss any initial dialogs
    try {
      await mcpClient.callTool({
        name: 'browser_handle_dialog',
        arguments: { accept: true },
      });
      console.log('  [checkConnection] Dismissed initial dialog');
    } catch {
      // No dialog to dismiss
    }

    console.log(`  [checkConnection] Navigation successful, URL: ${currentUrl}`);

    return {
      currentUrl,
      status: 'pending',
    };
  } catch (error) {
    const errorInfo = classifyConnectionError(error as Error);
    console.log(`  [checkConnection] Exception: ${errorInfo.errorType}`);

    return {
      status: 'CONNECTION_ERROR',
      confidence: errorInfo.confidence,
      errorMessage: errorInfo.summary,
      currentUrl: state.url,
    };
  }
}
