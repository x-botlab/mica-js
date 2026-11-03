import assert from 'node:assert/strict';

export async function validateDDL(adapter, source) {
  const model = await adapter.compileDDL(source);
  let factoryCalls = 0;
  const library = adapter.createDeviceLibrary([
    {
      id: 'language/atomic',
      model,
      create() {
        factoryCalls++;
        return { sync() {}, dispose() {} };
      },
    },
  ]);
  assert.ok(library && typeof library === 'object');
  assert.equal(factoryCalls, 0);
  return model;
}

export async function runDDLOutput(adapter, t, source) {
  const batches = [];
  const model = await adapter.compileDDL(source);
  const library = adapter.createDeviceLibrary([
    {
      id: 'language/atomic',
      model,
      create() {
        return {
          sync(batch) {
            batches.push(batch);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = adapter.createBoard(library, {
    instances: [{ id: 'atomic', type: 'language/atomic' }],
    nets: [],
  });
  t.after(() => board.dispose());
  board.runUntil(0);
  return batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
}

export function assertModelValidationError(error, code) {
  assert.equal(error.code, 'MODEL_VALIDATION_FAILED');
  assert.equal(error.diagnostic.code, 'MODEL_VALIDATION_FAILED');
  assert.equal(error.diagnostic.phase, 'library');
  const cause = error.diagnostic.cause;
  assert.ok(cause && Array.isArray(cause.diagnostics));
  assert.ok(cause.diagnostics.length > 0);
  assert.ok(
    cause.diagnostics.some((diagnostic) => diagnostic.code === code),
    code,
  );
  for (const diagnostic of cause.diagnostics) {
    assert.equal(diagnostic.phase, 'finalize');
    assert.equal(typeof diagnostic.message, 'string');
    assert.ok(diagnostic.message.length > 0);
    assert.ok(Array.isArray(diagnostic.path));
    assert.ok(Array.isArray(diagnostic.related));
  }
  return true;
}
