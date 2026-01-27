import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { LoginSpec } from '../schemas/index.js';

export interface SpecChanges {
  hasChanges: boolean;
  codeWillBreak?: boolean;
  breakingChanges?: string[];
  summary?: string;
}

export class SpecStore {
  private basePath: string;

  constructor(basePath: string = './specs') {
    this.basePath = basePath;
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true });
    }
  }

  private getFilePath(systemCode: string): string {
    return join(this.basePath, `${systemCode}.json`);
  }

  save(spec: LoginSpec): void {
    const filePath = this.getFilePath(spec.systemCode);
    writeFileSync(filePath, JSON.stringify(spec, null, 2));
    console.log(`  [SpecStore] Saved: ${filePath}`);
  }

  load(systemCode: string): LoginSpec | null {
    const filePath = this.getFilePath(systemCode);
    if (!existsSync(filePath)) {
      console.log(`  [SpecStore] No existing spec for: ${systemCode}`);
      return null;
    }
    console.log(`  [SpecStore] Loaded: ${filePath}`);
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  has(systemCode: string): boolean {
    return existsSync(this.getFilePath(systemCode));
  }

  async compare(systemCode: string, newSpec: any, llm: BaseChatModel): Promise<SpecChanges> {
    const oldSpec = this.load(systemCode);
    if (!oldSpec) {
      return { hasChanges: false, summary: 'No existing spec to compare' };
    }

    const prompt = `You are validating whether EXISTING CODE will still work against the LIVE SITE.

**EXISTING SPEC (how the code works):**
${JSON.stringify(oldSpec, null, 2)}

**CAPTURED FROM LIVE SITE:**
${JSON.stringify(newSpec, null, 2)}

**YOUR TASK:**
Determine if the EXISTING CODE will FAIL. Be VERY CONSERVATIVE - only report breakage if you are CERTAIN.

**DEFAULT ASSUMPTION: CODE WORKS**
Unless you have CLEAR EVIDENCE the code will fail, assume it works.

**NOT breaking (IGNORE these):**
- Different URL paths that both exist (e.g., /login vs /login.cs - both may work)
- Cosmetic differences (quotes, formatting, extra whitespace)
- Selector syntax variations (CSS vs accessibility selectors for same element)
- Additional fields in captured that existing code doesn't use
- Different success indicators if login succeeded
- Form action URL differences if form submission worked

**ONLY report as breaking if:**
- Existing endpoint returns 404/500 error
- Required field REMOVED (not just renamed/aliased)
- Form element COMPLETELY GONE (not just different selector)
- Authentication method fundamentally changed (e.g., form → OAuth)

**CRITICAL:** If the login/search SUCCEEDED in the captured session, the code is NOT broken.

**RESPONSE (JSON only):**
{
  "hasChanges": false,
  "codeWillBreak": false,
  "breakingChanges": null,
  "summary": "기존 코드 정상 작동"
}`;

    try {
      console.log('  [SpecStore] Comparing specs with LLM...');
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const content = response.content as string;

      // Parse JSON from response
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || [null, content];
      const jsonStr = jsonMatch[1] || content;
      const result = JSON.parse(jsonStr.trim());

      return {
        hasChanges: result.hasChanges || false,
        codeWillBreak: result.codeWillBreak || false,
        breakingChanges: result.breakingChanges || undefined,
        summary: result.summary,
      };
    } catch (e) {
      console.log(`  [SpecStore] LLM compare error: ${(e as Error).message}`);
      return { hasChanges: false, summary: 'Comparison failed' };
    }
  }
}
