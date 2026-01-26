import { LoginSpec } from '../schemas';

export interface SpecChanges {
  hasChanges: boolean;
  formChanges?: string[];
  apiChanges?: string[];
}

export class SpecStore {
  private store = new Map<string, LoginSpec>();

  save(spec: LoginSpec): void {
    this.store.set(spec.systemCode, spec);
  }

  load(systemCode: string): LoginSpec | null {
    return this.store.get(systemCode) || null;
  }

  has(systemCode: string): boolean {
    return this.store.has(systemCode);
  }

  compare(systemCode: string, newSpec: LoginSpec): SpecChanges {
    const oldSpec = this.load(systemCode);
    if (!oldSpec) {
      return { hasChanges: false }; // No previous spec to compare
    }

    const formChanges: string[] = [];
    const apiChanges: string[] = [];

    // Compare form selectors
    if (oldSpec.form && newSpec.form) {
      if (oldSpec.form.usernameSelector !== newSpec.form.usernameSelector) {
        formChanges.push(`usernameSelector: ${oldSpec.form.usernameSelector} → ${newSpec.form.usernameSelector}`);
      }
      if (oldSpec.form.passwordSelector !== newSpec.form.passwordSelector) {
        formChanges.push(`passwordSelector: ${oldSpec.form.passwordSelector} → ${newSpec.form.passwordSelector}`);
      }
      if (oldSpec.form.submitSelector !== newSpec.form.submitSelector) {
        formChanges.push(`submitSelector: ${oldSpec.form.submitSelector} → ${newSpec.form.submitSelector}`);
      }
    }

    // Compare API
    if (oldSpec.api && newSpec.api) {
      if (oldSpec.api.endpoint !== newSpec.api.endpoint) {
        apiChanges.push(`endpoint: ${oldSpec.api.endpoint} → ${newSpec.api.endpoint}`);
      }
      if (oldSpec.api.method !== newSpec.api.method) {
        apiChanges.push(`method: ${oldSpec.api.method} → ${newSpec.api.method}`);
      }
    }

    const hasChanges = formChanges.length > 0 || apiChanges.length > 0;

    return {
      hasChanges,
      formChanges: formChanges.length > 0 ? formChanges : undefined,
      apiChanges: apiChanges.length > 0 ? apiChanges : undefined,
    };
  }
}
