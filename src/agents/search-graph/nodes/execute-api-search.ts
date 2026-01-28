// src/agents/search-graph/nodes/execute-api-search.ts
import type { SearchGraphStateType, CapturedNetworkRequest } from '../state.js';
import { getNodeContext } from '../index.js';
import {
  extractTextFromMcpResult,
  NETWORK_INTERCEPTOR_JS,
  GET_CAPTURED_REQUESTS_JS,
} from '../utils.js';

/**
 * executeApiSearch node - Execute API-based vehicle search.
 *
 * This is a simple function (NOT createAgent) that:
 * 1. Installs network interceptor to capture actual API calls
 * 2. Triggers search via DOM (click button or submit form)
 * 3. Captures actual network requests made by the site
 * 4. Also calls spec's API endpoint directly as fallback
 * 5. Compares captured requests with spec for change detection
 * 6. Returns SUCCESS/NOT_FOUND based on response, API_CHANGED if mismatch
 *
 * IMPORTANT: API search always ends the graph - cannot navigate to next screen
 * because API calls don't change the browser DOM state.
 */
export async function executeApiSearch(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const spec = state.spec;

  // Validate API spec exists
  if (!spec?.api) {
    console.log('  [executeApiSearch] No API spec found');
    return {
      status: 'API_CHANGED',
      errorMessage: 'API spec not found',
    };
  }

  const { endpoint, method, requestFields } = spec.api;
  console.log(`  [executeApiSearch] Spec API: ${method} ${endpoint}`);

  try {
    // Step 1: Install network interceptor to capture actual API calls
    console.log('  [executeApiSearch] Installing network interceptor...');
    await ctx.mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: NETWORK_INTERCEPTOR_JS },
    });

    // Step 2: Try to trigger search via DOM if form elements available
    let domTriggered = false;
    const { formElements, carNum } = { formElements: state.formElements, carNum: ctx.carNum };

    if (formElements.searchInputSelector || formElements.searchInputRef) {
      console.log('  [executeApiSearch] Triggering search via DOM...');
      domTriggered = await triggerSearchViaDOM(ctx.mcpClient, formElements, carNum);
    }

    // Wait for network requests to complete
    if (domTriggered) {
      console.log('  [executeApiSearch] Waiting for network requests...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Step 3: Get captured network requests
    const capturedResult = await ctx.mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: GET_CAPTURED_REQUESTS_JS },
    });
    const capturedText = extractTextFromMcpResult(capturedResult);
    let actualRequests: CapturedNetworkRequest[] = [];

    try {
      const parsed = JSON.parse(capturedText);
      actualRequests = (parsed || []).map((r: any) => ({
        url: r.url,
        method: r.method || 'GET',
        requestBody: r.body ? JSON.parse(r.body) : undefined,
        responseStatus: r.status || 0,
        responseBody: r.response ? JSON.parse(r.response) : undefined,
        timestamp: r.timestamp || Date.now(),
      }));
    } catch {
      console.log('  [executeApiSearch] Failed to parse captured requests');
    }

    // Filter for search-related API calls
    const searchPatterns = ['search', 'vehicle', 'car', 'parking', 'query', 'inquiry', '조회'];
    const searchRequests = actualRequests.filter(r =>
      searchPatterns.some(p => r.url.toLowerCase().includes(p))
    );

    console.log(`  [executeApiSearch] Captured ${actualRequests.length} requests, ${searchRequests.length} search-related`);

    // Step 4: Also call spec's API endpoint directly (for fallback and result retrieval)
    const directCallResult = await callSpecApiDirectly(ctx, spec, state.session);

    // Step 5: Build final captured requests list (include actual + direct call)
    const allCapturedRequests: CapturedNetworkRequest[] = [
      ...searchRequests,
      directCallResult.capturedRequest,
    ];

    // Step 6: Check if actual API URL differs from spec
    if (searchRequests.length > 0) {
      const actualUrl = searchRequests[0].url.split('?')[0];
      const specUrl = endpoint.split('?')[0];

      if (actualUrl !== specUrl) {
        console.log(`  [executeApiSearch] API URL mismatch detected!`);
        console.log(`    Spec: ${specUrl}`);
        console.log(`    Actual: ${actualUrl}`);

        // Return the actual captured request for spec comparison
        return {
          status: directCallResult.hasVehicle ? 'SUCCESS' : 'NOT_FOUND',
          confidence: 0.7, // Lower confidence due to URL mismatch
          vehicle: directCallResult.vehicleInfo,
          capturedRequests: allCapturedRequests,
          errorMessage: `API URL 불일치: spec=${specUrl}, actual=${actualUrl}`,
        };
      }
    }

    // Return direct call result with all captured requests
    if (directCallResult.error) {
      return {
        status: directCallResult.status,
        errorMessage: directCallResult.error,
        capturedRequests: allCapturedRequests,
      };
    }

    return {
      status: directCallResult.hasVehicle ? 'SUCCESS' : 'NOT_FOUND',
      confidence: directCallResult.hasVehicle ? 0.95 : 0.9,
      vehicle: directCallResult.vehicleInfo,
      capturedRequests: allCapturedRequests,
    };
  } catch (e) {
    const error = e as Error;
    console.log(`  [executeApiSearch] Error: ${error.message}`);
    return {
      status: 'API_CHANGED',
      errorMessage: `API 호출 중 오류: ${error.message}`,
    };
  }
}

/**
 * Trigger search via DOM by filling input and clicking button.
 */
async function triggerSearchViaDOM(
  mcpClient: any,
  formElements: SearchGraphStateType['formElements'],
  carNum: string
): Promise<boolean> {
  try {
    // Fill search input
    if (formElements.searchInputRef) {
      await mcpClient.callTool({
        name: 'browser_type',
        arguments: { ref: formElements.searchInputRef, text: carNum, submit: false },
      });
    } else if (formElements.searchInputSelector) {
      const escapedSelector = formElements.searchInputSelector.replace(/'/g, "\\'");
      const code = `(() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) return 'not found';
        el.value = '${carNum}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`;
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });
    }

    // Click search button
    if (formElements.searchButtonRef) {
      await mcpClient.callTool({
        name: 'browser_click',
        arguments: { ref: formElements.searchButtonRef },
      });
    } else if (formElements.searchButtonSelector) {
      const escapedSelector = formElements.searchButtonSelector.replace(/'/g, "\\'");
      const code = `(() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) return 'not found';
        el.click();
        return 'ok';
      })()`;
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: code },
      });
    }

    return true;
  } catch (e) {
    console.log(`  [triggerSearchViaDOM] Failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Call spec's API endpoint directly.
 */
async function callSpecApiDirectly(
  ctx: ReturnType<typeof getNodeContext>,
  spec: NonNullable<SearchGraphStateType['spec']>,
  session: SearchGraphStateType['session']
): Promise<{
  capturedRequest: CapturedNetworkRequest;
  hasVehicle: boolean;
  vehicleInfo: any;
  status: SearchGraphStateType['status'];
  error?: string;
}> {
  const { endpoint, method, requestFields } = spec.api!;

  // Build auth headers from session
  const authHeaders: Record<string, string> = {};
  if (session?.accessToken) {
    authHeaders['Authorization'] = `Bearer ${session.accessToken}`;
  }

  // Build request body based on spec
  let requestBodyObj: Record<string, string> = {};
  if (requestFields) {
    for (const [fieldName, sourceField] of Object.entries(requestFields)) {
      if (sourceField === 'carNum') {
        requestBodyObj[fieldName] = ctx.carNum;
      } else {
        requestBodyObj[fieldName] = ctx.carNum;
      }
    }
  } else {
    requestBodyObj = { carNum: ctx.carNum };
  }

  // Build headers string for fetch
  const headersEntries = [
    ["'Content-Type'", "'application/json'"],
    ...Object.entries(authHeaders).map(([k, v]) => [`'${k}'`, `'${v}'`]),
  ];
  const headersStr = headersEntries.map(([k, v]) => `${k}: ${v}`).join(', ');

  // Build fetch code
  let fetchCode: string;
  if (method === 'GET') {
    const params = new URLSearchParams(requestBodyObj).toString();
    const urlWithParams = params ? `${endpoint}?${params}` : endpoint;
    fetchCode = `
      (async () => {
        try {
          const response = await fetch('${urlWithParams}', {
            method: 'GET',
            headers: { ${headersStr} },
            credentials: 'include'
          });
          const data = await response.json().catch(() => response.text());
          return JSON.stringify({ status: response.status, ok: response.ok, data });
        } catch (e) {
          return JSON.stringify({ status: 0, ok: false, error: e.message });
        }
      })()
    `;
  } else {
    fetchCode = `
      (async () => {
        try {
          const response = await fetch('${endpoint}', {
            method: '${method}',
            headers: { ${headersStr} },
            body: JSON.stringify(${JSON.stringify(requestBodyObj)}),
            credentials: 'include'
          });
          const data = await response.json().catch(() => response.text());
          return JSON.stringify({ status: response.status, ok: response.ok, data });
        } catch (e) {
          return JSON.stringify({ status: 0, ok: false, error: e.message });
        }
      })()
    `;
  }

  const result = await ctx.mcpClient.callTool({
    name: 'browser_evaluate',
    arguments: { function: fetchCode },
  });

  const text = extractTextFromMcpResult(result);

  let response: { status: number; ok: boolean; data?: any; error?: string };
  try {
    response = JSON.parse(text);
  } catch {
    return {
      capturedRequest: {
        url: endpoint,
        method,
        requestBody: requestBodyObj,
        responseStatus: 0,
        responseBody: text,
        timestamp: Date.now(),
      },
      hasVehicle: false,
      vehicleInfo: null,
      status: 'API_CHANGED',
      error: `API 응답 파싱 실패: ${text.slice(0, 100)}`,
    };
  }

  const capturedRequest: CapturedNetworkRequest = {
    url: endpoint,
    method,
    requestBody: requestBodyObj,
    responseStatus: response.status,
    responseBody: response.data,
    timestamp: Date.now(),
  };

  // Handle errors
  if (response.status === 0 || response.error) {
    return {
      capturedRequest,
      hasVehicle: false,
      vehicleInfo: null,
      status: 'CONNECTION_ERROR',
      error: `API 네트워크 오류: ${response.error}`,
    };
  }

  if (response.status >= 400) {
    if (response.status === 401 || response.status === 403) {
      return {
        capturedRequest,
        hasVehicle: false,
        vehicleInfo: null,
        status: 'SESSION_EXPIRED',
        error: `API 인증 실패: HTTP ${response.status}`,
      };
    }
    return {
      capturedRequest,
      hasVehicle: false,
      vehicleInfo: null,
      status: 'API_CHANGED',
      error: `API 호출 실패: HTTP ${response.status}`,
    };
  }

  const hasVehicle = analyzeApiResponse(response.data);
  const vehicleInfo = hasVehicle ? extractVehicleInfo(response.data, ctx.carNum) : null;

  return {
    capturedRequest,
    hasVehicle,
    vehicleInfo,
    status: 'pending',
  };
}

/**
 * Analyze API response to determine if vehicle was found.
 * Handles various response formats from different parking systems.
 */
function analyzeApiResponse(data: any): boolean {
  if (!data) return false;

  // Array response: check if non-empty
  if (Array.isArray(data)) {
    return data.length > 0;
  }

  // Object response: check common patterns
  if (typeof data === 'object') {
    // Check for explicit result/success flags
    if ('success' in data && data.success === false) return false;
    if ('result' in data && data.result === false) return false;
    if ('found' in data) return Boolean(data.found);

    // Check for data arrays inside response
    if (data.data && Array.isArray(data.data)) return data.data.length > 0;
    if (data.list && Array.isArray(data.list)) return data.list.length > 0;
    if (data.items && Array.isArray(data.items)) return data.items.length > 0;
    if (data.results && Array.isArray(data.results)) return data.results.length > 0;
    if (data.vehicles && Array.isArray(data.vehicles)) return data.vehicles.length > 0;

    // Check for vehicle object
    if (data.vehicle) return true;
    if (data.car) return true;

    // Check for count field
    if ('count' in data) return data.count > 0;
    if ('totalCount' in data) return data.totalCount > 0;

    // Check for common "not found" indicators
    if (data.message) {
      const msg = String(data.message).toLowerCase();
      if (msg.includes('not found') || msg.includes('없습니다') || msg.includes('없음')) {
        return false;
      }
    }

    // If object has vehicle-related fields, consider it found
    if (data.inTime || data.entryTime || data.parkingFee || data.plateNumber) {
      return true;
    }
  }

  // String response: non-empty usually means success
  if (typeof data === 'string') {
    const lower = data.toLowerCase();
    if (lower.includes('not found') || lower.includes('없습니다') || lower.includes('없음')) {
      return false;
    }
    return data.trim().length > 0;
  }

  return false;
}

/**
 * Extract vehicle information from API response.
 */
function extractVehicleInfo(
  data: any,
  carNum: string
): { plateNumber: string; inTime: string; outTime?: string; parkingFee?: number } {
  // Find vehicle data from various response structures
  let vehicleData: any = data;

  if (Array.isArray(data) && data.length > 0) {
    vehicleData = data[0];
  } else if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
    vehicleData = data.data[0];
  } else if (data?.list && Array.isArray(data.list) && data.list.length > 0) {
    vehicleData = data.list[0];
  } else if (data?.vehicle) {
    vehicleData = data.vehicle;
  } else if (data?.car) {
    vehicleData = data.car;
  }

  return {
    plateNumber:
      vehicleData?.plateNumber ||
      vehicleData?.carNo ||
      vehicleData?.carNum ||
      vehicleData?.vehicleNo ||
      carNum,
    inTime:
      vehicleData?.inTime ||
      vehicleData?.entryTime ||
      vehicleData?.enterTime ||
      vehicleData?.입차시간 ||
      '',
    outTime: vehicleData?.outTime || vehicleData?.exitTime || vehicleData?.출차시간,
    parkingFee:
      vehicleData?.parkingFee ||
      vehicleData?.fee ||
      vehicleData?.amount ||
      vehicleData?.주차요금,
  };
}
