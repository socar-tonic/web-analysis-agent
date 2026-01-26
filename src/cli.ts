import 'dotenv/config';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { chromium, Browser, Page } from 'playwright';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LoginAgent } from './agents/index.js';
import { CredentialManager } from './security/index.js';
import { SpecStore } from './specs/index.js';

// Input schema
interface MockInput {
  systemCode: string;
  url: string;
  id: string;
  pwd: string;
  discountId: string;
  carNum: string;
  loginSuccessSelector?: string;  // 로그인 성공 확인용 셀렉터
}

interface AgentResult {
  agent: string;
  success: boolean;
  analysis?: string;
  data?: any;
  error?: string;
}

interface DomAnalysis {
  pageType: 'login' | 'dashboard' | 'search' | 'discount' | 'error' | 'unknown';
  elements: {
    loginForm: {
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
    } | null;
    vehicleSearch: {
      inputSelector: string;
      searchButtonSelector: string;
    } | null;
    discountAction: {
      applyButtonSelector: string;
      confirmSelector: string;
    } | null;
  };
  issues: string[];
  confidence: number;
}

// Parse LLM response to extract JSON
function parseAnalysisJson<T>(analysis: string): T | null {
  try {
    // Extract JSON from markdown code block if present
    const jsonMatch = analysis.match(/```json\s*([\s\S]*?)\s*```/) ||
                      analysis.match(/```\s*([\s\S]*?)\s*```/) ||
                      [null, analysis];
    const jsonStr = jsonMatch[1] || analysis;
    return JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
}

// LLM invoke wrapper with timeout and clear error messages
async function llmInvokeWithRetry(
  llm: BaseChatModel,
  messages: (SystemMessage | HumanMessage)[],
  timeoutMs = 60000
): Promise<string> {
  console.log(`      [LLM] Calling... (timeout: ${timeoutMs / 1000}s)`);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      llm.invoke(messages),
      timeoutPromise
    ]);
    console.log(`      [LLM] Response received`);
    return response.content as string;
  } catch (error) {
    const errorMessage = (error as Error).message || '';
    console.log(`      [LLM] Error: ${errorMessage.slice(0, 100)}`);

    // Check if it's a rate limit error (429)
    if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
      throw new Error('⚠️ Rate limit exceeded. Please wait and try again later.');
    }

    throw error;
  }
}

// Load mock input
function loadInput(path: string): MockInput {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

// Initialize LLM (Internal > Google > OpenAI > Anthropic based on available API key)
function createLLM(): BaseChatModel {
  // Priority: INTERNAL_AI > GOOGLE > OPENAI > ANTHROPIC

  // 사내 AI 라우터 (ChatOpenAI 인터페이스)
  if (process.env.INTERNAL_AI_URL && process.env.INTERNAL_AI_KEY) {
    const model = process.env.INTERNAL_AI_MODEL || 'gpt-4';
    console.log(`  Using: Internal AI Router (${model})`);
    return new ChatOpenAI({
      model,
      apiKey: process.env.INTERNAL_AI_KEY,
      temperature: 0,
      maxTokens: 16384,
      configuration: {
        baseURL: process.env.INTERNAL_AI_URL,
      },
    });
  }

  if (process.env.GOOGLE_API_KEY) {
    console.log('  Using: Google Gemini (gemini-2.5-flash)');
    return new ChatGoogleGenerativeAI({
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 16384,
      apiKey: process.env.GOOGLE_API_KEY,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    console.log('  Using: OpenAI (gpt-4o)');
    return new ChatOpenAI({
      model: 'gpt-4o',
      temperature: 0,
      maxTokens: 16384,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  Using: Anthropic (claude-sonnet-4)');
    return new ChatAnthropic({
      model: 'claude-sonnet-4-20250514',
      temperature: 0,
      maxTokens: 16384,
    });
  }

  throw new Error('No API key found. Set INTERNAL_AI_URL+INTERNAL_AI_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY');
}

// Fast login success detection (heuristic-based, no LLM)
async function detectLoginSuccess(
  page: Page,
  _llm: BaseChatModel,
  urlBefore: string
): Promise<{ success: boolean; reason: string; pageType: string }> {
  const urlAfter = page.url();
  const urlChanged = urlBefore !== urlAfter;

  // Quick DOM checks
  const checks = await page.evaluate(() => {
    const body = document.body?.innerText?.toLowerCase() || '';
    const html = document.documentElement?.innerHTML?.toLowerCase() || '';

    return {
      // Failure indicators
      hasLoginForm: !!document.querySelector('input[type="password"]'),
      hasErrorText: body.includes('실패') || body.includes('error') || body.includes('invalid') ||
                    body.includes('incorrect') || body.includes('잘못') || body.includes('틀렸'),
      hasErrorElement: !!document.querySelector('.error, .alert-error, .alert-danger, [class*="error"]'),

      // Success indicators
      hasLogoutButton: !!document.querySelector('a[href*="logout"], button[onclick*="logout"], [class*="logout"]'),
      hasUserMenu: !!document.querySelector('[class*="user-menu"], [class*="profile"], [class*="avatar"]'),
      hasDashboard: body.includes('dashboard') || body.includes('대시보드') || body.includes('메인'),
      hasWelcome: body.includes('welcome') || body.includes('환영') || body.includes('님'),
    };
  });

  // Decision logic
  let success = false;
  let reason = '';

  // Strong failure signals
  if (checks.hasErrorText || checks.hasErrorElement) {
    success = false;
    reason = 'Error message detected';
  }
  // Login form still visible = likely failed
  else if (checks.hasLoginForm && !urlChanged) {
    success = false;
    reason = 'Login form still visible, URL unchanged';
  }
  // Strong success signals
  else if (checks.hasLogoutButton || checks.hasUserMenu) {
    success = true;
    reason = 'Logout button or user menu found';
  }
  // URL changed + no login form = likely success
  else if (urlChanged && !checks.hasLoginForm) {
    success = true;
    reason = 'URL changed and login form disappeared';
  }
  // URL changed but login form still there (might be multi-step)
  else if (urlChanged && checks.hasLoginForm) {
    success = false;
    reason = 'URL changed but login form still present';
  }
  // Fallback
  else {
    success = checks.hasDashboard || checks.hasWelcome;
    reason = success ? 'Dashboard/welcome text found' : 'No clear indicators';
  }

  console.log(`      [Detection] URL changed: ${urlChanged}, Login form: ${checks.hasLoginForm}, Error: ${checks.hasErrorText || checks.hasErrorElement}, Logout btn: ${checks.hasLogoutButton}`);

  return {
    success,
    reason,
    pageType: success ? 'dashboard' : (checks.hasLoginForm ? 'login' : 'unknown'),
  };
}

// Sanitize HTML for LLM (remove scripts, styles, limit size)
function sanitizeHtml(html: string, maxLength = 50000): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// DOM Agent - analyzes page structure with LLM
async function runDomAgent(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[DOM Agent] Analyzing: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });

    // Wait for dynamic content
    await page.waitForTimeout(2000);

    // Check for redirects
    const finalUrl = page.url();
    if (finalUrl !== input.url) {
      console.log(`  Redirected to: ${finalUrl}`);
    }

    // Capture page content
    const title = await page.title();
    const html = await page.content();
    const sanitizedHtml = sanitizeHtml(html);

    console.log(`  Page loaded: ${title}`);
    console.log(`  HTML size: ${html.length} -> ${sanitizedHtml.length} (sanitized)`);

    // Debug: save screenshot
    const screenshotPath = `debug-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  Screenshot saved: ${screenshotPath}`);

    // Check for iframes
    const iframes = await page.locator('iframe').count();
    if (iframes > 0) {
      console.log(`  ⚠️  Found ${iframes} iframe(s) - login form might be inside`);
    }

    // Quick element check
    const forms = await page.locator('form').count();
    const inputs = await page.locator('input').count();
    const passwordInputs = await page.locator('input[type="password"]').count();
    console.log(`  Elements: ${forms} forms, ${inputs} inputs, ${passwordInputs} password fields`);

    // LLM Analysis
    console.log(`  Analyzing with LLM...`);

    const systemPrompt = `You are a web page analyzer for a parking discount automation system.
Your job is to analyze HTML and identify key elements for automation.

IMPORTANT: Never include or reference any passwords, tokens, or sensitive credentials in your response.

Analyze the page and identify:
1. Login form elements (if any): input fields for username/password, submit button
2. Vehicle search elements: input for car number, search button
3. Discount application elements: discount buttons, confirmation dialogs
4. Any error messages or status indicators

Respond in JSON format:
{
  "pageType": "login|dashboard|search|discount|error|unknown",
  "elements": {
    "loginForm": { "usernameSelector": "...", "passwordSelector": "...", "submitSelector": "..." } | null,
    "vehicleSearch": { "inputSelector": "...", "searchButtonSelector": "..." } | null,
    "discountAction": { "applyButtonSelector": "...", "confirmSelector": "..." } | null
  },
  "issues": ["list of potential issues or changes detected"],
  "confidence": 0.0-1.0
}`;

    const response = await llmInvokeWithRetry(llm, [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this HTML page:

URL: ${input.url}
Title: ${title}
SystemCode: ${input.systemCode}

HTML Content:
${sanitizedHtml}`),
    ]);

    const analysis = response;
    console.log(`  Analysis complete`);

    return {
      agent: 'dom',
      success: true,
      analysis,
      data: { title, htmlLength: html.length },
    };
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    return {
      agent: 'dom',
      success: false,
      error: (error as Error).message,
    };
  } finally {
    await browser.close();
  }
}

// Network Agent - captures full API flow: login → search → discount
async function runNetworkAgent(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Network Agent] Full API flow capture: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const requests: {
    phase: string;
    method: string;
    url: string;
    postData?: string;
    status?: number;
    responseBody?: string;
  }[] = [];

  let currentPhase = 'init';

  // Capture requests (sanitize sensitive data)
  page.on('request', (req) => {
    const url = req.url();
    if (url.match(/\.(png|jpg|jpeg|gif|svg|css|woff|woff2|ttf|ico|js)$/i)) return;

    requests.push({
      phase: currentPhase,
      method: req.method(),
      url: url,
      postData: req.postData()
        ?.replace(/password[^&"]*/gi, 'password=***')
        ?.replace(/pwd[^&"]*/gi, 'pwd=***'),
    });
  });

  page.on('response', async (res) => {
    const req = requests.find((r) => r.url === res.url() && !r.status);
    if (req) {
      req.status = res.status();
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const body = await res.text();
          req.responseBody = body
            .replace(/"(token|session|cookie|password|pwd|access_token)":\s*"[^"]*"/gi, '"$1":"***"')
            .slice(0, 2000);
        }
      } catch { /* ignore */ }
    }
  });

  try {
    // ========== Phase 1: Login Page ==========
    currentPhase = 'login_page';
    console.log(`\n  [Phase 1] Loading login page...`);
    await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // ========== Phase 2: Login Submit ==========
    currentPhase = 'login_submit';
    console.log(`  [Phase 2] Logging in...`);

    const urlBeforeLogin = page.url();

    // LLM으로 로그인 폼 찾기
    const loginHtml = sanitizeHtml(await page.content());
    const loginFormPrompt = `Find login form selectors in this HTML. Respond ONLY JSON:
{ "username": "selector", "password": "selector", "submit": "selector" }`;

    const loginFormResponse = await llmInvokeWithRetry(llm, [
      new SystemMessage(loginFormPrompt),
      new HumanMessage(loginHtml),
    ]);

    const loginForm = parseAnalysisJson<{ username: string; password: string; submit: string }>(loginFormResponse);

    if (loginForm) {
      await page.fill(loginForm.username, input.id);
      await page.fill(loginForm.password, input.pwd);
      await page.click(loginForm.submit);
      await page.waitForTimeout(3000);
      console.log(`    ✓ Login submitted`);
    } else {
      console.log(`    ⚠️ Login form not found`);
    }

    // ========== Phase 3: Check Login Success ==========
    let loginSuccess = false;
    if (input.loginSuccessSelector) {
      // Fast path: use provided selector
      try {
        await page.waitForSelector(input.loginSuccessSelector, { timeout: 5000 });
        loginSuccess = true;
        console.log(`    ✓ Login successful (selector)`);
      } catch {
        console.log(`    ❌ Login failed (selector not found)`);
      }
    } else {
      // LLM-based detection
      console.log(`    Analyzing login result...`);
      const detection = await detectLoginSuccess(page, llm, urlBeforeLogin);
      loginSuccess = detection.success;
      console.log(`    ${loginSuccess ? '✓' : '❌'} Login ${loginSuccess ? 'successful' : 'failed'}: ${detection.reason}`);
    }

    // ========== Phase 4: Search Vehicle ==========
    if (loginSuccess) {
      currentPhase = 'search';
      console.log(`  [Phase 3] Searching vehicle...`);

      // LLM으로 검색 폼 찾기
      const searchHtml = sanitizeHtml(await page.content());
      const searchFormPrompt = `Find vehicle search form in this HTML. Respond ONLY JSON:
{ "input": "selector for car number input", "submit": "selector for search button" }`;

      const searchFormResponse = await llmInvokeWithRetry(llm, [
        new SystemMessage(searchFormPrompt),
        new HumanMessage(searchHtml),
      ]);

      const searchForm = parseAnalysisJson<{ input: string; submit: string }>(searchFormResponse);

      if (searchForm) {
        const carNum = input.carNum.replace(/[^0-9]/g, '').slice(-4);
        await page.fill(searchForm.input, carNum);
        await page.click(searchForm.submit);
        await page.waitForTimeout(3000);
        console.log(`    ✓ Search: ${carNum}`);

        // ========== Phase 5: Apply Discount ==========
        currentPhase = 'discount';
        console.log(`  [Phase 4] Checking for discount...`);

        const resultHtml = sanitizeHtml(await page.content());
        const discountPrompt = `Analyze search result. Find discount button if vehicle found. Respond ONLY JSON:
{ "vehicleFound": true/false, "discountButton": "selector or null" }`;

        const discountResponse = await llmInvokeWithRetry(llm, [
          new SystemMessage(discountPrompt),
          new HumanMessage(resultHtml),
        ]);

        const discountInfo = parseAnalysisJson<{ vehicleFound: boolean; discountButton: string | null }>(discountResponse);

        if (discountInfo?.vehicleFound && discountInfo?.discountButton) {
          console.log(`    ✓ Vehicle found, applying discount...`);
          try {
            await page.click(discountInfo.discountButton);
            await page.waitForTimeout(3000);
            console.log(`    ✓ Discount applied`);
          } catch (e) {
            console.log(`    ⚠️ Discount click failed: ${(e as Error).message}`);
          }
        } else if (discountInfo?.vehicleFound) {
          console.log(`    ⚠️ Vehicle found but no discount button`);
        } else {
          console.log(`    ⚠️ Vehicle not found (not in parking)`);
        }
      } else {
        console.log(`    ⚠️ Search form not found`);
      }
    }

    // ========== Analysis ==========
    currentPhase = 'done';
    console.log(`\n  Captured ${requests.length} API requests`);

    // Group by phase
    const byPhase: Record<string, typeof requests> = {};
    for (const req of requests) {
      if (!byPhase[req.phase]) byPhase[req.phase] = [];
      byPhase[req.phase].push(req);
    }

    // Group by domain (web URL vs API URL)
    const byDomain: Record<string, typeof requests> = {};
    for (const req of requests) {
      const domain = new URL(req.url).origin;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(req);
    }

    console.log(`\n  By Phase:`);
    Object.entries(byPhase).forEach(([phase, reqs]) => {
      console.log(`    ${phase}: ${reqs.length} requests`);
    });

    console.log(`\n  By Domain:`);
    Object.entries(byDomain).forEach(([domain, reqs]) => {
      console.log(`    ${domain}: ${reqs.length} requests`);
      // Show key API calls (POST, non-200)
      const keyReqs = reqs.filter(r => r.method !== 'GET' || (r.status && r.status !== 200));
      keyReqs.slice(0, 5).forEach(r => {
        const path = new URL(r.url).pathname;
        console.log(`      ${r.method} ${path} → ${r.status || 'pending'}`);
      });
    });

    // LLM Analysis
    console.log(`\n  Analyzing API patterns...`);

    const systemPrompt = `You are analyzing API traffic from a parking discount system.
IMPORTANT: Web URL and API URL may be DIFFERENT domains.

Traffic is grouped by phase: login_page, login_submit, search, discount.

Identify ALL API endpoints with FULL URLs (including domain):

Respond ONLY JSON:
{
  "webDomain": "https://console.example.com",
  "apiDomain": "https://api.example.com (if different)",
  "endpoints": {
    "auth": {
      "fullUrl": "https://api.example.com/auth",
      "method": "POST",
      "contentType": "form-data|json",
      "requestFields": ["username", "password", "..."],
      "responseFields": ["access_token", "refresh_token", "..."]
    } | null,
    "search": {
      "fullUrl": "https://api.example.com/...",
      "method": "GET|POST",
      "params": ["carNum", "siteId", "..."]
    } | null,
    "discount": {
      "fullUrl": "https://api.example.com/...",
      "method": "POST",
      "params": ["...", "..."]
    } | null,
    "other": [
      { "fullUrl": "...", "method": "...", "purpose": "..." }
    ]
  },
  "observations": ["API domain is different from web domain", "uses JWT auth", "..."]
}`;

    // Include FULL URLs (with domain)
    const trafficSummary = Object.entries(byPhase).map(([phase, reqs]) => ({
      phase,
      requests: reqs.map(r => ({
        method: r.method,
        fullUrl: r.url,  // Keep full URL
        status: r.status,
        body: r.postData?.slice(0, 500),
        response: r.responseBody?.slice(0, 500),
      })),
    }));

    const response = await llmInvokeWithRetry(llm, [
      new SystemMessage(systemPrompt),
      new HumanMessage(`API Traffic:\n${JSON.stringify(trafficSummary, null, 2)}`),
    ]);

    console.log(`  ✓ Analysis complete`);

    // Save full results to file
    const outputFile = `network-analysis-${Date.now()}.json`;
    const fullOutput = {
      timestamp: new Date().toISOString(),
      systemCode: input.systemCode,
      totalRequests: requests.length,
      byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.length])),
      byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, v.length])),
      analysis: parseAnalysisJson(response) || response,
      rawTraffic: trafficSummary,
    };

    const { writeFileSync } = await import('fs');
    writeFileSync(outputFile, JSON.stringify(fullOutput, null, 2));
    console.log(`  📄 Full results saved: ${outputFile}`);

    return {
      agent: 'network',
      success: true,
      analysis: response,
      data: {
        totalRequests: requests.length,
        byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.length])),
        outputFile,
      },
    };
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    return {
      agent: 'network',
      success: false,
      error: (error as Error).message,
    };
  } finally {
    await browser.close();
  }
}

// Policy Agent - validates configuration with LLM
async function runPolicyAgent(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Policy Agent] Validating config for: ${input.systemCode}`);

  try {
    // Basic validation first
    const issues: string[] = [];

    if (!input.discountId || input.discountId.length < 3) {
      issues.push('discountId is missing or too short');
    }

    if (!input.carNum) {
      issues.push('carNum is missing');
    }

    if (!input.url || !input.url.startsWith('http')) {
      issues.push('url is invalid');
    }

    if (!input.id) {
      issues.push('login id is missing');
    }

    // Note: We check pwd exists but don't pass it to LLM
    if (!input.pwd) {
      issues.push('login password is missing');
    }

    if (issues.length > 0) {
      console.log(`  Basic validation failed:`);
      issues.forEach((i) => console.log(`    - ${i}`));
    }

    // LLM Analysis for deeper policy validation
    console.log(`  Analyzing with LLM...`);

    const systemPrompt = `You are a configuration validator for a parking discount automation system.
Your job is to validate system configuration and identify potential issues.

IMPORTANT: Never include or reference any passwords, tokens, or sensitive credentials in your response.
You will NOT receive password information - only validate what you can see.

Validate the configuration and check:
1. Is the systemCode format valid?
2. Is the discountId format reasonable?
3. Is the carNum (vehicle number) in valid Korean format? (e.g., 12가3456, 서울12가3456)
4. Is the URL a valid vendor site?

Respond in JSON format:
{
  "validations": {
    "systemCode": { "valid": true/false, "reason": "..." },
    "discountId": { "valid": true/false, "reason": "..." },
    "carNum": { "valid": true/false, "reason": "..." },
    "url": { "valid": true/false, "reason": "..." }
  },
  "overallValid": true/false,
  "recommendations": ["list of recommendations"],
  "confidence": 0.0-1.0
}`;

    // Only pass non-sensitive data to LLM
    const response = await llmInvokeWithRetry(llm, [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Validate this configuration:

SystemCode: ${input.systemCode}
URL: ${input.url}
DiscountId: ${input.discountId}
CarNum: ${input.carNum}
HasCredentials: ${!!input.id && !!input.pwd}`),
    ]);

    const analysis = response;
    console.log(`  Analysis complete`);

    return {
      agent: 'policy',
      success: issues.length === 0,
      analysis,
      data: { basicIssues: issues },
    };
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    return {
      agent: 'policy',
      success: false,
      error: (error as Error).message,
    };
  }
}

// Login Flow - analyzes page, logs in, then analyzes authenticated page
async function runLoginFlow(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Login Flow] Starting for: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: Navigate to login page
    console.log(`  Step 1: Loading login page...`);
    await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Step 2: Analyze login page with LLM
    console.log(`  Step 2: Analyzing login page...`);
    const html = await page.content();
    const sanitizedHtml = sanitizeHtml(html);
    const title = await page.title();

    const systemPrompt = `You are a web page analyzer. Analyze the HTML and find login form selectors.
Respond ONLY with JSON, no explanation:
{
  "pageType": "login|dashboard|search|discount|error|unknown",
  "elements": {
    "loginForm": { "usernameSelector": "...", "passwordSelector": "...", "submitSelector": "..." } | null,
    "vehicleSearch": { "inputSelector": "...", "searchButtonSelector": "..." } | null,
    "discountAction": null
  },
  "issues": [],
  "confidence": 0.0-1.0
}`;

    const response = await llmInvokeWithRetry(llm, [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Find login form selectors:\n\nURL: ${input.url}\nTitle: ${title}\n\nHTML:\n${sanitizedHtml}`),
    ]);

    const analysisText = response;
    const analysis = parseAnalysisJson<DomAnalysis>(analysisText);

    if (!analysis || analysis.pageType !== 'login' || !analysis.elements.loginForm) {
      console.log(`  ⚠️  Not a login page or login form not found`);
      console.log(`  Analysis: ${analysisText}`);
      return {
        agent: 'login',
        success: false,
        error: 'Login form not found',
        analysis: analysisText,
      };
    }

    const { usernameSelector, passwordSelector, submitSelector } = analysis.elements.loginForm;
    console.log(`  Found selectors:`);
    console.log(`    username: ${usernameSelector}`);
    console.log(`    password: ${passwordSelector}`);
    console.log(`    submit: ${submitSelector}`);

    // Step 3: Perform login
    console.log(`  Step 3: Performing login...`);

    // Fill username
    await page.waitForSelector(usernameSelector, { timeout: 5000 });
    await page.fill(usernameSelector, input.id);
    console.log(`    ✓ Username filled`);

    // Fill password
    await page.waitForSelector(passwordSelector, { timeout: 5000 });
    await page.fill(passwordSelector, input.pwd);
    console.log(`    ✓ Password filled`);

    // Take screenshot before submit
    await page.screenshot({ path: 'debug-before-login.png' });
    console.log(`    Screenshot: debug-before-login.png`);

    // Click submit and wait for navigation
    const urlBefore = page.url();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click(submitSelector),
    ]);

    await page.waitForTimeout(3000);
    const urlAfter = page.url();

    // Step 4: Check login result
    console.log(`  Step 4: Checking login result...`);
    console.log(`    URL before: ${urlBefore}`);
    console.log(`    URL after: ${urlAfter}`);

    // Take screenshot after login
    const screenshotPath = `debug-after-login-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`    Screenshot: ${screenshotPath}`);

    // Check login success
    let loginSuccess = false;
    let loginDetectionReason = '';

    // Method 1: Check for loginSuccessSelector (fast path)
    if (input.loginSuccessSelector) {
      console.log(`    Checking for success selector: ${input.loginSuccessSelector}`);
      try {
        await page.waitForSelector(input.loginSuccessSelector, { timeout: 5000 });
        loginSuccess = true;
        loginDetectionReason = 'selector matched';
        console.log(`    ✓ Success selector found!`);
      } catch {
        console.log(`    ✗ Success selector not found`);
        loginDetectionReason = 'selector not found';
      }
    } else {
      // Method 2: LLM-based detection
      console.log(`    Analyzing with LLM...`);
      const detection = await detectLoginSuccess(page, llm, urlBefore);
      loginSuccess = detection.success;
      loginDetectionReason = detection.reason;
      console.log(`    ${loginSuccess ? '✓' : '✗'} ${loginDetectionReason}`);
    }

    if (loginSuccess) {
      console.log(`  ✓ Login successful`);
    } else {
      console.log(`  ❌ Login failed`);
    }

    // Step 5: Analyze authenticated page
    console.log(`  Step 5: Analyzing authenticated page...`);
    const authHtml = await page.content();
    const authTitle = await page.title();
    const sanitizedAuthHtml = sanitizeHtml(authHtml);

    const authResponse = await llmInvokeWithRetry(llm, [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this page after login:\n\nURL: ${urlAfter}\nTitle: ${authTitle}\n\nHTML:\n${sanitizedAuthHtml}`),
    ]);

    const authAnalysisText = authResponse;
    const authAnalysis = parseAnalysisJson<DomAnalysis>(authAnalysisText);
    console.log(`  Analysis complete`);

    // Step 6: Vehicle search (if vehicleSearch selectors found)
    let searchResult: any = null;
    if (loginSuccess && authAnalysis?.elements?.vehicleSearch) {
      console.log(`\n  Step 6: Searching for vehicle...`);
      const { inputSelector, searchButtonSelector } = authAnalysis.elements.vehicleSearch;
      console.log(`    Input selector: ${inputSelector}`);
      console.log(`    Search button: ${searchButtonSelector}`);

      // 2가지 포맷만: last4 (뒷자리 4자리), original (원본)
      const carNumFormats = [
        { name: 'last4', value: input.carNum.replace(/[^0-9]/g, '').slice(-4) },
        { name: 'original', value: input.carNum },
      ];

      for (const { name: formatName, value: carNum } of carNumFormats) {
        console.log(`\n    [${formatName}] Trying: ${carNum}`);

        try {
          // 검색 실행
          await page.waitForSelector(inputSelector, { timeout: 5000 });
          await page.fill(inputSelector, '');
          await page.fill(inputSelector, carNum);
          console.log(`    ✓ Entered`);

          await page.waitForSelector(searchButtonSelector, { timeout: 5000 });
          await page.click(searchButtonSelector);
          console.log(`    ✓ Search clicked`);

          await page.waitForTimeout(3000);
          await page.screenshot({ path: `debug-search-${formatName}-${Date.now()}.png`, fullPage: true });

          // 검색 결과 분석
          console.log(`    Analyzing...`);
          const searchHtml = await page.content();

          const searchResultPrompt = `You are analyzing a vehicle search result page.
Searched for: ${carNum}

Determine:
1. searchSuccess: false if INPUT FORMAT error (숫자만, 4자리, 형식오류), true otherwise
2. vehicleFound: true if vehicle in results, false if "입차 내역 없음"
3. If vehicle found, find discount button selector

Respond ONLY JSON:
{
  "searchSuccess": true/false,
  "formatError": "error message or null",
  "vehicleFound": true/false,
  "vehicleInfo": "vehicle info or null",
  "noVehicleMessage": "no-result message or null",
  "elements": {
    "discountAction": { "applyButtonSelector": "...", "confirmSelector": "..." } | null
  }
}`;

          const searchResponse = await llmInvokeWithRetry(llm, [
            new SystemMessage(searchResultPrompt),
            new HumanMessage(`HTML:\n${sanitizeHtml(searchHtml)}`),
          ]);

          const searchAnalysis = parseAnalysisJson<{
            searchSuccess: boolean;
            formatError: string | null;
            vehicleFound: boolean;
            vehicleInfo: string | null;
            noVehicleMessage: string | null;
            elements: { discountAction: { applyButtonSelector: string; confirmSelector?: string } | null };
          }>(searchResponse);

          // 포맷 에러 → 다음 포맷 시도
          if (!searchAnalysis?.searchSuccess) {
            console.log(`    ❌ Format error: ${searchAnalysis?.formatError}`);
            continue;
          }

          // 포맷 성공
          console.log(`    ✓ Format accepted`);

          if (searchAnalysis.vehicleFound) {
            console.log(`    ✓ Vehicle FOUND: ${searchAnalysis.vehicleInfo || carNum}`);
          } else {
            console.log(`    ⚠️ Vehicle NOT in parking: ${searchAnalysis.noVehicleMessage || ''}`);
          }

          searchResult = {
            carNumUsed: carNum,
            carNumFormat: formatName,
            searchSuccess: true,
            vehicleFound: searchAnalysis.vehicleFound,
            vehicleInfo: searchAnalysis.vehicleInfo,
            noVehicleMessage: searchAnalysis.noVehicleMessage,
            analysis: searchResponse,
          };

          // Step 7: 할인 적용
          if (searchAnalysis.vehicleFound && searchAnalysis.elements?.discountAction) {
            console.log(`\n  Step 7: Applying discount...`);
            const { applyButtonSelector, confirmSelector } = searchAnalysis.elements.discountAction;

            try {
              await page.waitForSelector(applyButtonSelector, { timeout: 5000 });
              await page.click(applyButtonSelector);
              console.log(`    ✓ Discount clicked`);

              if (confirmSelector) {
                try {
                  await page.waitForSelector(confirmSelector, { timeout: 3000 });
                  await page.click(confirmSelector);
                  console.log(`    ✓ Confirmed`);
                } catch { /* no confirm dialog */ }
              }

              await page.waitForTimeout(2000);
              await page.screenshot({ path: `debug-discount-${Date.now()}.png`, fullPage: true });
              console.log(`    ✓ Discount applied!`);
              searchResult.discountApplied = true;
            } catch (e) {
              console.log(`    ❌ Discount failed: ${(e as Error).message}`);
              searchResult.discountApplied = false;
            }
          }

          break;  // 성공 → 루프 종료

        } catch (e) {
          console.log(`    ❌ Error: ${(e as Error).message}`);
        }
      }

      if (!searchResult) {
        searchResult = { searchSuccess: false, error: 'All formats failed' };
      }
    } else if (loginSuccess) {
      console.log(`  ⚠️ No vehicleSearch selectors found`);
    }

    return {
      agent: 'login',
      success: loginSuccess,
      analysis: authAnalysisText,
      data: {
        loginPageAnalysis: analysisText,
        urlBefore,
        urlAfter,
        urlChanged,
        loginSuccess,
        screenshotPath,
        searchResult,
      },
    };
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    await page.screenshot({ path: `debug-login-error-${Date.now()}.png` });
    return {
      agent: 'login',
      success: false,
      error: (error as Error).message,
    };
  } finally {
    await browser.close();
  }
}

// Combined DOM + Network analysis in ONE browser session
async function runDomAndNetwork(input: MockInput, llm: BaseChatModel): Promise<AgentResult[]> {
  console.log(`\n[DOM + Network] Combined analysis: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Network capture
  const requests: {
    phase: string;
    method: string;
    url: string;
    postData?: string;
    status?: number;
    responseBody?: string;
  }[] = [];

  let currentPhase = 'init';

  page.on('request', (req) => {
    const url = req.url();
    if (url.match(/\.(png|jpg|jpeg|gif|svg|css|woff|woff2|ttf|ico|js)$/i)) return;
    requests.push({
      phase: currentPhase,
      method: req.method(),
      url: url,
      postData: req.postData()
        ?.replace(/password[^&"]*/gi, 'password=***')
        ?.replace(/pwd[^&"]*/gi, 'pwd=***'),
    });
  });

  page.on('response', async (res) => {
    const req = requests.find((r) => r.url === res.url() && !r.status);
    if (req) {
      req.status = res.status();
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const body = await res.text();
          req.responseBody = body
            .replace(/"(token|session|cookie|password|pwd|access_token)":\s*"[^"]*"/gi, '"$1":"***"')
            .slice(0, 2000);
        }
      } catch { /* ignore */ }
    }
  });

  // DOM analysis results
  const domResults: { phase: string; pageType: string; elements: any; analysis: string }[] = [];

  try {
    // ========== Phase 1: Login Page ==========
    currentPhase = 'login_page';
    console.log(`\n  [Phase 1] Loading login page...`);
    await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // DOM Analysis: Login page
    const loginHtml = sanitizeHtml(await page.content());
    const loginTitle = await page.title();
    console.log(`    Page: ${loginTitle}`);

    const loginFormPrompt = `Analyze this login page. Find form selectors. Respond ONLY JSON:
{
  "pageType": "login|dashboard|search|error|unknown",
  "elements": {
    "loginForm": { "usernameSelector": "...", "passwordSelector": "...", "submitSelector": "..." } | null
  },
  "issues": []
}`;

    const loginDomResponse = await llmInvokeWithRetry(llm, [
      new SystemMessage(loginFormPrompt),
      new HumanMessage(`URL: ${input.url}\nTitle: ${loginTitle}\n\nHTML:\n${loginHtml}`),
    ]);

    const loginDomAnalysis = parseAnalysisJson<{
      pageType: string;
      elements: { loginForm: { usernameSelector: string; passwordSelector: string; submitSelector: string } | null };
    }>(loginDomResponse);

    domResults.push({ phase: 'login_page', pageType: loginDomAnalysis?.pageType || 'unknown', elements: loginDomAnalysis?.elements, analysis: loginDomResponse });
    console.log(`    DOM: ${loginDomAnalysis?.pageType || 'unknown'}`);

    // ========== Phase 2: Login Submit ==========
    currentPhase = 'login_submit';
    console.log(`\n  [Phase 2] Logging in...`);

    let loginSuccess = false;
    const urlBeforeLogin = page.url();

    if (loginDomAnalysis?.elements?.loginForm) {
      const { usernameSelector, passwordSelector, submitSelector } = loginDomAnalysis.elements.loginForm;

      await page.fill(usernameSelector, input.id);
      await page.fill(passwordSelector, input.pwd);
      await page.click(submitSelector);
      await page.waitForTimeout(3000);
      console.log(`    ✓ Login submitted`);

      // Check login success with LLM (or selector if provided)
      if (input.loginSuccessSelector) {
        // Fast path: use provided selector
        try {
          await page.waitForSelector(input.loginSuccessSelector, { timeout: 5000 });
          loginSuccess = true;
          console.log(`    ✓ Login successful (selector matched)`);
        } catch {
          console.log(`    ❌ Login failed (selector not found)`);
        }
      } else {
        // LLM-based detection
        console.log(`    Analyzing login result...`);
        const detection = await detectLoginSuccess(page, llm, urlBeforeLogin);
        loginSuccess = detection.success;
        console.log(`    ${loginSuccess ? '✓' : '❌'} Login ${loginSuccess ? 'successful' : 'failed'}: ${detection.reason}`);
        domResults.push({ phase: 'login_result', pageType: detection.pageType, elements: null, analysis: detection.reason });
      }
    } else {
      console.log(`    ⚠️ Login form not found`);
    }

    // ========== Phase 3: Search ==========
    if (loginSuccess) {
      currentPhase = 'search';
      console.log(`\n  [Phase 3] Searching vehicle...`);

      // DOM Analysis: Search page
      const searchHtml = sanitizeHtml(await page.content());
      const searchFormPrompt = `Find vehicle search form. Respond ONLY JSON:
{ "pageType": "dashboard|search", "elements": { "vehicleSearch": { "inputSelector": "...", "searchButtonSelector": "..." } | null } }`;

      const searchDomResponse = await llmInvokeWithRetry(llm, [
        new SystemMessage(searchFormPrompt),
        new HumanMessage(searchHtml),
      ]);

      const searchDomAnalysis = parseAnalysisJson<{
        pageType: string;
        elements: { vehicleSearch: { inputSelector: string; searchButtonSelector: string } | null };
      }>(searchDomResponse);

      domResults.push({ phase: 'search_page', pageType: searchDomAnalysis?.pageType || 'unknown', elements: searchDomAnalysis?.elements, analysis: searchDomResponse });
      console.log(`    DOM: vehicleSearch ${searchDomAnalysis?.elements?.vehicleSearch ? '✓' : '✗'}`);

      if (searchDomAnalysis?.elements?.vehicleSearch) {
        const { inputSelector, searchButtonSelector } = searchDomAnalysis.elements.vehicleSearch;
        const carNum = input.carNum.replace(/[^0-9]/g, '').slice(-4);

        await page.fill(inputSelector, carNum);
        await page.click(searchButtonSelector);
        await page.waitForTimeout(3000);
        console.log(`    ✓ Search: ${carNum}`);

        // ========== Phase 4: Discount ==========
        currentPhase = 'discount';
        console.log(`\n  [Phase 4] Checking discount...`);

        const resultHtml = sanitizeHtml(await page.content());
        const discountPrompt = `Analyze search result. Find discount button if vehicle found. Respond ONLY JSON:
{ "vehicleFound": true/false, "discountButton": "selector or null", "vehicleInfo": "..." }`;

        const discountResponse = await llmInvokeWithRetry(llm, [
          new SystemMessage(discountPrompt),
          new HumanMessage(resultHtml),
        ]);

        const discountAnalysis = parseAnalysisJson<{ vehicleFound: boolean; discountButton: string | null; vehicleInfo?: string }>(discountResponse);
        domResults.push({ phase: 'search_result', pageType: discountAnalysis?.vehicleFound ? 'vehicle_found' : 'no_vehicle', elements: discountAnalysis, analysis: discountResponse });

        if (discountAnalysis?.vehicleFound) {
          console.log(`    ✓ Vehicle found: ${discountAnalysis.vehicleInfo || ''}`);

          if (discountAnalysis.discountButton) {
            try {
              await page.click(discountAnalysis.discountButton);
              await page.waitForTimeout(3000);
              console.log(`    ✓ Discount applied`);
            } catch (e) {
              console.log(`    ⚠️ Discount click failed`);
            }
          }
        } else {
          console.log(`    ⚠️ Vehicle not found`);
        }
      }
    }

    // ========== Analysis Complete ==========
    currentPhase = 'done';
    console.log(`\n  [Complete] Captured ${requests.length} API requests`);

    // Group network by phase/domain
    const byPhase: Record<string, typeof requests> = {};
    const byDomain: Record<string, typeof requests> = {};

    for (const req of requests) {
      if (!byPhase[req.phase]) byPhase[req.phase] = [];
      byPhase[req.phase].push(req);

      const domain = new URL(req.url).origin;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(req);
    }

    // Network LLM Analysis
    console.log(`\n  Analyzing API patterns...`);
    const networkSystemPrompt = `Analyze API traffic. Web and API domains may differ.
Respond ONLY JSON:
{
  "webDomain": "...",
  "apiDomain": "... (if different)",
  "endpoints": {
    "auth": { "fullUrl": "...", "method": "...", "requestFields": [...], "responseFields": [...] } | null,
    "search": { "fullUrl": "...", "method": "...", "params": [...] } | null,
    "discount": { "fullUrl": "...", "method": "...", "params": [...] } | null
  },
  "observations": [...]
}`;

    const trafficSummary = Object.entries(byPhase).map(([phase, reqs]) => ({
      phase,
      requests: reqs.map(r => ({
        method: r.method,
        fullUrl: r.url,
        status: r.status,
        body: r.postData?.slice(0, 500),
        response: r.responseBody?.slice(0, 500),
      })),
    }));

    const networkResponse = await llmInvokeWithRetry(llm, [
      new SystemMessage(networkSystemPrompt),
      new HumanMessage(`API Traffic:\n${JSON.stringify(trafficSummary, null, 2)}`),
    ]);

    // Save combined results
    const outputFile = `combined-analysis-${Date.now()}.json`;
    const { writeFileSync } = await import('fs');
    writeFileSync(outputFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      systemCode: input.systemCode,
      dom: {
        phases: domResults,
      },
      network: {
        totalRequests: requests.length,
        byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.length])),
        byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, v.length])),
        analysis: parseAnalysisJson(networkResponse) || networkResponse,
        rawTraffic: trafficSummary,
      },
    }, null, 2));
    console.log(`  📄 Saved: ${outputFile}`);

    return [
      {
        agent: 'dom',
        success: loginSuccess,
        analysis: JSON.stringify(domResults, null, 2),
        data: { phases: domResults.map(d => d.phase) },
      },
      {
        agent: 'network',
        success: true,
        analysis: networkResponse,
        data: { totalRequests: requests.length, byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.length])), outputFile },
      },
    ];
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    return [
      { agent: 'dom', success: false, error: (error as Error).message },
      { agent: 'network', success: false, error: (error as Error).message },
    ];
  } finally {
    await browser.close();
  }
}

// LoginAgent command - uses MCP-based login with spec capture
async function runLoginAgentCommand(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[Login Agent] Starting for: ${input.url}`);

  const credManager = new CredentialManager();
  credManager.set(input.systemCode, { username: input.id, password: input.pwd });

  const specStore = new SpecStore();

  const agent = new LoginAgent({
    systemCode: input.systemCode,
    url: input.url,
    credentialManager: credManager,
    specStore,
    llm,
  });

  const { result, spec } = await agent.run();

  console.log('\n  [Result]');
  console.log(`    Status: ${result.status}`);
  console.log(`    Confidence: ${result.confidence}`);
  if (result.changes?.hasChanges) {
    console.log(`    ⚠️ Changes detected:`);
    result.changes.formChanges?.forEach(c => console.log(`      - ${c}`));
    result.changes.apiChanges?.forEach(c => console.log(`      - ${c}`));
  }

  return {
    agent: 'login',
    success: result.status === 'SUCCESS',
    analysis: JSON.stringify({ result, spec }, null, 2),
    data: { result, spec },
  };
}

// Run agents in parallel
async function runAllAgents(input: MockInput, llm: BaseChatModel): Promise<AgentResult[]> {
  console.log(`\n[Parallel Execution] Running all agents...`);

  const results = await Promise.all([
    runDomAgent(input, llm),
    runNetworkAgent(input, llm),
    runPolicyAgent(input, llm),
  ]);

  return results;
}

// ============================================================
// MCP-based Autonomous Agent (LLM controls Playwright directly)
// ============================================================

async function runDomMcpAgent(input: MockInput, llm: BaseChatModel): Promise<AgentResult> {
  console.log(`\n[DOM-MCP Agent] Autonomous mode: ${input.url}`);
  console.log(`  Starting Playwright MCP server...`);

  // Start Playwright MCP server
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['@playwright/mcp@latest', '--headless'],
  });

  const mcpClient = new Client({
    name: 'web-analysis-agent',
    version: '1.0.0',
  });

  try {
    await mcpClient.connect(transport);
    console.log(`  ✓ MCP server connected`);

    // Get available tools from MCP server
    const { tools: mcpTools } = await mcpClient.listTools();
    console.log(`  Available tools: ${mcpTools.map(t => t.name).join(', ')}`);

    // Filter to essential tools with parameters (Gemini requires non-empty schema)
    const essentialTools = [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_fill_form',
      'browser_press_key',
      'browser_take_screenshot',
      'browser_select_option',
      'browser_wait_for',
    ];

    const filteredMcpTools = mcpTools.filter(t => {
      const inputSchema = t.inputSchema as any;
      const hasParams = inputSchema?.properties && Object.keys(inputSchema.properties).length > 0;
      // Keep tools with parameters OR essential tools
      return hasParams || essentialTools.includes(t.name);
    });

    console.log(`  Filtered to ${filteredMcpTools.length} tools with parameters`);

    // Convert MCP tools to LangChain tools
    const langchainTools = filteredMcpTools.map(mcpTool => {
      // Build Zod schema from MCP tool input schema
      const inputSchema = mcpTool.inputSchema as any;
      let zodSchema: z.ZodObject<any>;

      if (inputSchema?.properties && Object.keys(inputSchema.properties).length > 0) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, value] of Object.entries(inputSchema.properties)) {
          const prop = value as any;
          if (prop.type === 'string') {
            shape[key] = inputSchema.required?.includes(key)
              ? z.string().describe(prop.description || key)
              : z.string().optional().describe(prop.description || key);
          } else if (prop.type === 'number' || prop.type === 'integer') {
            shape[key] = inputSchema.required?.includes(key)
              ? z.number().describe(prop.description || key)
              : z.number().optional().describe(prop.description || key);
          } else if (prop.type === 'boolean') {
            shape[key] = inputSchema.required?.includes(key)
              ? z.boolean().describe(prop.description || key)
              : z.boolean().optional().describe(prop.description || key);
          } else {
            shape[key] = z.any().describe(prop.description || key);
          }
        }
        zodSchema = z.object(shape);
      } else {
        // For tools without parameters, add a dummy parameter for Gemini compatibility
        zodSchema = z.object({
          _unused: z.string().optional().describe('Unused parameter for API compatibility'),
        });
      }

      return tool(
        async (params) => {
          try {
            console.log(`      [MCP] ${mcpTool.name}(${JSON.stringify(params).slice(0, 100)}...)`);
            const result = await mcpClient.callTool({
              name: mcpTool.name,
              arguments: params,
            });
            const content = result.content as any[];
            const text = content?.map(c => c.text || c.data || '').join('\n') || 'Done';
            // Truncate large responses
            return text.length > 5000 ? text.slice(0, 5000) + '\n...(truncated)' : text;
          } catch (e) {
            return `Error: ${(e as Error).message}`;
          }
        },
        {
          name: mcpTool.name,
          description: mcpTool.description || mcpTool.name,
          schema: zodSchema,
        }
      );
    });

    console.log(`  ✓ ${langchainTools.length} tools ready`);

    // Create the autonomous agent prompt
    const systemPrompt = `You are a web automation agent. Your goal is to complete the following task:

**TASK:**
1. Navigate to: ${input.url}
2. Log in with ID: "${input.id}" (password will be provided separately)
3. Search for vehicle: "${input.carNum}" (try last 4 digits first: "${input.carNum.replace(/[^0-9]/g, '').slice(-4)}")
4. Apply discount if the vehicle is found

**RULES:**
- Use browser_snapshot to understand the current page state
- The password is: "${input.pwd}" - use it directly in browser_type, NEVER output it in your response
- After each action, take a snapshot to verify the result
- If you encounter unexpected popups or errors, handle them appropriately
- When login is successful, you should see a search form or dashboard
- Report SUCCESS when discount is applied, or explain why it couldn't be completed

**AVAILABLE ACTIONS:**
- browser_navigate: Go to a URL
- browser_snapshot: Get current page state (accessibility tree)
- browser_click: Click an element (use element reference from snapshot)
- browser_type: Type text into focused element
- browser_press_key: Press a key (Enter, Tab, etc.)

Start by navigating to the URL and taking a snapshot.`;

    // Manual ReAct loop (simpler than createReactAgent for debugging)
    const messages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage('Start the task. Navigate to the login page and take a snapshot.'),
    ];

    const MAX_ITERATIONS = 20;
    let iteration = 0;
    let finalResult = '';

    console.log(`\n  [Agent Loop] Starting autonomous execution...`);

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`\n  --- Iteration ${iteration}/${MAX_ITERATIONS} ---`);

      // Call LLM with tools
      const llmWithTools = llm.bindTools(langchainTools);
      const response = await llmWithTools.invoke(messages);

      messages.push(response);

      // Check if LLM wants to use tools
      const toolCalls = response.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls - LLM is done or giving final answer
        finalResult = response.content as string;
        console.log(`\n  [Agent] Final response: ${finalResult.slice(0, 200)}...`);
        break;
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolArgs = toolCall.args;

        console.log(`    → ${toolName}`);

        // Find and execute the tool
        const langchainTool = langchainTools.find(t => t.name === toolName);
        if (!langchainTool) {
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: `Error: Tool "${toolName}" not found`,
          }));
          continue;
        }

        try {
          const result = await langchainTool.invoke(toolArgs);
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: result,
          }));

          // Show truncated result
          const resultStr = String(result);
          if (resultStr.length > 200) {
            console.log(`      ← ${resultStr.slice(0, 200)}...`);
          } else {
            console.log(`      ← ${resultStr}`);
          }
        } catch (e) {
          messages.push(new ToolMessage({
            tool_call_id: toolCall.id!,
            content: `Error: ${(e as Error).message}`,
          }));
          console.log(`      ← Error: ${(e as Error).message}`);
        }
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      finalResult = 'Max iterations reached. Task incomplete.';
    }

    // Determine success from final result
    const success = finalResult.toLowerCase().includes('success') ||
                    finalResult.toLowerCase().includes('완료') ||
                    finalResult.toLowerCase().includes('applied');

    return {
      agent: 'dom-mcp',
      success,
      analysis: finalResult,
      data: {
        iterations: iteration,
        totalMessages: messages.length,
      },
    };
  } catch (error) {
    console.log(`  Error: ${(error as Error).message}`);
    return {
      agent: 'dom-mcp',
      success: false,
      error: (error as Error).message,
    };
  } finally {
    try {
      await mcpClient.close();
      console.log(`\n  MCP server closed`);
    } catch { /* ignore */ }
  }
}

// Main CLI
async function main() {
  const args = process.argv.slice(2);
  const agentArg = args[0] || 'all';
  const inputPath = args[1] || 'mock-input.json';

  console.log('='.repeat(60));
  console.log('Web Analysis Agent CLI (with LLM)');
  console.log('='.repeat(60));

  // Check API key
  const hasInternalAI = process.env.INTERNAL_AI_URL && process.env.INTERNAL_AI_KEY;
  const hasAnyKey = hasInternalAI || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!hasAnyKey) {
    console.error('\n❌ No API key found');
    console.error('   Create .env file with one of:');
    console.error('   INTERNAL_AI_URL=... + INTERNAL_AI_KEY=...');
    console.error('   GOOGLE_API_KEY=...');
    console.error('   OPENAI_API_KEY=sk-...');
    console.error('   ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const input = loadInput(inputPath);
  console.log(`\nInput: ${inputPath}`);
  console.log(`  systemCode: ${input.systemCode}`);
  console.log(`  url: ${input.url}`);
  console.log(`  carNum: ${input.carNum}`);
  console.log(`  credentials: ${input.id ? '✓' : '✗'}`);

  const llm = createLLM();
  let results: AgentResult[] = [];

  if (agentArg === 'all') {
    results = await runAllAgents(input, llm);
  } else if (agentArg === 'both') {
    // Combined DOM + Network in ONE browser session (most efficient)
    results = await runDomAndNetwork(input, llm);
  } else if (agentArg === 'dom') {
    // dom = full flow: login → search → discount (legacy)
    results.push(await runLoginFlow(input, llm));
  } else if (agentArg === 'login') {
    // login = MCP-based LoginAgent with spec capture
    results.push(await runLoginAgentCommand(input, llm));
  } else if (agentArg === 'network') {
    results.push(await runNetworkAgent(input, llm));
  } else if (agentArg === 'policy') {
    results.push(await runPolicyAgent(input, llm));
  } else if (agentArg === 'dom-mcp') {
    results.push(await runDomMcpAgent(input, llm));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`\n${status} [${r.agent.toUpperCase()}]`);

    if (r.error) {
      console.log(`   Error: ${r.error}`);
    }

    if (r.analysis) {
      console.log(`   Analysis:`);
      console.log(r.analysis);
    }
  }
}

main().catch(console.error);
