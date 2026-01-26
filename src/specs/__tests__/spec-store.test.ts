import { describe, it, expect } from 'vitest';
import { SpecStore } from '../spec-store';
import { LoginSpec } from '../../schemas';

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

  it('should detect changes between specs', () => {
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

    const changes = store.compare('vendor-abc', newSpec);
    expect(changes.hasChanges).toBe(true);
    expect(changes.formChanges).toContain('usernameSelector: #username → #new-username');
  });

  it('should return no changes for identical specs', () => {
    const store = new SpecStore();
    store.save(sampleSpec);

    const changes = store.compare('vendor-abc', sampleSpec);
    expect(changes.hasChanges).toBe(false);
  });
});
