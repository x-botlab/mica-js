export default function createMcu({ electrical }) {
  const pins = ['PA0', 'PA1', 'PA2', 'PA3'];
  for (const name of pins) {
    electrical.initializePin(name, {
      drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
    });
  }
  return {
    initialize(api) {
      const b = api.builder;
      for (const name of pins) {
        const pin = api.pin(name);
        pin.configure(1);
        pin.setOutputEnabled(b.const('bool', true));
      }
      api.writeDigitalGroup(
        pins,
        pins.map(() => b.const('bool', false)),
      );
    },
    tick(api) {
      api.writeDigitalGroup(
        pins,
        pins.map((name) => api.builder.bool.not(api.pin(name).readDrivenDigital())),
      );
    },
  };
}
