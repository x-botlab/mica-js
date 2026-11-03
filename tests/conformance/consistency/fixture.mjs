export async function library(adapter, model) {
  const delivered = new Map();
  // 工厂按装配实例序调用，仅用于把真实交付归属到实例。
  return {
    delivered,
    create(instances, options = {}) {
      let index = 0;
      const ids = instances.map((instance) => instance.id);
      const entries = [
        {
          id: 'random',
          model,
          create() {
            const id = ids[index++];
            return {
              sync(batch) {
                const previous = delivered.get(id) ?? [];
                delivered.set(id, [
                  ...previous,
                  ...batch.outputs.out.map((message) => message.value),
                ]);
              },
              dispose() {},
            };
          },
        },
      ];
      return adapter.createBoard(
        adapter.createDeviceLibrary(entries),
        {
          instances: instances.map((instance) => ({ type: 'random', ...instance })),
          nets: [],
        },
        options,
      );
    },
  };
}
