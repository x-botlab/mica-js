export default function createLed({ electrical, properties }) {
  const { nominalVoltage, brightnessSamples, resistance } = properties;
  if (typeof resistance !== 'number' || !Number.isFinite(resistance) || resistance <= 0)
    throw new TypeError('resistance must be a finite positive number');
  electrical.initializeResistor('load', { resistance, enabled: true });
  if (typeof nominalVoltage !== 'number' || !Number.isFinite(nominalVoltage) || nominalVoltage <= 0)
    throw new TypeError('nominalVoltage must be a finite positive number');
  if (!Number.isInteger(brightnessSamples) || brightnessSamples < 1 || brightnessSamples > 1000000)
    throw new TypeError('brightnessSamples must be an integer in [1, 1000000]');
  for (const name of ['anode', 'cathode']) {
    electrical.initializePin(name, {
      input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
    });
  }
  return {
    update(api) {
      const b = api.builder;
      // Ohm's law for the declared linear load, not a nonlinear diode model.
      // Branch current is uniquely zero even when both terminal voltages float;
      // using it avoids interpreting floating-input pseudo-noise as physical light.
      const forward = b.float.mul(api.resistor('load').sampleCurrent(), b.const('f64', resistance));
      const normalized = b.float.div(forward, b.const('f64', nominalVoltage));
      const sample = b.select(
        b.float.cmp('lt', normalized, b.const('f64', 0)),
        b.const('f64', 0),
        b.select(b.float.cmp('gt', normalized, b.const('f64', 1)), b.const('f64', 1), normalized),
      );
      const brightness = api.state('brightness');
      // Exponential moving average: y += (sample - y) / N, once per update.
      // N=1 is instantaneous. State starts at zero and circuit reset restores it.
      const previous = brightness.load();
      brightness.store(
        brightnessSamples === 1
          ? sample
          : b.float.add(
              previous,
              b.float.div(b.float.sub(sample, previous), b.const('f64', brightnessSamples)),
            ),
      );
      api
        .state('lamp')
        .store(
          b.bool.and(
            api.pin('anode').sampleDigital(),
            b.bool.not(api.pin('cathode').sampleDigital()),
          ),
        );
    },
  };
}
