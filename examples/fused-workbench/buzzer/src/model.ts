export const create: DeviceFactory = (context) => {
  let active = false;
  return {
    methods: { getActive: () => active },
    sync(batch) {
      for (const message of batch.outputs.active ?? []) {
        if (active === message.value) continue;
        active = message.value;
        context.events.onDidActiveChange.fire(active);
      }
    },
    dispose() {},
  };
};
