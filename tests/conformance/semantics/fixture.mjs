import assert from 'node:assert/strict';

export async function device(adapter, model, options = {}, description) {
  const batches = [];
  let context;
  const library = adapter.createDeviceLibrary([
    {
      id: 'probe',
      model,
      create(ctx) {
        context = ctx;
        options.create?.(ctx);
        return {
          sync(batch) {
            batches.push(batch);
            options.sync?.(batch, ctx);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = adapter.createBoard(library, description);
  return { board, context, batches };
}

export function messages(batches, name = 'out') {
  return batches.flatMap((batch) => batch.outputs[name]);
}

export function values(batches, name = 'out') {
  return messages(batches, name).map((message) => message.value);
}

export function fault(board, execute) {
  assert.throws(execute, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'MODEL_EXECUTION_FAILED');
    assert.equal(error.diagnostic.phase, 'execute');
    return true;
  });
  assert.equal(board.status, 'faulted');
}
