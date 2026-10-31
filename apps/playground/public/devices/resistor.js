export default function createResistor({ electrical, properties }) {
  electrical.initializeResistor('body', { resistance: properties.resistance, enabled: true });
}
