export async function setup(adapter, model, attach, description, options = {}) {
  let context;
  const batches = [];
  const library = adapter.createDeviceLibrary([
    {
      id: 'jit',
      model,
      create(ctx) {
        context = ctx;
        attach(ctx);
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
  return { board, context, batches };
}

export function values(batches) {
  return batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
}
