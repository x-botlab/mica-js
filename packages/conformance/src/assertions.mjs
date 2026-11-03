import assert from 'node:assert/strict';

export function closeTo(actual, expected, { absolute, relative }) {
  assert(Number.isFinite(actual) && Number.isFinite(expected), 'finite voltages required');
  assert(
    Number.isFinite(absolute) && absolute >= 0,
    'explicit nonnegative absolute tolerance required',
  );
  assert(
    Number.isFinite(relative) && relative >= 0,
    'explicit nonnegative relative tolerance required',
  );
  assert(
    Math.abs(actual - expected) <= absolute + relative * Math.abs(expected),
    `expected ${actual} near ${expected}`,
  );
}

export function diagnostic(error, { code, phase }) {
  assert.equal(error?.diagnostic?.code, code);
  assert.equal(error?.diagnostic?.phase, phase);
}

export function messages(batches, name) {
  return batches.flatMap((batch) => batch.outputs[name]);
}
