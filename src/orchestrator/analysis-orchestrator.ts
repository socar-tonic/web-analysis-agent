// src/orchestrator/analysis-orchestrator.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LoginGraph } from '../agents/login-graph/index.js';
import { SearchGraph } from '../agents/search-graph/index.js';
import { PRGraph } from '../agents/pr-graph/index.js';
import { SlackDispatcher } from '../dispatcher/slack-dispatcher.js';
import { SpecStore } from '../specs/spec-store.js';
import { CredentialManager } from '../security/credential-manager.js';

export interface AnalysisInput {
  systemCode: string;
  url: string;
  username: string;
  password: string;
  carNum: string;
}

export interface AnalysisResult {
  action: 'completed' | 'pr_created' | 'notified';
  prUrl?: string;
  error?: string;
}

export class AnalysisOrchestrator {
  private llm: BaseChatModel;
  private slack: SlackDispatcher;
  private specStore: SpecStore;
  private credManager: CredentialManager;

  constructor(config: {
    llm: BaseChatModel;
    slackWebhookUrl: string;
  }) {
    this.llm = config.llm;
    this.slack = new SlackDispatcher(config.slackWebhookUrl);
    this.specStore = new SpecStore();
    this.credManager = new CredentialManager();
  }

  async run(input: AnalysisInput): Promise<AnalysisResult> {
    const { systemCode } = input;

    // Credential 설정
    this.credManager.set(systemCode, { username: input.username, password: input.password });

    console.log(`[Orchestrator] Starting analysis for ${systemCode}`);

    // Playwright MCP 클라이언트 생성
    const playwrightTransport = new StdioClientTransport({
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless'],
    });
    const playwrightMcp = new Client({ name: 'orchestrator-playwright', version: '1.0.0' });
    await playwrightMcp.connect(playwrightTransport);

    try {
      // 1. LoginGraph 실행
      console.log(`[Orchestrator] Phase 1: Login`);
      const loginGraph = new LoginGraph({
        systemCode,
        url: input.url,
        credentialManager: this.credManager,
        specStore: this.specStore,
        llm: this.llm,
        mcpClient: playwrightMcp,
      });

      const loginResult = await loginGraph.run();

      // 접속 실패
      if (loginResult.result.status === 'CONNECTION_ERROR') {
        await this.slack.notify({
          type: 'SERVER_DOWN',
          systemCode,
          message: loginResult.result.details?.errorMessage,
        });
        return { action: 'notified' };
      }

      // 로그인 시그니처 변경
      if (loginResult.result.changes?.hasChanges && loginResult.result.changes?.codeWillBreak) {
        return await this.handleSignatureChange(systemCode, loginResult.result.changes);
      }

      // 로그인 실패 (credentials 문제 등)
      if (loginResult.result.status !== 'SUCCESS') {
        await this.slack.notify({
          type: 'SIGNATURE_CHANGED',
          systemCode,
          changes: [loginResult.result.details?.errorMessage || 'Login failed'],
        });
        return { action: 'notified' };
      }

      // 2. SearchGraph 실행
      console.log(`[Orchestrator] Phase 2: Search`);
      const searchGraph = new SearchGraph({
        systemCode,
        url: input.url,
        carNum: input.carNum,
        session: loginResult.result.session!,
        specStore: this.specStore,
        llm: this.llm,
        mcpClient: playwrightMcp,
      });

      const searchResult = await searchGraph.run();

      // 검색 시그니처 변경
      if (searchResult.result.changes?.hasChanges && searchResult.result.changes?.codeWillBreak) {
        return await this.handleSignatureChange(
          systemCode,
          searchResult.result.changes,
          (searchResult as any).specChanges?.capturedApiSchema
        );
      }

      // 분석 완료
      await this.slack.notify({
        type: 'ANALYSIS_COMPLETE',
        systemCode,
        message: `검색 결과: ${searchResult.result.status}`,
      });

      return { action: 'completed' };

    } finally {
      await playwrightMcp.close();
    }
  }

  private async handleSignatureChange(
    systemCode: string,
    changes: { changeType?: 'dom' | 'api' | 'both' | null; changes?: string[]; codeWillBreak?: boolean; breakingChanges?: string[] },
    capturedApiSchema?: any
  ): Promise<AnalysisResult> {
    console.log(`[Orchestrator] Signature change detected, attempting PR creation`);

    // GitHub MCP 클라이언트 생성
    const githubTransport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
      },
    });
    const githubMcp = new Client({ name: 'orchestrator-github', version: '1.0.0' });

    try {
      await githubMcp.connect(githubTransport);

      const changeList = changes.breakingChanges || changes.changes || [];
      const prGraph = new PRGraph({
        systemCode,
        changeType: (changes.changeType as 'dom' | 'api') || 'api',
        changes: changeList,
        capturedApiSchema,
        mcpClient: githubMcp,
        llm: this.llm,
      });

      const prResult = await prGraph.run();

      if (prResult.status === 'success' && prResult.prUrl) {
        await this.slack.notify({
          type: 'PR_CREATED',
          systemCode,
          prUrl: prResult.prUrl,
          prNumber: prResult.prNumber,
          changes: changeList,
        });
        return { action: 'pr_created', prUrl: prResult.prUrl };
      } else {
        // PR 생성 실패 → Slack으로 변경 정보만 알림
        await this.slack.notify({
          type: 'SIGNATURE_CHANGED',
          systemCode,
          changes: changeList,
          error: prResult.errorMessage,
        });
        return { action: 'notified', error: prResult.errorMessage };
      }
    } finally {
      await githubMcp.close();
    }
  }
}
