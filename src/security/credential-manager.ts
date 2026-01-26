// src/security/credential-manager.ts
export interface Credentials {
  username: string;
  password: string;
}

export class CredentialManager {
  private store = new Map<string, Credentials>();

  set(systemCode: string, credentials: Credentials): void {
    this.store.set(systemCode, credentials);
  }

  get(systemCode: string): Credentials | null {
    return this.store.get(systemCode) || null;
  }

  getField(systemCode: string, field: 'username' | 'password'): string | null {
    const creds = this.get(systemCode);
    return creds ? creds[field] : null;
  }

  has(systemCode: string): boolean {
    return this.store.has(systemCode);
  }
}
