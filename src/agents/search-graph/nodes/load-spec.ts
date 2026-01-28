// src/agents/search-graph/nodes/load-spec.ts
import type { SearchGraphStateType } from '../state.js';
import type { SearchSpec } from '../../../schemas/index.js';
import { getNodeContext } from '../index.js';

export async function loadSpec(
  state: SearchGraphStateType
): Promise<Partial<SearchGraphStateType>> {
  const ctx = getNodeContext();
  // Note: SpecStore currently returns LoginSpec, but we cast to SearchSpec
  // for search-graph usage. In a full implementation, SpecStore would be
  // generic or have separate methods for different spec types.
  const spec = ctx.specStore.load(state.systemCode) as SearchSpec | null;

  if (spec) {
    console.log(`  [loadSpec] Loaded spec v${spec.version} for ${state.systemCode}`);
  } else {
    console.log(`  [loadSpec] No spec found for ${state.systemCode}`);
  }

  return { spec };
}
