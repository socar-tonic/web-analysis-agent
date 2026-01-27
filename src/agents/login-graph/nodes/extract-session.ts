// src/agents/login-graph/nodes/extract-session.ts
import type { LoginGraphStateType, SessionInfo } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

export async function extractSession(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient } = ctx;

  console.log('  [extractSession] Extracting session info...');

  const session: SessionInfo = {};

  try {
    // Extract cookies
    const cookieResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: 'document.cookie' },
    });
    let cookieText = extractTextFromMcpResult(cookieResult);
    // Clean up MCP response format (remove "### Result" prefix and quotes)
    const cookieMatch = cookieText.match(/"([^"]*)"/);
    if (cookieMatch) {
      cookieText = cookieMatch[1];
    }
    if (cookieText && cookieText !== '' && cookieText !== '""') {
      session.cookies = cookieText.split(';').map(c => c.trim()).filter(Boolean);
    }

    // Extract localStorage
    const localStorageResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: 'JSON.stringify(localStorage)' },
    });
    const localStorageText = extractTextFromMcpResult(localStorageResult);
    try {
      const parsed = JSON.parse(localStorageText.replace(/^"|"$/g, ''));
      if (Object.keys(parsed).length > 0) {
        session.localStorage = parsed;
      }
    } catch { /* ignore */ }

    // Extract sessionStorage
    const sessionStorageResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: 'JSON.stringify(sessionStorage)' },
    });
    const sessionStorageText = extractTextFromMcpResult(sessionStorageResult);
    try {
      const parsed = JSON.parse(sessionStorageText.replace(/^"|"$/g, ''));
      if (Object.keys(parsed).length > 0) {
        session.sessionStorage = parsed;
      }
    } catch { /* ignore */ }

    // Determine session type
    if (session.localStorage?.access_token || session.localStorage?.token) {
      session.type = 'jwt';
      session.accessToken = session.localStorage.access_token || session.localStorage.token;
    } else if (session.sessionStorage?.access_token || session.sessionStorage?.token) {
      session.type = 'jwt';
      session.accessToken = session.sessionStorage.access_token || session.sessionStorage.token;
    } else if (session.cookies?.some(c => c.includes('session') || c.includes('token'))) {
      session.type = 'cookie';
    } else if (session.cookies?.length || session.localStorage || session.sessionStorage) {
      session.type = 'mixed';
    }

    console.log(`  [extractSession] Session type: ${session.type || 'unknown'}`);
    console.log(`  [extractSession] Cookies: ${session.cookies?.length || 0}`);
    console.log(`  [extractSession] localStorage keys: ${Object.keys(session.localStorage || {}).length}`);
    console.log(`  [extractSession] sessionStorage keys: ${Object.keys(session.sessionStorage || {}).length}`);

    return {
      session: Object.keys(session).length > 0 ? session : null,
    };
  } catch (e) {
    console.log(`  [extractSession] Error: ${(e as Error).message}`);
    return {
      session: null,
    };
  }
}
