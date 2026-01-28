// src/agents/login-graph/nodes/load-spec.ts
import type { LoginGraphStateType } from '../state.js';
import { SpecStore } from '../../../specs/spec-store.js';

export async function loadSpec(
  state: LoginGraphStateType
): Promise<Partial<LoginGraphStateType>> {
  const specStore = new SpecStore();
  const spec = specStore.load(state.systemCode);

  if (spec) {
    console.log(`  [loadSpec] Loaded spec for ${state.systemCode} (version ${spec.version})`);
  } else {
    console.log(`  [loadSpec] No existing spec found for ${state.systemCode}`);
  }

  return { spec };
}
