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

**EXISTING SPEC (how the code works - DO NOT CHANGE THIS):**
${JSON.stringify(oldSpec, null, 2)}

**CAPTURED FROM LIVE SITE:**
${JSON.stringify(newSpec, null, 2)}

**YOUR TASK:**
Determine if the EXISTING CODE will still work correctly.
- The EXISTING SPEC defines how the current code operates (API endpoints, selectors, success criteria)
- The CAPTURED data shows what the live site actually provides
- Report changes ONLY if they would BREAK the existing code

**IGNORE (not breaking changes):**
- Cosmetic differences (quotes, formatting)
- Selector syntax variations for the SAME element
- Success indicator differences (captured may use URL pattern, but if existing code checks access_token and it's still present, that's fine)
- Additional fields in captured (existing code doesn't use them)

**REPORT (breaking changes):**
- API endpoint/port changed → existing code will call wrong URL
- Required request field name changed → existing code sends wrong field
- Required response field missing → existing code can't parse response
- Form selector broken → existing code can't find element

**RESPONSE (JSON only):**
{
  "hasChanges": true/false,
  "codeWillBreak": true/false,
  "breakingChanges": ["description of what will break", ...] or null,
  "summary": "Brief summary in Korean explaining if code needs update"
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
