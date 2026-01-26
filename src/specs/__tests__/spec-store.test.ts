import { describe, it, expect, vi } from 'vitest';
import { SpecStore } from '../spec-store.js';
import { LoginSpec } from '../../schemas/index.js';

describe('SpecStore', () => {
  const sampleSpec: LoginSpec = {
    systemCode: 'vendor-abc',
    url: 'https://example.com',
    capturedAt: new Date().toISOString(),
    loginType: 'dom',
    form: {
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#submit',
    },
    successIndicators: {
      urlPattern: '/dashboard',
    },
    version: 1,
  };

  it('should save and load spec', () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const loaded = store.load('vendor-abc');
    expect(loaded?.systemCode).toBe('vendor-abc');
  });

  it('should detect changes using LLM (mocked)', async () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const newSpec: LoginSpec = {
      ...sampleSpec,
      form: {
        usernameSelector: '#new-username', // changed
        passwordSelector: '#password',
        submitSelector: '#submit',
      },
    };

    // Mock LLM that returns a change detection result
    const mockLlm = {
      invoke: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          hasChanges: true,
          codeWillBreak: true,
          breakingChanges: ['usernameSelector changed from #username to #new-username'],
          summary: '셀렉터 변경으로 기존 코드가 작동하지 않을 수 있음',
        }),
      }),
    } as any;

    const changes = await store.compare('vendor-abc', newSpec, mockLlm);
    expect(changes.hasChanges).toBe(true);
    expect(changes.codeWillBreak).toBe(true);
    expect(changes.breakingChanges).toContain('usernameSelector changed from #username to #new-username');
  });

  it('should return no changes when no existing spec', async () => {
    const store = new SpecStore();

    const mockLlm = {
      invoke: vi.fn(),
    } as any;

    const changes = await store.compare('nonexistent', sampleSpec, mockLlm);
    expect(changes.hasChanges).toBe(false);
    expect(changes.summary).toBe('No existing spec to compare');
  });
});
