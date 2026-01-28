// src/agents/search-graph/nodes/compare-spec.ts
import type { SearchGraphStateType, SpecChanges } from '../state.js';

/**
 * compareSpec node - Compares captured data with existing spec to detect changes.
 *
 * This is a simple function (NOT createAgent) because it only performs
 * deterministic comparisons without needing LLM reasoning.
 *
 * For DOM-based search: compares captured selectors with spec.form selectors
 * For API-based search: compares captured requests with spec.api endpoint/method
 *
 * Sets readyForDiscount = true if status === 'SUCCESS' and no breaking changes detected.
 */
export async function compareSpec(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const existingSpec = state.spec;

  console.log('  [compareSpec] Comparing captured data with existing spec...');

  // If no existing spec, nothing to compare
  if (!existingSpec) {
    console.log('  [compareSpec] No existing spec to compare');
    return {
      specChanges: {
        hasChanges: false,
        changeType: null,
        changes: [],
        codeWillBreak: false,
      },
      readyForDiscount: state.status === 'SUCCESS',
    };
  }

  const changes: string[] = [];
  let changeType: 'dom' | 'api' | 'both' | null = null;

  // DOM-based comparison
  if (existingSpec.searchType === 'dom') {
    // Compare DOM selectors if form spec exists
    if (existingSpec.form) {
      const captured = state.formElements;
      let domChangesDetected = false;

      // Compare search input selector
      if (
        captured.searchInputSelector &&
        captured.searchInputSelector !== existingSpec.form.searchInputSelector
      ) {
        changes.push(
          `검색 입력 셀렉터 변경: ${existingSpec.form.searchInputSelector} -> ${captured.searchInputSelector}`
        );
        domChangesDetected = true;
      }

      // Compare search button selector
      if (
        captured.searchButtonSelector &&
        captured.searchButtonSelector !== existingSpec.form.searchButtonSelector
      ) {
        changes.push(
          `검색 버튼 셀렉터 변경: ${existingSpec.form.searchButtonSelector} -> ${captured.searchButtonSelector}`
        );
        domChangesDetected = true;
      }

      if (domChangesDetected) {
        changeType = 'dom';
      }
    }

    // DOM 검색도 백그라운드에서 API를 호출할 수 있음 - spec.api가 있으면 비교
    if (existingSpec.api && state.capturedRequests.length > 0) {
      console.log(`  [compareSpec] DOM search captured ${state.capturedRequests.length} network requests, comparing with spec.api...`);

      const specEndpoint = existingSpec.api.endpoint.split('?')[0];
      const specMethod = existingSpec.api.method.toUpperCase();

      // 캡처된 요청 중 검색 관련 API 찾기
      const searchApiPatterns = ['search', 'vehicle', 'car', 'parking', 'query', 'inquiry', '조회'];
      const capturedApiCalls = state.capturedRequests.filter((r) =>
        searchApiPatterns.some((pattern) =>
          r.url.toLowerCase().includes(pattern)
        )
      );

      console.log(`  [compareSpec] Found ${capturedApiCalls.length} search-related API calls`);

      for (const call of capturedApiCalls) {
        const capturedEndpoint = call.url.split('?')[0];
        const capturedMethod = (call.method || 'GET').toUpperCase();

        console.log(`    - Captured: ${capturedMethod} ${capturedEndpoint}`);
        console.log(`    - Spec:     ${specMethod} ${specEndpoint}`);

        // Compare endpoint
        if (capturedEndpoint !== specEndpoint) {
          changes.push(
            `API 엔드포인트 변경: ${existingSpec.api.endpoint} -> ${call.url}`
          );
          changeType = changeType === 'dom' ? 'both' : 'api';
        }

        // Compare HTTP method
        if (capturedMethod !== specMethod) {
          changes.push(
            `API 메서드 변경: ${existingSpec.api.method} -> ${call.method}`
          );
          changeType = changeType === 'dom' ? 'both' : 'api';
        }
      }

      // 검색 관련 API가 캡처되지 않았는데 spec에 api가 있으면 경고
      if (capturedApiCalls.length === 0) {
        console.log(`  [compareSpec] Warning: spec.api exists but no search API calls were captured`);
      }
    }
  }

  // API-based comparison
  if (existingSpec.searchType === 'api' && existingSpec.api) {
    let apiChangesDetected = false;

    // Filter captured requests for search-related API calls
    const searchApiPatterns = ['search', 'vehicle', 'car', 'parking', 'query'];
    const capturedApiCalls = state.capturedRequests.filter((r) =>
      searchApiPatterns.some(
        (pattern) =>
          r.url.toLowerCase().includes(pattern) ||
          r.responseBody?.toString().toLowerCase().includes(pattern)
      )
    );

    for (const call of capturedApiCalls) {
      // Normalize URLs for comparison (remove query params for endpoint comparison)
      const capturedEndpoint = call.url.split('?')[0];
      const specEndpoint = existingSpec.api.endpoint.split('?')[0];

      // Compare endpoint
      if (capturedEndpoint !== specEndpoint) {
        changes.push(
          `API 엔드포인트 변경: ${existingSpec.api.endpoint} -> ${call.url}`
        );
        apiChangesDetected = true;
      }

      // Compare HTTP method
      if (call.method.toUpperCase() !== existingSpec.api.method.toUpperCase()) {
        changes.push(
          `API 메서드 변경: ${existingSpec.api.method} -> ${call.method}`
        );
        apiChangesDetected = true;
      }
    }

    if (apiChangesDetected) {
      changeType = changeType === 'dom' ? 'both' : 'api';
    }
  }

  // Hybrid comparison (both DOM and API)
  if (existingSpec.searchType === 'hybrid') {
    // For hybrid, we check both DOM and API if available
    if (existingSpec.form && state.formElements) {
      const captured = state.formElements;

      if (
        captured.searchInputSelector &&
        captured.searchInputSelector !== existingSpec.form.searchInputSelector
      ) {
        changes.push(
          `검색 입력 셀렉터 변경: ${existingSpec.form.searchInputSelector} -> ${captured.searchInputSelector}`
        );
        changeType = 'dom';
      }

      if (
        captured.searchButtonSelector &&
        captured.searchButtonSelector !== existingSpec.form.searchButtonSelector
      ) {
        changes.push(
          `검색 버튼 셀렉터 변경: ${existingSpec.form.searchButtonSelector} -> ${captured.searchButtonSelector}`
        );
        changeType = changeType ? 'both' : 'dom';
      }
    }

    if (existingSpec.api && state.capturedRequests.length > 0) {
      const searchApiPatterns = ['search', 'vehicle', 'car', 'parking', 'query'];
      const capturedApiCalls = state.capturedRequests.filter((r) =>
        searchApiPatterns.some((pattern) =>
          r.url.toLowerCase().includes(pattern)
        )
      );

      for (const call of capturedApiCalls) {
        const capturedEndpoint = call.url.split('?')[0];
        const specEndpoint = existingSpec.api.endpoint.split('?')[0];

        if (capturedEndpoint !== specEndpoint) {
          changes.push(
            `API 엔드포인트 변경: ${existingSpec.api.endpoint} -> ${call.url}`
          );
          changeType = changeType === 'dom' ? 'both' : 'api';
        }

        if (call.method.toUpperCase() !== existingSpec.api.method.toUpperCase()) {
          changes.push(
            `API 메서드 변경: ${existingSpec.api.method} -> ${call.method}`
          );
          changeType = changeType === 'dom' ? 'both' : 'api';
        }
      }
    }
  }

  const hasChanges = changes.length > 0;
  const specChanges: SpecChanges = {
    hasChanges,
    changeType,
    changes,
    // Code will break if there are any selector or endpoint changes
    codeWillBreak: hasChanges,
  };

  if (hasChanges) {
    console.log(`  [compareSpec] Changes detected (${changes.length}):`);
    for (const change of changes) {
      console.log(`    - ${change}`);
    }
  } else {
    console.log('  [compareSpec] No changes detected');
  }

  // Ready for discount only if search succeeded AND no breaking changes
  const readyForDiscount = state.status === 'SUCCESS' && !hasChanges;

  if (readyForDiscount) {
    console.log('  [compareSpec] Ready for DiscountGraph handoff');
  }

  return { specChanges, readyForDiscount };
}
