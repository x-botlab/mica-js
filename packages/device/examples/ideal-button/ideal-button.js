/**
 * Ideal button: a passive, bidirectional contact driven only by the host topic.
 * Pressing closes A/B; releasing opens it. No pin is ever driven high.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const contact = api.ir.connection('contact');
  const setPressed = api.ir.entry('setPressed', ['bool']);
  const initialize = api.ir.lifecycle('initialize', []);
  const reset = api.ir.lifecycle('reset', []);

  setPressed.body((b, [pressed]) => {
    // One explicit topology update; neither terminal becomes an output.
    b.connection.apply([{ connection: contact, closed: pressed }]);
    b.return([]);
  });
  initialize.body((b) => {
    b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
    b.return([]);
  });
  reset.body((b) => {
    b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
    b.return([]);
  });

  const stop = api.subscribe('pressed', (pressed) => api.post(setPressed, [pressed]));
  return { initialize, reset, onDispose: stop };
}
