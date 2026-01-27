// src/agents/login-graph/nodes/fill-credentials.ts
import type { LoginGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

async function secureFill(
  field: 'username' | 'password',
  elementRef: string
): Promise<{ success: boolean; error?: string }> {
  const ctx = getNodeContext();
  const { mcpClient, credentialManager, systemCode } = ctx;

  const value = credentialManager.getField(systemCode, field);
  if (!value) {
    return { success: false, error: `No credential found for ${field}` };
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`      [secureFill] ${field}=${elementRef}, attempt=${attempt}`);

      // Dismiss any existing dialog first
      try {
        await mcpClient.callTool({
          name: 'browser_handle_dialog',
          arguments: { accept: true },
        });
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch {
        // No dialog
      }

      // Click to focus
      await mcpClient.callTool({
        name: 'browser_click',
        arguments: { ref: elementRef },
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Type the value
      const result = await mcpClient.callTool({
        name: 'browser_type',
        arguments: { ref: elementRef, text: value, submit: false },
      });

      const text = extractTextFromMcpResult(result);

      // Check for modal/dialog error - retry after dismissing
      if (text.includes('modal state') || text.includes('dialog')) {
        console.log(`      [secureFill] Modal detected, retrying...`);
        try {
          await mcpClient.callTool({
            name: 'browser_handle_dialog',
            arguments: { accept: true },
          });
        } catch { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }

      if (text.toLowerCase().includes('error')) {
        console.log(`      [secureFill] Error: ${text.slice(0, 100)}`);
        if (attempt === maxRetries) {
          return { success: false, error: text };
        }
        continue;
      }

      console.log(`      [secureFill] ${field} filled successfully`);
      return { success: true };
    } catch (e) {
      console.log(`      [secureFill] Exception: ${(e as Error).message}`);
      if (attempt === maxRetries) {
        return { success: false, error: (e as Error).message };
      }
    }
  }

  return { success: false, error: `Failed after ${maxRetries} attempts` };
}

export async function fillCredentials(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const { formElements } = state;

  if (!formElements.usernameRef) {
    console.log('  [fillCredentials] No username ref found');
    return {
      errorMessage: 'Username field not found',
      status: 'FORM_NOT_FOUND',
    };
  }

  console.log('  [fillCredentials] Starting credential fill...');

  // Fill username first (IMPORTANT: order matters)
  const usernameResult = await secureFill('username', formElements.usernameRef);
  if (!usernameResult.success) {
    return {
      errorMessage: `Failed to fill username: ${usernameResult.error}`,
      status: 'UNKNOWN_ERROR',
    };
  }

  // Fill password
  if (formElements.passwordRef) {
    const passwordResult = await secureFill('password', formElements.passwordRef);
    if (!passwordResult.success) {
      return {
        errorMessage: `Failed to fill password: ${passwordResult.error}`,
        status: 'UNKNOWN_ERROR',
      };
    }
  }

  console.log('  [fillCredentials] Credentials filled successfully');

  return {
    credentialsFilled: true,
  };
}
