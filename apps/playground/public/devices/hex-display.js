/**
 * 4-bit display driver: samples D0..D3 on every edge and publishes the nibble both as a padded
 * decimal and as binary. It only reads pins, so the value always comes from the wired counter.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const ir = api.ir;
  const data = [ir.pin('D0'), ir.pin('D1'), ir.pin('D2'), ir.pin('D3')];
  const updates = ir.output('updates', { params: ['u32'], capacity: 8 });
  const sample = ir.entry('sample', ['u8', 'u32', 'u32', 'u32', 'u32']);
  const boot = ir.entry('boot', []);
  const initialize = ir.lifecycle('initialize', []);
  const observers = data.map((pin, index) =>
    ir.observeDigital(`d${index}`, { trigger: pin, captures: data, target: sample }),
  );

  sample.body((b, [, d0, d1, d2, d3]) => {
    const bit = (value, shift) =>
      b.int.and(b.int.lshr(value, b.const('u32', shift)), b.const('u32', 1));
    const value = b.int.or(
      b.int.or(bit(d0, 0), b.int.shl(bit(d1, 0), b.const('u32', 1))),
      b.int.or(b.int.shl(bit(d2, 0), b.const('u32', 2)), b.int.shl(bit(d3, 0), b.const('u32', 3))),
    );
    b.output(updates, [value]);
    b.return([]);
  });

  boot.body((b) => {
    b.output(updates, [b.const('u32', 0)]);
    b.return([]);
  });

  initialize.body((b) => {
    for (const pin of data) {
      b.pin.configure(pin, { mode: 'high-z', outputEnabled: false, pull: 'down' });
    }
    for (const observer of observers) {
      b.observe.configure(observer, { enabled: true, edges: 'both' });
    }
    // The boot entry runs after initialize completes, so the first publish is legal.
    b.event.at(boot, b.const('f64', 0), []);
    b.return([]);
  });

  // Several observers can sample the same nibble in one phase, so only real changes are news.
  let last = -1;
  api.onOutput(updates, ([value]) => {
    if (value === last) {
      return;
    }
    last = value;
    api.publish('value', String(value).padStart(4, '0'));
    api.publish('bits', value.toString(2).padStart(4, '0'));
  });

  return { initialize };
}
