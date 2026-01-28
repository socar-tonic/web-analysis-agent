// src/agents/search-graph/nodes/spec-fallback.ts
import type { SearchGraphStateType } from '../state.js';

/**
 * specFallback node - Last resort fallback using existing spec.
 *
 * This is a simple function (not createAgent) that uses the existing spec
 * to determine the search method when all other analysis methods have failed.
 *
 * Logic:
 * 1. If no spec exists: return FORM_CHANGED error
 * 2. If spec.searchType === 'api' && spec.api: use API method
 * 3. If spec.searchType === 'dom' && spec.form: use DOM method with selectors from spec
 * 4. If spec exists but no valid method: return FORM_CHANGED error
 */
export async function specFallback(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const spec = state.spec;

  // No spec available - cannot proceed
  if (!spec) {
    console.log('  [specFallback] No existing spec available');
    return {
      status: 'FORM_CHANGED',
      errorMessage: '검색 방법을 찾을 수 없고, 기존 spec도 없음',
    };
  }

  console.log(`  [specFallback] Using existing spec: searchType=${spec.searchType}`);

  // API-based search
  if (spec.searchType === 'api' && spec.api) {
    console.log(`  [specFallback] Using API method: ${spec.api.method} ${spec.api.endpoint}`);
    return {
      searchMethod: 'api',
      analysisSource: 'spec_fallback',
    };
  }

  // DOM-based search
  if (spec.searchType === 'dom' && spec.form) {
    console.log(`  [specFallback] Using DOM method: input=${spec.form.searchInputSelector}, button=${spec.form.searchButtonSelector}`);
    return {
      searchMethod: 'dom',
      analysisSource: 'spec_fallback',
      formElements: {
        searchInputRef: null,
        searchInputSelector: spec.form.searchInputSelector,
        searchButtonRef: null,
        searchButtonSelector: spec.form.searchButtonSelector,
      },
    };
  }

  // Spec exists but doesn't have valid search method configuration
  console.log('  [specFallback] Spec exists but no valid search method configuration');
  return {
    status: 'FORM_CHANGED',
    errorMessage: '기존 spec의 검색 방법이 유효하지 않음',
  };
}
