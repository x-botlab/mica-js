/**
 * Demo MCU for the canvas playground: counts on the virtual clock and mirrors the counter to two
 * 4-digit displays. A press on the bound key resets it, so the widget → device direction shows up
 * on screen too.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
const TICK_PS = 100_000_000_000; // 0.1 s, the period the playground drives one step at a time.

export default function createDevice(api) {
  const count = api.ir.state('count', 'u32', 0);
  const tick = api.ir.entry('tick', []);
  const resetCounter = api.ir.entry('resetCounter', []);
  const updates = api.ir.output('updates', { params: ['u32'], capacity: 8 });
  const initialize = api.ir.lifecycle('initialize', []);

  tick.body((b) => {
    const next = b.int.add(b.state.load(count), b.const('u32', 1));
    b.state.store(count, next);
    b.output(updates, [next]);
    b.event.at(tick, b.float.add(b.event.now(), b.const('f64', TICK_PS)), []);
    b.return([]);
  });

  resetCounter.body((b) => {
    b.state.store(count, b.const('u32', 0));
    b.output(updates, [b.const('u32', 0)]);
    b.return([]);
  });

  initialize.body((b) => {
    b.state.store(count, b.const('u32', 0));
    b.event.at(tick, b.const('f64', TICK_PS), []);
    b.return([]);
  });

  // Publishing is a JS-side API, so the IR hands each counter value over through an output.
  api.onOutput(updates, (value) => {
    const age = value[0];
    api.publish('display', (5 + (age % 50) * 0.01).toFixed(2));
    api.publish('display2', String(1000 + (age % 1000)));
  });

  const stop = api.subscribe('key', (pressed) => {
    if (pressed === true) {
      api.post(resetCounter, []);
    }
  });

  return { initialize, onDispose: stop };
}
