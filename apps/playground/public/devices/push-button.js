/**
 * Momentary push button: `pressed` closes the A/B contact. It drives no pin, so the circuit
 * decides what the contact pulls down.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const ir = api.ir;
  const contact = ir.connection('contact');
  const setPressed = ir.entry('setPressed', ['bool']);
  const initialize = ir.lifecycle('initialize', []);
  const reset = ir.lifecycle('reset', []);

  setPressed.body((b, [pressed]) => {
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
