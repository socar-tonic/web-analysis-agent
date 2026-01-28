// src/agents/search-graph/utils.ts

/**
 * Extract text content from MCP tool call result.
 * Handles multiple content items and missing text properties.
 */
export function extractTextFromMcpResult(result: any): string {
  if (!result || !result.content) {
    return '';
  }
  const contents = result.content as any[];
  return contents?.map((c: any) => c.text || '').join('\n') || '';
}

/**
 * Extract the last 4 digits from a Korean vehicle plate number.
 * Used for keypad-style input where only digits are needed.
 *
 * @example
 * extractLast4Digits('12가3456') // '3456'
 * extractLast4Digits('서울12가3456') // '3456'
 */
export function extractLast4Digits(carNum: string): string {
  return carNum.replace(/[^0-9]/g, '').slice(-4);
}

/**
 * JavaScript code to inject network interceptor into the browser.
 * Captures fetch and XMLHttpRequest requests/responses.
 * Wrapped as arrow function for Playwright MCP browser_evaluate.
 *
 * Passwords are masked for security.
 * Captured requests are stored in window.__capturedApiRequests.
 */
export const NETWORK_INTERCEPTOR_JS = `() => {
  if (window.__networkInterceptorInstalled) return 'Already installed';
  window.__networkInterceptorInstalled = true;
  window.__capturedApiRequests = [];

  const originalFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const requestBody = options.body;
    const startTime = Date.now();
    const urlStr = typeof url === 'string' ? url : url.url;

    let parsedRequestBody = null;
    if (requestBody) {
      if (typeof requestBody === 'string') {
        try { parsedRequestBody = JSON.parse(requestBody); } catch {
          try { parsedRequestBody = Object.fromEntries(new URLSearchParams(requestBody)); } catch { parsedRequestBody = requestBody; }
        }
      } else if (requestBody instanceof URLSearchParams) {
        parsedRequestBody = Object.fromEntries(requestBody);
      } else if (requestBody instanceof FormData) {
        parsedRequestBody = {};
        for (const [key, value] of requestBody.entries()) {
          parsedRequestBody[key] = typeof value === 'string' ? value : '[File]';
        }
      } else if (typeof requestBody === 'object') {
        try {
          if (requestBody.entries && typeof requestBody.entries === 'function') {
            parsedRequestBody = Object.fromEntries(requestBody.entries());
          }
        } catch {}
      }
    }

    if (parsedRequestBody && typeof parsedRequestBody === 'object') {
      for (const key of Object.keys(parsedRequestBody)) {
        if (key.toLowerCase().includes('pass') || key.toLowerCase().includes('pwd')) {
          parsedRequestBody[key] = '***MASKED***';
        }
      }
    }

    try {
      const response = await originalFetch.apply(this, [url, options]);
      const clonedResponse = response.clone();
      let responseBody = null;
      try {
        const text = await clonedResponse.text();
        try { responseBody = JSON.parse(text); } catch { responseBody = text.substring(0, 500); }
      } catch {}

      window.__capturedApiRequests.push({
        type: 'fetch', url: urlStr, method: method,
        requestBody: parsedRequestBody, responseStatus: response.status,
        responseBody: responseBody, timestamp: startTime
      });
      return response;
    } catch (e) {
      window.__capturedApiRequests.push({
        type: 'fetch', url: urlStr, method: method,
        requestBody: parsedRequestBody, responseStatus: 0, error: e.message, timestamp: startTime
      });
      throw e;
    }
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__method = method;
    this.__url = url;
    this.__startTime = Date.now();
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    let parsedBody = null;
    if (body) {
      if (typeof body === 'string') {
        try { parsedBody = JSON.parse(body); } catch {
          try { parsedBody = Object.fromEntries(new URLSearchParams(body)); } catch { parsedBody = body; }
        }
      } else if (body instanceof URLSearchParams) {
        parsedBody = Object.fromEntries(body);
      } else if (body instanceof FormData) {
        parsedBody = {};
        for (const [key, value] of body.entries()) {
          parsedBody[key] = typeof value === 'string' ? value : '[File]';
        }
      } else if (typeof body === 'object') {
        try {
          if (body.entries && typeof body.entries === 'function') {
            parsedBody = Object.fromEntries(body.entries());
          }
        } catch {}
      }
    }
    // Mask passwords
    if (parsedBody && typeof parsedBody === 'object') {
      for (const key of Object.keys(parsedBody)) {
        if (key.toLowerCase().includes('pass') || key.toLowerCase().includes('pwd')) {
          parsedBody[key] = '***MASKED***';
        }
      }
    }
    this.__requestBody = parsedBody;

    const xhr = this;
    this.addEventListener('load', function() {
      let responseBody = xhr.responseText;
      try { responseBody = JSON.parse(responseBody); } catch { responseBody = responseBody.substring(0, 500); }
      window.__capturedApiRequests.push({
        type: 'xhr', url: xhr.__url, method: xhr.__method,
        requestBody: xhr.__requestBody, responseStatus: xhr.status,
        responseBody: responseBody, timestamp: xhr.__startTime
      });
    });

    return originalXHRSend.apply(this, arguments);
  };

  return 'Network interceptor installed';
}`;

/**
 * JavaScript code to retrieve captured network requests from the browser.
 * Returns JSON string of captured requests array.
 */
export const GET_CAPTURED_REQUESTS_JS = `() => JSON.stringify(window.__capturedApiRequests || [])`;
