import 'dotenv/config';
import { readFileSync } from 'fs';
import { chromium, Browser, Page } from 'playwright';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Input schema
interface MockInput {
  systemCode: string;
  url: string;
  id: string;
  pwd: string;
  discountId: string;
  carNum: string;
}

interface AgentResult {
  agent: string;
  success: boolean;
  analysis?: string;
  data?: any;
  error?: string;
}

// Load mock input
function loadInput(path: string): MockInput {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

// Initialize LLM
function createLLM() {
  return new ChatAnthropic({
    model: 'claude-sonnet-4-20250514',
    temperature: 0,
    maxTokens: 4096,
  });
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
async function runDomAgent(input: MockInput, llm: ChatAnthropic): Promise<AgentResult> {
  console.log(`\n[DOM Agent] Analyzing: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(input.url, { timeout: 30000 });

    // Capture page content
    const title = await page.title();
    const html = await page.content();
    const sanitizedHtml = sanitizeHtml(html);

    console.log(`  Page loaded: ${title}`);
    console.log(`  HTML size: ${html.length} -> ${sanitizedHtml.length} (sanitized)`);

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

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this HTML page:

URL: ${input.url}
Title: ${title}
SystemCode: ${input.systemCode}

HTML Content:
${sanitizedHtml}`),
    ]);

    const analysis = response.content as string;
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

// Network Agent - captures and analyzes API calls with LLM
async function runNetworkAgent(input: MockInput, llm: ChatAnthropic): Promise<AgentResult> {
  console.log(`\n[Network Agent] Analyzing: ${input.url}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const requests: {
    method: string;
    url: string;
    postData?: string;
    status?: number;
    responseBody?: string;
  }[] = [];

  // Capture requests (exclude sensitive headers)
  page.on('request', (req) => {
    const url = req.url();
    // Skip static resources
    if (url.match(/\.(png|jpg|jpeg|gif|svg|css|woff|woff2|ttf|ico)$/i)) return;

    requests.push({
      method: req.method(),
      url: url,
      postData: req.postData()?.replace(/password[^&]*/gi, 'password=***'),
    });
  });

  page.on('response', async (res) => {
    const req = requests.find((r) => r.url === res.url());
    if (req) {
      req.status = res.status();
      try {
        const contentType = res.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          const body = await res.text();
          // Sanitize sensitive data from response
          req.responseBody = body
            .replace(/"(token|session|cookie|password|pwd)":\s*"[^"]*"/gi, '"$1":"***"')
            .slice(0, 5000);
        }
      } catch {
        // Ignore response body errors
      }
    }
  });

  try {
    await page.goto(input.url, { timeout: 30000 });
    await page.waitForTimeout(3000); // Wait for async requests

    console.log(`  Captured ${requests.length} requests`);

    // LLM Analysis
    console.log(`  Analyzing with LLM...`);

    const systemPrompt = `You are a network traffic analyzer for a parking discount automation system.
Your job is to analyze HTTP requests/responses and identify API patterns.

IMPORTANT: Never include or reference any passwords, tokens, session IDs, or sensitive credentials in your response.

Analyze the network traffic and identify:
1. API endpoints for authentication (login)
2. API endpoints for vehicle search
3. API endpoints for discount application
4. Request/response formats and required parameters

Respond in JSON format:
{
  "apiType": "rest|graphql|soap|unknown",
  "endpoints": {
    "auth": { "url": "...", "method": "...", "params": [...] } | null,
    "vehicleSearch": { "url": "...", "method": "...", "params": [...] } | null,
    "discountApply": { "url": "...", "method": "...", "params": [...] } | null
  },
  "issues": ["list of potential API changes or issues"],
  "confidence": 0.0-1.0
}`;

    const requestSummary = requests.slice(0, 20).map((r) => ({
      method: r.method,
      url: r.url,
      status: r.status,
      hasBody: !!r.postData,
      responsePreview: r.responseBody?.slice(0, 500),
    }));

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this network traffic:

URL: ${input.url}
SystemCode: ${input.systemCode}

Captured Requests (${requests.length} total, showing first 20):
${JSON.stringify(requestSummary, null, 2)}`),
    ]);

    const analysis = response.content as string;
    console.log(`  Analysis complete`);

    return {
      agent: 'network',
      success: true,
      analysis,
      data: { requestCount: requests.length },
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
async function runPolicyAgent(input: MockInput, llm: ChatAnthropic): Promise<AgentResult> {
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
    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Validate this configuration:

SystemCode: ${input.systemCode}
URL: ${input.url}
DiscountId: ${input.discountId}
CarNum: ${input.carNum}
HasCredentials: ${!!input.id && !!input.pwd}`),
    ]);

    const analysis = response.content as string;
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

// Run agents in parallel
async function runAllAgents(input: MockInput, llm: ChatAnthropic): Promise<AgentResult[]> {
  console.log(`\n[Parallel Execution] Running all agents...`);

  const results = await Promise.all([
    runDomAgent(input, llm),
    runNetworkAgent(input, llm),
    runPolicyAgent(input, llm),
  ]);

  return results;
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set in environment');
    console.error('   Create .env file with: ANTHROPIC_API_KEY=your-key');
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
  } else {
    if (agentArg === 'dom') {
      results.push(await runDomAgent(input, llm));
    }
    if (agentArg === 'network') {
      results.push(await runNetworkAgent(input, llm));
    }
    if (agentArg === 'policy') {
      results.push(await runPolicyAgent(input, llm));
    }
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
