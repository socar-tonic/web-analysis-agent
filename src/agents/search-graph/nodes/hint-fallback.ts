// src/agents/search-graph/nodes/hint-fallback.ts
import type { SearchGraphStateType } from '../state.js';

/**
 * hintFallback node - Uses search hints from spec to create formElements.
 *
 * This is a simple function (not createAgent) that checks if the spec
 * has search hints and uses them to create form elements for DOM-based search.
 *
 * Hint fields checked:
 * - inputSelector: CSS selector for the search input
 * - inputMethod: 'text' | 'keypad' - how to input the vehicle number
 * - searchButtonText: Text of the search button to find
 */
export async function hintFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  // Access hints from spec - hints may come from LoginSpec structure
  // Type assertion needed since SearchSpec doesn't officially have hints
  const spec = state.spec as any;
  const hints = spec?.hints?.search;

  if (!hints) {
    console.log('  [hintFallback] No search hints in spec');
    return { searchMethod: 'unknown' };
  }

  console.log(`  [hintFallback] Using hints: inputMethod=${hints.inputMethod}`);

  // Check if we have usable hints (inputSelector, inputMethod, or searchButtonText)
  if (hints.inputSelector || hints.inputMethod) {
    return {
      searchMethod: 'dom',
      analysisSource: 'hint',
      formElements: {
        searchInputRef: null,
        searchInputSelector: hints.inputSelector || null,
        searchButtonRef: null,
        searchButtonSelector: hints.searchButtonText
          ? `button:contains("${hints.searchButtonText}")`
          : null,
      },
    };
  }

  return { searchMethod: 'unknown' };
}
