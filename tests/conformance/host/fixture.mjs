export async function device(adapter, model, hooks = {}, description) {
  const batches = [];
  let context;
  const library = adapter.createDeviceLibrary([
    {
      id: 'probe',
      model,
      create(ctx) {
        context = ctx;
        hooks.create?.(ctx);
        return {
          sync(batch) {
            batches.push(batch);
            hooks.sync?.(batch, ctx);
          },
          dispose() {
            hooks.dispose?.(ctx);
          },
        };
      },
    },
  ]);
  const board = adapter.createBoard(library, description);
  return { board, context, batches };
}

export function values(batches, name = 'out') {
  return batches.flatMap((batch) => batch.outputs[name].map((message) => message.value));
}

export function diagnostic(code, phase) {
  return (error) =>
    error instanceof Error &&
    error.code === code &&
    (phase === undefined || error.diagnostic.phase === phase);
}
