import { describe, it, expect } from 'vitest';
import { SearchAgent, SearchAgentConfig } from '../search-agent.js';

describe('SearchAgent', () => {
  it('should be instantiable with config', () => {
    const config: SearchAgentConfig = {
      systemCode: 'test-vendor',
      url: 'https://test.com',
      carNum: '12가3456',
      session: {
        type: 'jwt',
        accessToken: 'test-token',
      },
      specStore: { load: () => null, save: () => {}, has: () => false, compare: async () => ({ hasChanges: false }) } as any,
      llm: {} as any,
    };
    const agent = new SearchAgent(config);
    expect(agent).toBeDefined();
  });
});
