/**
 * 4-bit ripple counter: every falling edge on CLK increments the count, Q0..Q3 carry it out in
 * binary. CLK has an internal pull-up, so a contact to GND produces the edges.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const ir = api.ir;
  const clock = ir.pin('CLK');
  const outputs = [ir.pin('Q0'), ir.pin('Q1'), ir.pin('Q2'), ir.pin('Q3')];
  const count = ir.state('count', 'u32', 0);
  const changed = ir.entry('changed', ['u8']);
  const initialize = ir.lifecycle('initialize', []);
  const observation = ir.observeDigital('clock', {
    trigger: clock,
    captures: [],
    target: changed,
  });

  function driveOutputs(b, value) {
    for (let bit = 0; bit < outputs.length; bit += 1) {
      const level = b.int.and(b.int.lshr(value, b.const('u32', bit)), b.const('u32', 1));
      b.pin.writeDigital(outputs[bit], b.int.cmp('ne', level, b.const('u32', 0)));
    }
  }

  changed.body((b) => {
    const next = b.int.and(b.int.add(b.state.load(count), b.const('u32', 1)), b.const('u32', 15));
    b.state.store(count, next);
    driveOutputs(b, next);
    b.return([]);
  });

  initialize.body((b) => {
    b.state.store(count, b.const('u32', 0));
    b.pin.configure(clock, { mode: 'high-z', outputEnabled: false, pull: 'up' });
    for (const pin of outputs) {
      b.pin.configure(pin, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
    }
    driveOutputs(b, b.const('u32', 0));
    b.observe.configure(observation, { enabled: true, edges: 'falling' });
    b.return([]);
  });

  return { initialize };
}
