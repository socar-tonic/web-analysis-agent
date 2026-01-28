// src/agents/search-graph/nodes/execute-api-search.ts
import type { SearchGraphStateType, CapturedNetworkRequest } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult } from '../utils.js';

/**
 * executeApiSearch node - Execute API-based vehicle search.
 *
 * This is a simple function (NOT createAgent) that:
 * 1. Gets API spec from state.spec?.api
 * 2. Builds auth headers from state.session (accessToken, etc.)
 * 3. Executes the API call via browser_evaluate (using fetch)
 * 4. Captures the response as CapturedNetworkRequest
 * 5. Returns SUCCESS or NOT_FOUND based on response
 * 6. Returns API_CHANGED if API call fails (HTTP errors or network errors)
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
  console.log(`  [executeApiSearch] Calling API: ${method} ${endpoint}`);

  try {
    // Build auth headers from session
    const authHeaders: Record<string, string> = {};
    if (state.session?.accessToken) {
      authHeaders['Authorization'] = `Bearer ${state.session.accessToken}`;
    }

    // Build request body based on spec
    let requestBodyObj: Record<string, string> = {};
    if (requestFields) {
      // Map request fields: e.g., { "carNo": "carNum" } means use carNum value for carNo field
      for (const [fieldName, sourceField] of Object.entries(requestFields)) {
        if (sourceField === 'carNum') {
          requestBodyObj[fieldName] = ctx.carNum;
        } else {
          // Default: use field name directly
          requestBodyObj[fieldName] = ctx.carNum;
        }
      }
    } else {
      // Default field name for vehicle number
      requestBodyObj = { carNum: ctx.carNum };
    }

    // Build headers string for fetch
    const headersEntries = [
      ["'Content-Type'", "'application/json'"],
      ...Object.entries(authHeaders).map(([k, v]) => [`'${k}'`, `'${v}'`]),
    ];
    const headersStr = headersEntries.map(([k, v]) => `${k}: ${v}`).join(', ');

    // Build fetch code to execute in browser
    // For GET requests, append params to URL; for POST, send JSON body
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
      // POST request
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

    // Execute fetch in browser context
    const result = await ctx.mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: fetchCode },
    });

    const text = extractTextFromMcpResult(result);

    // Parse response
    let response: { status: number; ok: boolean; data?: any; error?: string };
    try {
      response = JSON.parse(text);
    } catch {
      console.log(`  [executeApiSearch] Failed to parse response: ${text.slice(0, 200)}`);
      return {
        status: 'API_CHANGED',
        errorMessage: `API 응답 파싱 실패: ${text.slice(0, 100)}`,
        capturedRequests: [
          {
            url: endpoint,
            method,
            requestBody: requestBodyObj,
            responseStatus: 0,
            responseBody: text,
            timestamp: Date.now(),
          },
        ],
      };
    }

    // Create captured request record
    const capturedRequest: CapturedNetworkRequest = {
      url: endpoint,
      method,
      requestBody: requestBodyObj,
      responseStatus: response.status,
      responseBody: response.data,
      timestamp: Date.now(),
    };

    // Handle network error (status 0)
    if (response.status === 0 || response.error) {
      console.log(`  [executeApiSearch] Network error: ${response.error}`);
      return {
        status: 'CONNECTION_ERROR',
        errorMessage: `API 네트워크 오류: ${response.error}`,
        capturedRequests: [capturedRequest],
      };
    }

    // Handle HTTP errors (4xx, 5xx)
    if (response.status >= 400) {
      console.log(`  [executeApiSearch] HTTP error: ${response.status}`);

      // 401/403 might indicate session expired or auth changed
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'SESSION_EXPIRED',
          errorMessage: `API 인증 실패: HTTP ${response.status}`,
          capturedRequests: [capturedRequest],
        };
      }

      // Other HTTP errors suggest API has changed
      return {
        status: 'API_CHANGED',
        errorMessage: `API 호출 실패: HTTP ${response.status}`,
        capturedRequests: [capturedRequest],
      };
    }

    // Success response - analyze data to determine if vehicle was found
    const hasVehicle = analyzeApiResponse(response.data);

    console.log(`  [executeApiSearch] API success (HTTP ${response.status}), vehicle found: ${hasVehicle}`);

    if (hasVehicle) {
      // Extract vehicle info from response
      const vehicleInfo = extractVehicleInfo(response.data, ctx.carNum);

      return {
        status: 'SUCCESS',
        confidence: 0.95,
        vehicle: vehicleInfo,
        capturedRequests: [capturedRequest],
      };
    } else {
      // No vehicle found - this is a normal "not found" result, not an error
      return {
        status: 'NOT_FOUND',
        confidence: 0.9,
        vehicle: null,
        capturedRequests: [capturedRequest],
      };
    }
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
