import { types } from '../../../packages/device-model/dist/index.js';

export { types };

/**
 * Build one real board whose single library entry uses the supplied model. The factory
 * registers batch candidates before returning its adapter, matching the public lifecycle.
 */
export function createRun(adapter, { id, model, description, options = {}, create }) {
  const contexts = [];
  const batches = [];
  const library = adapter.createDeviceLibrary([
    {
      id,
      model,
      create(context) {
        contexts.push(context);
        create?.(context);
        return {
          sync(batch) {
            batches.push(batch);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = adapter.createBoard(library, description, options);
  return { board, contexts, batches };
}

export function messages(batches, name = 'out') {
  return batches.flatMap((batch) => batch.outputs[name] ?? []);
}

/** Deterministic cumulative host targets; the last target is always the requested end. */
export function seededTargets({ seed, count, end, maxStep = 500 }) {
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(end) ||
    end < 1 ||
    !Number.isSafeInteger(maxStep) ||
    maxStep < 1
  )
    throw new TypeError('seeded slices require non-negative integer seed and positive counts');
  let state = seed >>> 0;
  const targets = [];
  while (targets.length < count) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const step = 1 + (state % maxStep);
    const next = Math.min(end, (targets.at(-1) ?? 0) + step);
    targets.push(next);
    if (next === end) return targets;
  }
  if (targets.at(-1) !== end) targets.push(end);
  return targets;
}
