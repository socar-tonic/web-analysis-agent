import 'dotenv/config';
import { readFileSync } from 'fs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoginAgent, SearchAgent } from './agents/index.js';
import { CredentialManager } from './security/index.js';
import { SpecStore } from './specs/index.js';
import { createLLMForAgent } from './llm/index.js';

// ============================================================
// Types
// ============================================================

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

interface SessionInfo {
  type?: 'jwt' | 'cookie' | 'session' | 'mixed';
  accessToken?: string;
  cookies?: string[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

// ============================================================
// Utilities
// ============================================================

function loadInput(path: string): MockInput {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

// ============================================================
// Agent Commands
// ============================================================

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
  console.log(`    로그인 시도: ${result.status} (confidence: ${result.confidence})`);

  // CONNECTION_ERROR 처리 - 접속 실패 시 조기 반환
  if (result.status === 'CONNECTION_ERROR') {
    console.log(`    [ALERT] 접속 실패: ${result.details.errorMessage}`);
    console.log(`      신뢰도: ${(result.confidence * 100).toFixed(0)}%`);
    return {
      agent: 'login',
      success: false,
      analysis: JSON.stringify({ result, spec }, null, 2),
      data: { result, spec },
    };
  }

  // 핵심 지표: 기존 코드 호환성
  const codeCompatible = !result.changes?.codeWillBreak;

  if (result.changes?.codeWillBreak) {
    console.log(`    [ALERT] 코드 호환성: 실패 - 수정 필요`);
    if (result.changes.summary) {
      console.log(`      ${result.changes.summary}`);
    }
    result.changes.breakingChanges?.forEach(c => console.log(`      - ${c}`));
  } else if (result.changes?.hasChanges) {
    console.log(`    [OK] 코드 호환성: 성공 (비-파괴적 변경 감지)`);
    if (result.changes.summary) {
      console.log(`      ${result.changes.summary}`);
    }
  } else {
    console.log(`    [OK] 코드 호환성: 성공 - 변경 없음`);
    if (result.changes?.summary) {
      console.log(`      ${result.changes.summary}`);
    }
  }

  return {
    agent: 'login',
    success: codeCompatible,
    analysis: JSON.stringify({ result, spec }, null, 2),
    data: { result, spec },
  };
}

async function runSearchAgentCommand(
  input: MockInput,
  session: SessionInfo,
  llm: BaseChatModel
): Promise<AgentResult> {
  console.log(`\n[Search Agent] Starting for: ${input.url}`);

  const specStore = new SpecStore();

  const agent = new SearchAgent({
    systemCode: input.systemCode,
    url: input.url,
    carNum: input.carNum,
    session,
    specStore,
    llm,
  });

  const { result, spec } = await agent.run();

  console.log('\n  [Result]');
  console.log(`    검색 결과: ${result.status} (confidence: ${result.confidence})`);

  if (result.details.vehicleFound && result.vehicle) {
    console.log(`    [OK] 차량 발견: ${result.vehicle.plateNumber}`);
    console.log(`      입차 시간: ${result.vehicle.inTime}`);
  } else if (result.status === 'NOT_FOUND') {
    console.log(`    [INFO] 차량 없음 (정상 응답)`);
  } else {
    console.log(`    [FAIL] 검색 실패: ${result.details.errorMessage || result.status}`);
  }

  const codeCompatible = !result.changes?.codeWillBreak;

  if (result.changes?.codeWillBreak) {
    console.log(`    [ALERT] 코드 호환성: 실패 - 수정 필요`);
    result.changes.breakingChanges?.forEach(c => console.log(`      - ${c}`));
  } else {
    console.log(`    [OK] 코드 호환성: 성공`);
  }

  return {
    agent: 'search',
    success: codeCompatible,
    analysis: JSON.stringify({ result, spec }, null, 2),
    data: { result, spec },
  };
}

// Combined Login -> Search flow with shared MCP client
async function runLoginAndSearchCommand(input: MockInput): Promise<AgentResult[]> {
  console.log(`\n[Login -> Search Flow] Starting with shared browser session...`);

  // Create LLMs for each agent (can be different models)
  const loginLLM = createLLMForAgent('login');
  const searchLLM = createLLMForAgent('search');

  // Create shared MCP client
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['@playwright/mcp@latest', '--headless', '--isolated'],
  });

  const sharedMcp = new Client({ name: 'shared-session', version: '1.0.0' });

  try {
    await sharedMcp.connect(transport);
    console.log('  [Shared MCP] Connected');

    const credManager = new CredentialManager();
    credManager.set(input.systemCode, { username: input.id, password: input.pwd });
    const specStore = new SpecStore();

    // Step 1: Login (using shared MCP)
    console.log('\n  [Step 1] Running LoginAgent...');
    const loginAgent = new LoginAgent({
      systemCode: input.systemCode,
      url: input.url,
      credentialManager: credManager,
      specStore,
      llm: loginLLM,
      mcpClient: sharedMcp,
      maxIterations: 20,
    });

    const { result: loginResult, spec: loginSpec } = await loginAgent.run();

    console.log(`\n  [Login Result] ${loginResult.status} (confidence: ${loginResult.confidence})`);

    // Check login success
    if (loginResult.status !== 'SUCCESS') {
      console.log('  [Flow] Login failed, skipping search');
      return [{
        agent: 'login',
        success: false,
        analysis: JSON.stringify({ result: loginResult, spec: loginSpec }, null, 2),
        data: { result: loginResult, spec: loginSpec },
      }];
    }

    console.log('  [Flow] Login successful, browser session maintained');

    // Step 2: Search (using same shared MCP - browser already logged in)
    console.log('\n  [Step 2] Running SearchAgent (same browser session)...');
    const searchAgent = new SearchAgent({
      systemCode: input.systemCode,
      url: input.url,
      carNum: input.carNum,
      session: loginResult.session || {},
      specStore,
      llm: searchLLM,
      mcpClient: sharedMcp,
      maxIterations: 20,
    });

    const { result: searchResult, spec: searchSpec } = await searchAgent.run();

    console.log(`\n  [Search Result] ${searchResult.status} (confidence: ${searchResult.confidence})`);

    return [
      {
        agent: 'login',
        success: !loginResult.changes?.codeWillBreak,
        analysis: JSON.stringify({ result: loginResult, spec: loginSpec }, null, 2),
        data: { result: loginResult, spec: loginSpec },
      },
      {
        agent: 'search',
        success: !searchResult.changes?.codeWillBreak,
        analysis: JSON.stringify({ result: searchResult, spec: searchSpec }, null, 2),
        data: { result: searchResult, spec: searchSpec },
      },
    ];
  } finally {
    await sharedMcp.close().catch(() => {});
    console.log('\n  [Shared MCP] Closed');
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const agentArg = args[0] || 'search';
  const inputPath = args[1] || 'mock-input.json';

  console.log('='.repeat(60));
  console.log('Web Analysis Agent CLI');
  console.log('='.repeat(60));

  // Check API key
  const hasInternalAI = process.env.INTERNAL_AI_URL && process.env.INTERNAL_AI_KEY;
  const hasAnyKey = hasInternalAI || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!hasAnyKey) {
    console.error('\n[ERROR] No API key found');
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
  console.log(`  credentials: ${input.id ? 'provided' : 'missing'}`);

  let results: AgentResult[] = [];

  if (agentArg === 'login') {
    const llm = createLLMForAgent('login');
    results.push(await runLoginAgentCommand(input, llm));
  } else if (agentArg === 'search') {
    // Search requires login first - run combined flow
    results = await runLoginAndSearchCommand(input);
  } else {
    console.error(`\n[ERROR] Unknown command: ${agentArg}`);
    console.error('   Available commands: login, search');
    process.exit(1);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  for (const r of results) {
    const status = r.success ? '[OK]' : '[FAIL]';
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
