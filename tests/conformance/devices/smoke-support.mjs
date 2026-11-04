// Host-controlled electrical stimulus; each command is published by a real DDL process.
export async function pinDriver(adapter, pins) {
  const model = await adapter.compileDDL(`device SmokePinDriver {
    ${pins.map((pin) => `pin ${pin};`).join('\n')}
    pin supply;
    pin reference;
    record Command { value: number; mask: number; }
    input channel command: Command(capacity: 16, overflow: Overflow.error);
    process start {
      loop {
        const requested = await command.receive();
        ${pins
          .map(
            (pin, index) => `if (requested.mask & ${2 ** index}) == 0 {
              ${pin}.intent <- [];
            } else if (requested.value & ${2 ** index}) != 0 {
              ${pin}.intent <- [resistor(to: supply, resistance: 25)];
            } else {
              ${pin}.intent <- [resistor(to: reference, resistance: 25)];
            }`,
          )
          .join('\n')}
      }
    }
  }`);
  let context;
  return {
    entry: {
      id: 'driver',
      model,
      create(ctx) {
        context = ctx;
        return { sync() {}, dispose() {} };
      },
    },
    send(value, mask = 2 ** pins.length - 1) {
      context.inputs.command.send({ value, mask });
    },
  };
}
