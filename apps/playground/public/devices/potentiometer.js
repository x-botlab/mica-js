export default function createPotentiometer({ electrical, properties }) {
  const { trackResistance: track, endResistance: end, initialPosition: initial } = properties;
  electrical.initializeResistor('upper', {
    resistance: end + track * (1 - initial),
    enabled: true,
  });
  electrical.initializeResistor('lower', { resistance: end + track * initial, enabled: true });
  let setPosition;
  return {
    kernel({ module, bind, deviceId }) {
      setPosition = module.entry(`${deviceId}_set_position`, ['f64']);
      setPosition.body((b, [position]) => {
        const api = bind(b);
        api.applyResistors(
          ['upper', 'lower'],
          [
            b.float.add(
              b.const('f64', end),
              b.float.mul(b.const('f64', track), b.float.sub(b.const('f64', 1), position)),
            ),
            b.float.add(b.const('f64', end), b.float.mul(b.const('f64', track), position)),
          ],
        );
        api.state('position').store(position);
        b.return([]);
      });
      return {
        initialize(api) {
          api.state('position').store(api.builder.const('f64', initial));
        },
      };
    },
    applyInputs(io) {
      const position = io.takeInput('position');
      if (position === undefined) return;
      if (
        typeof position !== 'number' ||
        !Number.isFinite(position) ||
        position < 0 ||
        position > 1
      )
        throw new TypeError('Potentiometer position must be in [0, 1]');
      io.call(setPosition, [position]);
    },
    flushOutputs(io) {
      io.publish('actualPosition', io.readState('position'));
    },
  };
}
