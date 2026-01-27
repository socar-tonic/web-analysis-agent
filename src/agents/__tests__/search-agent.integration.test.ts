import { describe, it, expect } from 'vitest';
import { SearchAgent } from '../search-agent.js';
import { SpecStore } from '../../specs/index.js';

describe('SearchAgent Integration', () => {
  it.skip('should search with mock session', async () => {
    // This test requires actual browser - skip in CI
    // Run manually: pnpm test search-agent.integration
    const agent = new SearchAgent({
      systemCode: 'test-vendor',
      url: 'https://example.com',
      carNum: '12가3456',
      session: {
        type: 'cookie',
        cookies: ['session=test'],
      },
      specStore: new SpecStore(),
      llm: {} as any, // Mock LLM would be needed
    });

    // Just verify instantiation works
    expect(agent).toBeDefined();
  });
});
