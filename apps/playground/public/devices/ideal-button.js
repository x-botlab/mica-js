export default function createButton({ properties }) {
  const ticks = properties.debounceTicks;
  if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1000000)
    throw new TypeError('debounceTicks must be an integer in [0, 1000000]');
  return {
    tick(api) {
      const b = api.builder;
      const pressed = api.state('pressed').load();
      const settled = api.state('settled').load();
      const differing = b.bool.xor(pressed, settled);
      const counter = b.select(
        differing,
        b.int.add(api.state('debounce').load(), b.const('u32', 1)),
        b.const('u32', 0),
      );
      const adopt = b.bool.and(differing, b.int.cmp('ge', counter, b.const('u32', ticks)));
      const next = b.select(adopt, pressed, settled);
      const closing = b.bool.and(b.bool.not(settled), next);
      const count = api.state('pressCount');
      count.store(b.int.add(count.load(), b.select(closing, b.const('u32', 1), b.const('u32', 0))));
      api.state('settled').store(next);
      api.state('debounce').store(b.select(adopt, b.const('u32', 0), counter));
      api.state('closed').store(next);
      api.applyConnections(['contact'], [next]);
    },
  };
}
