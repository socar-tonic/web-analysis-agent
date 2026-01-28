// src/agents/search-graph/nodes/capture-results.ts
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { createAgent } from 'langchain';
import type { SearchGraphStateType, CapturedNetworkRequest, VehicleInfo, SearchStatus } from '../state.js';
import { getNodeContext } from '../index.js';
import { extractTextFromMcpResult, GET_CAPTURED_REQUESTS_JS } from '../utils.js';

const CAPTURE_RESULTS_PROMPT = `You are analyzing search results after a vehicle search was executed.

## Your Task
Analyze the search results to determine the outcome and extract vehicle information if found.

## Tools Available
1. browser_snapshot - Get DOM structure to analyze results
2. browser_take_screenshot - Take a screenshot for visual verification
3. get_network_requests - Get captured API responses from the search

## Status Determination

### SUCCESS
- Vehicle information is displayed (entry time, plate number, parking fee, etc.)
- Table or list shows matching vehicle record
- Keywords: 입차시간, 차량번호, 주차요금, 출차, 주차시간

### NOT_FOUND
- "No results" or empty results message
- Empty table or "0 results"
- Keywords: 결과 없음, 해당 차량 없음, 검색 결과가 없습니다, 입차 기록 없음, 조회 결과가 없습니다
- This is a normal state (vehicle hasn't entered the parking lot)

### SESSION_EXPIRED
- Redirected to login page
- Session timeout message
- Keywords: 로그인, 세션 만료, 다시 로그인, login required

### TIMEOUT_ERROR
- Loading spinner still visible after search
- "Loading..." or "Please wait" stuck
- Page unresponsive

## Response Format (JSON)
{
  "status": "SUCCESS|NOT_FOUND|SESSION_EXPIRED|TIMEOUT_ERROR|UNKNOWN_ERROR",
  "vehicleFound": true/false,
  "resultCount": 0,
  "vehicle": {
    "plateNumber": "12가3456",
    "inTime": "2026-01-28 10:30",
    "outTime": null,
    "parkingFee": 5000
  },
  "confidence": 0.9,
  "reasoning": "Found vehicle record in table with entry time and plate number"
}

If vehicle not found (NOT_FOUND status):
{
  "status": "NOT_FOUND",
  "vehicleFound": false,
  "resultCount": 0,
  "vehicle": null,
  "confidence": 0.9,
  "reasoning": "Empty results table with '조회 결과가 없습니다' message"
}`;

export async function captureResults(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  const { mcpClient, llm, carNum } = ctx;

  console.log('  [captureResults] Starting agent-based result analysis...');

  // Pre-capture network requests before agent starts
  let capturedRequests: CapturedNetworkRequest[] = [];
  try {
    // Get the search start timestamp
    const timestampResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: '() => window.__searchStartTime || 0' },
    });
    const timestampText = extractTextFromMcpResult(timestampResult);
    const searchStartTime = parseInt(timestampText.match(/\d+/)?.[0] || '0', 10);
    console.log(`  [captureResults] Search start time: ${searchStartTime}`);

    // Get all captured requests
    const networkResult = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: GET_CAPTURED_REQUESTS_JS },
    });
    const rawText = extractTextFromMcpResult(networkResult);
    console.log(`  [captureResults] Raw MCP result (first 200 chars): ${rawText.slice(0, 200)}`);

    // Extract JSON array from MCP result (may contain markdown headers and be double-encoded)
    // MCP returns: ### Result\n"[{\"escaped\":\"json\"}]"\n### Ran Playwright...
    let jsonStr = rawText;

    // First, try to find a quoted JSON string (double-encoded case)
    const quotedMatch = rawText.match(/"(\[[\s\S]*?\])"/);
    if (quotedMatch) {
      // Unescape the JSON string
      jsonStr = quotedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      console.log(`  [captureResults] Extracted quoted JSON: ${jsonStr.slice(0, 100)}...`);
    } else {
      // Try direct JSON array match
      const directMatch = rawText.match(/\[[\s\S]*\]/);
      if (directMatch) {
        jsonStr = directMatch[0];
      }
    }

    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const rawRequests = JSON.parse(jsonMatch[0]);
      console.log(`  [captureResults] Total captured requests: ${rawRequests.length}`);

      // Map interceptor fields to CapturedNetworkRequest fields
      const allRequests = rawRequests.map((r: any) => {
        let requestBody = undefined;
        let responseBody = undefined;
        try {
          requestBody = r.requestBody || (r.body ? (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) : undefined);
        } catch { requestBody = r.body || r.requestBody; }
        try {
          responseBody = r.responseBody || (r.response ? (typeof r.response === 'string' ? JSON.parse(r.response) : r.response) : undefined);
        } catch { responseBody = r.response || r.responseBody; }
        return {
          url: r.url,
          method: r.method || 'GET',
          requestBody,
          responseStatus: r.responseStatus || r.status || 0,
          responseBody,
          timestamp: r.timestamp || Date.now(),
        };
      });

      // Filter to only requests after search started
      if (searchStartTime > 0) {
        capturedRequests = allRequests.filter((r: CapturedNetworkRequest) => r.timestamp >= searchStartTime);
        console.log(`  [captureResults] Filtered to ${capturedRequests.length} requests after search start`);
      } else {
        capturedRequests = allRequests;
      }

      console.log(`  [captureResults] Search-related requests (after ${searchStartTime}):`);
      for (const req of capturedRequests.slice(0, 10)) {
        console.log(`    - ${req.method} ${req.url} (${req.responseStatus}) @${req.timestamp}`);
      }

      // Also log all requests if none matched, for debugging
      if (capturedRequests.length === 0 && allRequests.length > 0) {
        console.log(`  [captureResults] DEBUG: All ${allRequests.length} requests with timestamps:`);
        for (const req of allRequests.slice(-5)) {
          const diff = req.timestamp - searchStartTime;
          console.log(`    - ${req.method} ${req.url} @${req.timestamp} (diff: ${diff}ms)`);
        }
      }
    } else {
      console.log(`  [captureResults] No JSON array found in MCP result`);
    }
  } catch (e) {
    console.log(`  [captureResults] Could not pre-capture network requests: ${(e as Error).message}`);
  }

  // Build tools for the agent
  const browserSnapshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {},
      });
      return extractTextFromMcpResult(result);
    },
    {
      name: 'browser_snapshot',
      description: 'Get DOM snapshot to analyze search results structure',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  const browserScreenshotTool = tool(
    async (_input: { _unused?: string }) => {
      const result = await mcpClient.callTool({
        name: 'browser_take_screenshot',
        arguments: { type: 'png' },
      });
      const contents = result.content as any[];
      for (const c of contents) {
        if (c.type === 'image' && c.data) {
          const filename = `search-result-${Date.now()}.png`;
          writeFileSync(filename, Buffer.from(c.data, 'base64'));
          console.log(`      [captureResults] Screenshot saved: ${filename}`);
          return `Screenshot saved to ${filename}. The page shows the search results.`;
        }
      }
      return 'No screenshot captured';
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take a screenshot for visual verification of search results',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  const getNetworkRequestsTool = tool(
    async (_input: { _unused?: string }) => {
      // Fetch latest network requests
      const result = await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: GET_CAPTURED_REQUESTS_JS },
      });
      const requestsJson = extractTextFromMcpResult(result);
      if (requestsJson) {
        const requests = JSON.parse(requestsJson);
        // Return last 10 requests for analysis
        return JSON.stringify(requests.slice(-10), null, 2);
      }
      return '[]';
    },
    {
      name: 'get_network_requests',
      description: 'Get captured network requests to see search API responses',
      schema: z.object({
        _unused: z.string().optional().describe('Not used, pass empty string'),
      }),
    }
  );

  try {
    const agent = createAgent({
      model: llm,
      tools: [browserSnapshotTool, browserScreenshotTool, getNetworkRequestsTool],
      systemPrompt: CAPTURE_RESULTS_PROMPT,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(`Analyze the search results for vehicle "${carNum}".`)] },
      { recursionLimit: 12 }
    );

    // Extract final response from last AI message
    const messages = result.messages as any[];
    let finalResponse = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        finalResponse = msg.content;
        break;
      }
    }

    console.log(`  [captureResults] Agent response: ${finalResponse.slice(0, 300)}...`);

    // Parse result
    let status: SearchStatus = 'UNKNOWN_ERROR';
    let vehicle: VehicleInfo | null = null;
    let resultCount = 0;
    let confidence = 0.5;

    try {
      const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        status = parsed.status || 'UNKNOWN_ERROR';
        resultCount = parsed.resultCount || 0;
        confidence = parsed.confidence || 0.7;

        if (parsed.vehicleFound && parsed.vehicle) {
          vehicle = {
            plateNumber: parsed.vehicle.plateNumber || carNum,
            inTime: parsed.vehicle.inTime || '',
            outTime: parsed.vehicle.outTime || undefined,
            parkingFee: parsed.vehicle.parkingFee || undefined,
            id: parsed.vehicle.id || undefined,
          };
        }
      }
    } catch (e) {
      console.log(`  [captureResults] Failed to parse response: ${(e as Error).message}`);
    }

    console.log(`  [captureResults] Status: ${status}, Vehicle: ${!!vehicle}, Confidence: ${confidence}`);

    return {
      status,
      vehicle,
      resultCount,
      capturedRequests,
      confidence,
    };
  } catch (e) {
    console.log(`  [captureResults] Error: ${(e as Error).message}`);
    return {
      status: 'UNKNOWN_ERROR',
      errorMessage: `Result capture failed: ${(e as Error).message}`,
      capturedRequests,
    };
  }
}
