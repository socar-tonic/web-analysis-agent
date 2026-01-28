// src/agents/search-graph/__tests__/state.test.ts
import { describe, it, expect } from 'vitest';
import { SearchGraphState } from '../state.js';

describe('SearchGraphState', () => {
  it('should export SearchGraphState annotation', () => {
    expect(SearchGraphState).toBeDefined();
    // LangGraph Annotation.Root returns an object with spec property
    expect(SearchGraphState.spec).toBeDefined();
  });
});
