# Simple Unified-IR Devices (U04)

Production-shaped devices built on the unified IR contract established by
U01–U03. Each device ships:

| File                         | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `device.ts`                  | IR factory: `createXxxIR(id, config)` → `{ module, layout, device }` |
| `device.ac.ts`               | `buildAccessor(deviceId, storage, layout?, options?)`                |
| `device.d.ts`                | Stable type-only entry point                                         |
| `device.errors.ts`           | Stable, machine-checkable error codes                                |
| `device.test.ts`             | Unit tests: config, IR generation, accessor, electrical behavior     |
| `device.integration.test.ts` | `Circuit.create` integration with typed accessors                    |

```ts
import { button, led } from '@mica-js/simulator/unified-ir/devices';

const sw = button.createButtonIR('sw1');
const lamp = led.createLedIR('led1', { color: 'green' });

const circuit = await Circuit.create({
  devices: [
    { id: 'sw1', type: button.BUTTON_IR_TYPE, description: sw.device.description },
    { id: 'led1', type: led.LED_IR_TYPE, description: lamp.device.description },
  ],
  connections: [
    { from: 'sw1.B', to: 'GND' },
    { from: 'sw1.A', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});

circuit.devices.sw1.press(); // typed ButtonAccessor
circuit.step();
circuit.devices.led1.isOn(); // typed LedAccessor
```

`Circuit.create` infers the accessor from the literal device `type`, so
`circuit.devices.sw1` and `circuit.devices.led1` are fully typed without casts
(the mapping lives in `runtime/types.ts` next to `teaching-mcu-ir`).

## LED

Two passive terminals (`anode`, `cathode`) and three states:

| State        | Type | Meaning                                              |
| ------------ | ---- | ---------------------------------------------------- |
| `lamp`       | bool | Forward biased **and** the intensity cap is non-zero |
| `level`      | u8   | Host-set intensity cap (0–`maxBrightness`)           |
| `brightness` | u8   | Derived intensity: `lamp ? level : 0`                |

`led_ir_update` runs after the electrical solve:

```text
forward = PIN_INPUT[anode] && !PIN_INPUT[cathode]   // flipped by activeLow
lamp    = forward && level > 0
brightness = lamp ? level : 0
```

With the default `initialBrightness = maxBrightness = 255`, `lamp` is identical
to the built-in `ideal-led` kernel (`anode && !cathode`); the parity test drives
both from the same toggling MCU and compares every tick. Accessor highlights:

```ts
lamp.isOn(); // perceived state
lamp.isForwardBiased(); // ignores the intensity cap
lamp.setBrightness(128); // dims/boosts immediately
lamp.getBrightness(); // 0 while dark, level while lit
lamp.readAnode(); // solved terminal level
lamp.snapshot(); // { lamp, level, brightness, anode, cathode, ... }
```

`activeLow: true` models a reverse-mounted LED (anode low, cathode high).

## Button

Two terminals mirroring `packages/device/examples/ideal-button`:

- `A` — switched, bidirectional (drives and observes)
- `B` — reference/return, input

```text
button_ir_tick:                    // before the electrical solve
  raw      = pressed
  differed = raw ^ closed
  ticks    = differed ? counter + 1 : 0
  reached  = ticks >= debounceTicks
  closed  <- reached ? raw : closed
  counter <- reached ? 0 : ticks
  pressCount <- (differed && reached && raw) ? pressCount + 1 : pressCount
  holdTicks  <- closed ? holdTicks + 1 : 0
  PIN_MODE[A]   = closed ? PUSH_PULL : HIGH-Z
  PIN_OUTPUT[A] = closed ? !activeLow : false

button_ir_update:                  // after the electrical solve
  line      <- PIN_INPUT[A]
  reference <- PIN_INPUT[B]
```

The accessor distinguishes the raw host position from the debounced contact:

```ts
sw.press(); // raw = true (pointer/touch down)
sw.isPressed(); // raw
sw.isClosed(); // debounced
sw.isBouncing(); // raw !== closed
sw.getPressCount(); // completed press edges
sw.getHoldTicks(); // consecutive closed ticks
sw.release();
sw.toggle();
sw.snapshot();
```

`debounceTicks` (default `0`) is evaluated inside the generated tick, and
`activeLow: true` drives `A` low while pressed. Released `A` is high-Z, which
the v1 solver reads as low.

### Known limitation: static nets

The unified compiler resolves nets at compile time and supports one driver per
net (or a wired-OR with `allowMultiDriver`). A bilateral two-terminal contact
cannot be modelled as a dynamically joining/breaking net, so the button asserts
`A` as an ideal push-button source instead. `B` is kept as the reference/return
terminal for schematic parity. Low-side wiring needs a pull device, which v1
does not ship; use `activeLow` when the load can be referenced to a rail.

Wiring `A` to a teaching-MCU GPIO adds a second driver because MCU pins are
bidirectional; pass `electrical: { allowMultiDriver: true }` to compile that
net. The inactive side stays high-Z, so the wired-OR level is exactly the
button position.

## Performance

Measured by `performance.test.ts` (one engine call per 200 k-tick batch):

| Scenario                            | Throughput      |
| ----------------------------------- | --------------- |
| Unified LED + toggling MCU          | ~29.9 M ticks/s |
| Built-in `ideal-led` + toggling MCU | ~32.7 M ticks/s |
| Button + LED circuit                | ~11.7 M ticks/s |

The richer LED costs ~9 % versus the built-in kernel (ratio ≈ 0.91×) while
adding intensity, colour metadata and a semantic accessor. The legacy scheduler
is event-driven, so a quiet button schedules no work at all; a tick-for-tick
speedup is not defined for these devices.
