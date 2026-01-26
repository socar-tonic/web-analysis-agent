// src/security/__tests__/credential-manager.test.ts
import { describe, it, expect } from 'vitest';
import { CredentialManager } from '../credential-manager.js';

describe('CredentialManager', () => {
  it('should store and retrieve credentials', () => {
    const manager = new CredentialManager();
    manager.set('vendor-abc', { username: 'user1', password: 'pass1' });

    expect(manager.get('vendor-abc')).toEqual({ username: 'user1', password: 'pass1' });
  });

  it('should get individual field', () => {
    const manager = new CredentialManager();
    manager.set('vendor-abc', { username: 'user1', password: 'pass1' });

    expect(manager.getField('vendor-abc', 'username')).toBe('user1');
    expect(manager.getField('vendor-abc', 'password')).toBe('pass1');
  });

  it('should return null for unknown systemCode', () => {
    const manager = new CredentialManager();
    expect(manager.get('unknown')).toBeNull();
    expect(manager.getField('unknown', 'username')).toBeNull();
  });
});
