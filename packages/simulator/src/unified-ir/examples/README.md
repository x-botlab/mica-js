# Example Devices

Reference device implementations that validate the unified IR compiler and
runtime on realistic complexity. They are shipped with the simulator so the
test suite and the examples can exercise them, but they are **not built-in
devices**: production devices belong in device packages.

Public reference: [docs/API.md](../../../docs/API.md) (device contract and
accessor surface).

## Available Examples

### `teaching-mcu`

Complete ARM Cortex-M3 implementation:

- M3 (32-bit) instruction set with a basic-block provider
- 16-register file, N/Z/C/V flags, unified flash/RAM/peripheral address space
- PA0–PA15 / PB0–PB15 GPIO integrated with the electrical solve
- NVIC interrupts, exception entry/return, WFI
- Runtime firmware patching (`patchFirmware`)

See [teaching-mcu/README.md](./teaching-mcu/README.md).

## Device Contract

A device is described by a `DeviceDescription` and executed inside the circuit
module. The production devices in `../devices/` (`led`, `button`) are the
smallest complete examples; `teaching-mcu` is the complex one.

```ts
import type { DeviceDescription } from '@mica-js/simulator';

export const counter: DeviceDescription = {
  name: 'counter',
  pins: {
    out: { direction: 'output' },
  },
  states: {
    count: { type: 'u32', initial: 0 },
  },
  behaviors: {
    initialize: (api) => api.pin('out').configure(1), // push-pull
    tick: (api) => {
      const b = api.builder;
      const count = api.state<'u32'>('count');
      const next = b.int.add(count.load(), b.const('u32', 1));
      count.store(next);
      api.pin('out').writeDigital(b.int.cmp('ne', next, b.const('u32', 0)));
    },
  },
};
```

Three hooks are available:

| Hook         | Runs when                        | Typical use                         |
| ------------ | -------------------------------- | ----------------------------------- |
| `initialize` | once at `Circuit.create`/`reset` | pin modes, initial register values  |
| `tick`       | before the electrical solve      | drive outputs, advance device state |
| `update`     | after the electrical solve       | sample solved inputs (LED, button)  |

Complex devices add two optional fields:

- `kernel(context)` — runs before the phase bodies; declare private arrays,
  byte memories and providers (firmware, RAM), then return either behaviour
  hooks or ready-made phase function refs.
- `accessor(context)` — build a typed accessor over the engine storage, e.g.
  `TeachingMCUAccessor` or the LED / button accessors.

Pins always live in the shared global pin space:

```ts
api.pin('out').configure(PIN_MODE.pushPull); // writes pin_mode[globalId]
api.pin('out').writeDigital(level); // writes pin_output[globalId]
api.pin('in').sampleDigital(); // reads solved pin_input[globalId]
```

An ordered subset of the pins can be addressed as one bit field (RFC 0004).
The first name is the least significant bit:

```ts
const data = api.pinGroup(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);

data.writeDigital(0xa5); // D0 = 1, D1 = 0, ... D7 = 1 (constant)
data.writeDigital(register.load()); // or any Value<'u32'>
const byte = data.readDigital(); // solved pin_input levels, LSB first
data.pin('D0').configure(PIN_MODE.pushPull); // one member handle
```

`pinGroup` is available on both phase and topic-handler APIs; a group holds
1-32 declared pins, and a repeated or undeclared name is a compile error.

## File Layout

```
my-device/
├── my-device.ts           # IR factory + DeviceDescription
├── my-device.ac.ts        # Typed accessor over StorageAccessor
├── my-device.d.ts         # Stable type-only entry point
├── my-device.errors.ts    # Machine-checkable error codes
├── my-device.test.ts      # Unit tests
├── my-device.integration.test.ts  # Circuit.create integration
└── README.md
```

Use `../devices/led/` as a template: it ships all seven files, a parity test
against the built-in `ideal-led` kernel and a performance test.
