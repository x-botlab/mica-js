export default function createPotentiometer({ electrical, properties }) {
  const { trackResistance: track, endResistance: end, initialPosition: initial } = properties;
  electrical.initializeResistor('upper', {
    resistance: end + track * (1 - initial),
    enabled: true,
  });
  electrical.initializeResistor('lower', { resistance: end + track * initial, enabled: true });
  return {
    initialize(api) {
      api.state('position').store(api.builder.const('f64', initial));
    },
    tick(api) {
      const b = api.builder;
      const position = api.state('position').load();
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
    },
  };
}
