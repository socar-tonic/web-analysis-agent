// src/agents/search-graph/nodes/execute-search.ts
import type { SearchGraphStateType } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult, extractLast4Digits, NETWORK_INTERCEPTOR_JS } from '../utils.js';

/**
 * executeSearch node - Execute DOM-based vehicle search.
 *
 * This is a simple function (NOT createAgent) that:
 * 1. Inputs vehicle number into search field using one of:
 *    - browser_type if searchInputRef is available
 *    - browser_evaluate to set value if searchInputSelector is available
 *    - keypad input (clicking digit buttons) if neither is available
 * 2. Clicks search button using one of:
 *    - browser_click if searchButtonRef is available
 *    - browser_evaluate if searchButtonSelector is available
 *    - Common button text search (조회, 검색, Search)
 * 3. Waits for results (1.5s)
 * 4. Returns FORM_CHANGED if spec_fallback source and search fails
 *
 * After this node, captureResults analyzes the search outcome.
 */
export async function executeSearch(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, carNum } = ctx;
  const { formElements, analysisSource } = state;

  console.log('  [executeSearch] Executing DOM-based search...');
  console.log(`    - carNum: ${carNum}`);
  console.log(`    - inputRef: ${formElements.searchInputRef}`);
  console.log(`    - inputSelector: ${formElements.searchInputSelector}`);
  console.log(`    - buttonRef: ${formElements.searchButtonRef}`);
  console.log(`    - buttonSelector: ${formElements.searchButtonSelector}`);

  try {
    // Step 1: Input vehicle number into search field
    const inputResult = await inputVehicleNumber(
      mcpClient,
      carNum,
      formElements.searchInputRef,
      formElements.searchInputSelector
    );

    if (!inputResult.success) {
      console.log(`  [executeSearch] Input failed: ${inputResult.error}`);
      return handleSearchError(inputResult.error!, analysisSource);
    }

    console.log('  [executeSearch] Input complete, installing network interceptor...');

    // Step 2: Install network interceptor BEFORE clicking search button
    // This captures all XHR/fetch requests triggered by the search action
    try {
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: NETWORK_INTERCEPTOR_JS },
      });
      console.log('  [executeSearch] Network interceptor installed');
    } catch (e) {
      console.log(`  [executeSearch] Failed to install network interceptor: ${(e as Error).message}`);
      // Continue anyway - network capture is optional
    }

    console.log('  [executeSearch] Clicking search button...');

    // Step 3: Click search button
    const clickResult = await clickSearchButton(
      mcpClient,
      formElements.searchButtonRef,
      formElements.searchButtonSelector
    );

    if (!clickResult.success) {
      console.log(`  [executeSearch] Click failed: ${clickResult.error}`);
      return handleSearchError(clickResult.error!, analysisSource);
    }

    // Step 4: Wait for results to load (and network requests to complete)
    console.log('  [executeSearch] Waiting for results and network requests...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('  [executeSearch] Search executed successfully');
    return {};
  } catch (e) {
    const error = e as Error;
    console.log(`  [executeSearch] Error: ${error.message}`);
    return handleSearchError(error.message, analysisSource);
  }
}

/**
 * Handle search error - returns FORM_CHANGED if using spec_fallback,
 * otherwise returns UNKNOWN_ERROR.
 */
function handleSearchError(
  errorMessage: string,
  analysisSource: SearchGraphStateType['analysisSource']
): Partial<SearchGraphStateType> {
  // If we're using spec_fallback and it fails, the UI has changed
  if (analysisSource === 'spec_fallback') {
    return {
      status: 'FORM_CHANGED',
      errorMessage: `기존 spec으로 검색 실패 - UI 변경됨: ${errorMessage}`,
    };
  }

  return {
    status: 'UNKNOWN_ERROR',
    errorMessage,
  };
}

/**
 * Input vehicle number using available method.
 * Priority: ref > selector > keypad
 */
async function inputVehicleNumber(
  mcpClient: any,
  carNum: string,
  inputRef: string | null,
  inputSelector: string | null
): Promise<{ success: boolean; error?: string }> {
  // Method 1: Use browser_type with element ref
  if (inputRef) {
    try {
      console.log(`    [inputVehicleNumber] Using browser_type with ref=${inputRef}`);
      const result = await mcpClient.callTool({
        name: 'browser_type',
        arguments: { ref: inputRef, text: carNum, submit: false },
      });

      const text = extractTextFromMcpResult(result);
      if (text.toLowerCase().includes('error')) {
        return { success: false, error: `browser_type error: ${text}` };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: `browser_type failed: ${(e as Error).message}` };
    }
  }

  // Method 2: Use browser_evaluate with selector
  if (inputSelector) {
    try {
      console.log(`    [inputVehicleNumber] Using browser_evaluate with selector=${inputSelector}`);

      // Escape special characters in selector and value for JavaScript
      const escapedSelector = inputSelector.replace(/'/g, "\\'");
      const escapedValue = carNum.replace(/'/g, "\\'");

      const code = `(() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) return 'Element not found: ${escapedSelector}';

        // Clear existing value first
        el.value = '';

        // Set new value
        el.value = '${escapedValue}';

        // Dispatch events to trigger React/Vue/Angular bindings
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return 'OK';
      })()`;

      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });

      const text = extractTextFromMcpResult(result);
      if (text !== 'OK' && !text.includes('OK')) {
        return { success: false, error: text || 'Unknown evaluate error' };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: `browser_evaluate failed: ${(e as Error).message}` };
    }
  }

  // Method 3: Keypad input - click digit buttons
  console.log('    [inputVehicleNumber] Using keypad input (no ref or selector available)');

  const digits = extractLast4Digits(carNum);
  console.log(`    [inputVehicleNumber] Clicking digits: ${digits}`);

  for (const digit of digits) {
    try {
      const code = `(() => {
        // Look for clickable elements containing just this digit
        const candidates = document.querySelectorAll('button, a, td, span, div, input[type="button"]');
        for (const el of candidates) {
          const text = (el.textContent || el.value || '').trim();
          // Match exact digit or digit with possible surrounding whitespace
          if (text === '${digit}' || text.match(/^\\s*${digit}\\s*$/)) {
            el.click();
            return 'clicked ${digit}';
          }
        }
        return 'digit ${digit} not found';
      })()`;

      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });

      const text = extractTextFromMcpResult(result);
      if (text.includes('not found')) {
        return { success: false, error: `Keypad digit '${digit}' not found on page` };
      }

      // Small delay between keypad presses
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
      return { success: false, error: `Keypad input failed at digit '${digit}': ${(e as Error).message}` };
    }
  }

  return { success: true };
}

/**
 * Click search button using available method.
 * Priority: ref > selector > common text search
 */
async function clickSearchButton(
  mcpClient: any,
  buttonRef: string | null,
  buttonSelector: string | null
): Promise<{ success: boolean; error?: string }> {
  // Method 1: Use browser_click with element ref
  if (buttonRef) {
    try {
      console.log(`    [clickSearchButton] Using browser_click with ref=${buttonRef}`);
      await mcpClient.callTool({
        name: 'browser_click',
        arguments: { ref: buttonRef },
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: `browser_click failed: ${(e as Error).message}` };
    }
  }

  // Method 2: Use browser_evaluate with selector
  if (buttonSelector) {
    try {
      console.log(`    [clickSearchButton] Using browser_evaluate with selector=${buttonSelector}`);

      const escapedSelector = buttonSelector.replace(/'/g, "\\'");

      const code = `(() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) return 'Button not found: ${escapedSelector}';
        el.click();
        return 'OK';
      })()`;

      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });

      const text = extractTextFromMcpResult(result);
      if (text !== 'OK' && !text.includes('OK')) {
        return { success: false, error: text || 'Unknown click error' };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: `browser_evaluate click failed: ${(e as Error).message}` };
    }
  }

  // Method 3: Search by common button text
  console.log('    [clickSearchButton] Searching for common button text (조회, 검색, Search, 찾기)');

  const code = `(() => {
    const searchTexts = ['조회', '검색', 'Search', '찾기', 'search', 'SEARCH', '확인', 'OK'];
    const candidates = document.querySelectorAll('button, a, input[type="submit"], input[type="button"]');

    for (const el of candidates) {
      const text = (el.textContent || el.value || '').trim();
      for (const searchText of searchTexts) {
        if (text === searchText || text.includes(searchText)) {
          el.click();
          return 'clicked: ' + text;
        }
      }
    }

    return 'Search button not found';
  })()`;

  try {
    const result = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: code },
    });

    const text = extractTextFromMcpResult(result);
    if (text.includes('not found')) {
      return { success: false, error: 'Search button not found (tried common texts: 조회, 검색, Search, 찾기)' };
    }

    console.log(`    [clickSearchButton] ${text}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: `Button text search failed: ${(e as Error).message}` };
  }
}
