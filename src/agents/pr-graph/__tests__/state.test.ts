// src/agents/pr-graph/__tests__/state.test.ts
import { describe, it, expect } from 'vitest';
import { PRGraphState, type PRGraphStateType } from '../state.js';

describe('PRGraphState', () => {
  it('should export PRGraphState annotation', () => {
    expect(PRGraphState).toBeDefined();
    expect(PRGraphState.spec).toBeDefined();
  });

  it('should have correct default values', () => {
    const state: Partial<PRGraphStateType> = {
      systemCode: 'test-vendor',
      changeType: 'api',
      changes: ['API endpoint changed'],
    };
    expect(state.systemCode).toBe('test-vendor');
  });
});
