export default function createRelay({ electrical }) {
  electrical.initializePin('IN', { input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 } });
  return {
    tick(api) {
      const energized = api.pin('IN').sampleDigital();
      api.state('energized').store(energized);
      api.applyConnections(
        ['normallyOpen', 'normallyClosed'],
        [energized, api.builder.bool.not(energized)],
      );
    },
  };
}
