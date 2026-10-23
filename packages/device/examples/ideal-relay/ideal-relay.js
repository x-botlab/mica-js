/**
 * Ideal relay module: digital IN controls an isolated SPDT contact pair.
 * IN=1 energizes (COM-NO closed, COM-NC open); both contacts switch in one atomic patch.
 * The entry applies the level captured at the edge, so a queued short pulse is not resampled.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const ir = api.ir;
  const input = ir.pin('IN');
  const normallyOpen = ir.connection('normallyOpen');
  const normallyClosed = ir.connection('normallyClosed');
  const apply = ir.func('apply', { params: ['u32'], results: [] });
  const changed = ir.entry('changed', ['u8', 'u32']);
  const observation = ir.observeDigital('control', {
    trigger: input,
    captures: [input],
    target: changed,
  });
  const initialize = ir.lifecycle('initialize', []);

  apply.body((b, [sample]) => {
    const active = b.int.cmp('ne', b.int.and(sample, b.const('u32', 1)), b.const('u32', 0));
    b.connection.apply([
      { connection: normallyOpen, closed: active },
      { connection: normallyClosed, closed: b.bool.not(active) },
    ]);
    b.return([]);
  });
  changed.body((b, [, captured]) => {
    // Use the value captured when the edge was queued; never resample a later pin level.
    b.call(apply, [captured]);
    b.return([]);
  });
  initialize.body((b) => {
    b.pin.configure(input, { mode: 'high-z', outputEnabled: false, pull: 'none' });
    b.call(apply, [b.pin.sampleDigital(input)]);
    b.observe.configure(observation, { enabled: true, edges: 'both' });
    b.return([]);
  });

  return { initialize };
}
