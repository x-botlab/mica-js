export default function createLed({ electrical }) {
  for (const name of ['anode', 'cathode']) {
    electrical.initializePin(name, {
      input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
    });
  }
  return {
    update(api) {
      const b = api.builder;
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
