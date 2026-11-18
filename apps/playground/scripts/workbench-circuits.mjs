export function createMcuCircuit(devices) {
  const button = '11111111-1111-4111-8111-111111111111';
  const led = '22222222-2222-4222-8222-222222222222';
  const mcu = '66666666-6666-4666-8666-666666666666';
  const buzzer = '77777777-7777-4777-8777-777777777777';
  let sequence = 10;
  const id = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
  const pin = (instance, name) => ({ kind: 'pin', instance, pin: name });
  const reference = (instance, name, voltage) => ({
    id: id(),
    target: pin(instance, name),
    voltage,
    symbol: voltage === 0 ? 'ground' : 'power',
  });
  return {
    version: 2,
    dependencies: Object.fromEntries(
      devices.map(({ lock }) => [lock.id, { version: lock.version, integrity: lock.integrity }]),
    ),
    instances: [
      {
        id: mcu,
        device: 'workbench:at89c52',
        designator: 'U1',
        designatorOffset: { x: 1, y: 2 },
        placement: { x: 30, y: 0, rotation: 0 },
      },
      {
        id: button,
        device: 'workbench:button',
        designator: 'S1',
        properties: { label: 'S1' },
        placement: { x: 0, y: 28.48, rotation: 0 },
      },
      {
        id: led,
        device: 'workbench:led',
        designator: 'D1',
        designatorOffset: { x: 0, y: 8 },
        placement: { x: 0, y: -1.46, rotation: 0 },
      },
      {
        id: buzzer,
        device: 'workbench:buzzer',
        designator: 'BZ1',
        placement: { x: 0, y: 14, rotation: 0 },
      },
    ],
    nodes: [],
    wires: [
      { id: id(), from: pin(led, 'cathode'), to: pin(mcu, 'P1_0'), bends: [] },
      {
        id: id(),
        from: pin(buzzer, 'negative'),
        to: pin(mcu, 'P1_1'),
        bends: [
          { x: 20, y: 18 },
          { x: 20, y: 5.08 },
        ],
      },
      { id: id(), from: pin(button, 'b1'), to: pin(mcu, 'P3_2'), bends: [] },
    ],
    labels: [],
    references: [
      reference(mcu, 'VCC', 5),
      reference(mcu, 'GND', 0),
      reference(led, 'anode', 5),
      reference(buzzer, 'positive', 5),
      reference(button, 'a1', 0),
    ],
  };
}
