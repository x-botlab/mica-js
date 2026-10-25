# Unified IR Architecture

Single-module compilation for multi-device circuits, achieving 10-1000× performance improvements over scheduler-based architecture.

## Architecture

```
Circuit Config → Compiler → Single IR Module → JIT → Native Code
   (devices +       ↓           (devices +       ↓
    netlist)    Resource       electrical      Optimized
              Allocation       solving         execution
                  ↓           inlined)
              Topology
               Analysis
```

**Key concepts:**

- **Unified compilation**: Multiple devices + electrical network compile into one IR module
- **Global resource allocation**: Pins, states, and storage share a unified address space
- **Inlined electrical solving**: Network resolution becomes IR functions (no host boundary)
- **Batch processing**: Main loop stays in IR (tight JIT-optimized loop)

## Directory Structure

```
unified-ir/
├── compiler/         # IR compilation pipeline
│   ├── index.ts               - Main compiler entry
│   ├── allocator.ts           - Global resource allocation
│   ├── topology.ts            - Electrical network analysis
│   ├── device-gen.ts          - Device IR generation
│   ├── topics.ts              - Topic port → IR endpoint registry
│   ├── schematic-compiler.ts  - Schematic → compilation input + rails
│   ├── solver-gen.ts          - Network solver generation
│   ├── mainloop-gen.ts        - Main loop generation
│   └── lowering/              - Domain instruction lowering
│       ├── index.ts           - DomainInstructionLowering pass
│       ├── connection-lower.ts - connection.apply → stores + solves
│       └── observe-lower.ts   - observe.configure → main-loop edge detection
├── runtime/          # Circuit execution runtime
│   ├── circuit.ts             - Circuit class and factory
│   ├── circuit-executor-adapter.ts - DeviceSimExecutor over Circuit
│   ├── topic-payload.ts       - TopicPayload ↔ IR scalar encoding
│   ├── accessors.ts           - Device accessor loading
│   ├── factory.ts             - Helper factories
│   └── types.ts               - Runtime type definitions
├── devices/          # Simple production devices (U04)
│   ├── common.ts         - Shared pin/state helpers
│   ├── led/              - Unified LED: IR factory, accessor, tests
│   └── button/           - Unified push button: IR factory, accessor, tests
├── examples/         # Reference device implementations (test-only, not built-in)
│   └── teaching-mcu/     - Complete example: ARM Cortex-M3 device
│       ├── teaching-mcu.ts      - IR factory
│       ├── teaching-mcu.ac.ts   - Accessor builder
│       ├── teaching-mcu.d.ts    - TypeScript types
│       └── *.test.ts            - Tests
├── pin-space.ts      # Shared pin address space and pin modes
└── validation.ts     # Validation grants derived from a generated module

```

## Usage

### Compile a circuit

```typescript
import { compileCircuit } from '@mica-js/simulator/unified-ir/compiler';

const compiled = compileCircuit({
  devices: [
    { id: 'mcu1', type: 'teaching-mcu', config: {...} },
    { id: 'led1', type: 'my-led', config: {...} }
  ],
  netlist: [
    { driver: 'mcu1.PA0', loads: ['led1.anode'] }
  ]
});
```

### Create typed circuit

```typescript
import { Circuit } from '@mica-js/simulator/unified-ir/runtime';
import type { TeachingMCUAccessor } from './examples/teaching-mcu';

interface MyDevices {
  mcu1: TeachingMCUAccessor;
}

const circuit = await Circuit.create<MyDevices>({
  devices: [...],
  netlist: [...]
});

// Type-safe accessor
circuit.devices.mcu1.writeRegister('r0', 42);
circuit.step();
```

### Run a schematic

```typescript
import { createCircuitExecutor, timePs } from '@mica-js/simulator';

const executor = createCircuitExecutor({ devices: provider, resolveDevice });
await executor.loadSchematic(sheet); // sheet -> compileSchematicToCircuit -> Circuit
executor.deliver({ symbol: 'S1', port: 'pressed' }, true);
const report = executor.advance(timePs(16_000_000)); // 16 ticks, 1 tick = 1 µs
```

`compileSchematicToCircuit` turns a `.sch` into `{ input, rails, diagnostics }`:
symbols become devices (designator as id), wires and junctions become connections, and
`builtin:power` / `builtin:ground` symbols declare the rails (`GND` is the only accepted
ground net). Diagnostics replace throws, so a host can show every problem at once.

Device topic ports are the message channel: `api.topics.publish(port, args)` emits an IR
output, `api.topics.subscribe(port, handler)` fills an IR entry, `Circuit.deliverTopic`
calls one entry, and `Circuit.onPublish` reports every publish. Payloads travel as
scalars — see `runtime/topic-payload.ts` for the bounded byte encoding.

`createCircuitExecutor` implements `DeviceSimExecutor` on top of `Circuit`, which is what
lets the playground and the widget host run the compiled engine without changing their
call sites.

## Device Development

Devices consist of three parts (see `examples/teaching-mcu/` for reference):

1. **IR factory** (`device.ts`): Generates IR functions for device behavior
2. **Accessor builder** (`device.ac.ts`): Provides high-level API over storage
3. **TypeScript types** (`device.d.ts`): Type definitions for accessor

See [examples/teaching-mcu/README.md](./examples/teaching-mcu/README.md) for detailed guide.

### Digital electrical model

Every net solves in three tiers (RFC 0002):

```text
1. strong drive   push-pull always drives; open-drain only pulls low
2. weak bias      pin.pull('up' | 'down'), independent of the drive mode
3. floating       nothing holds the net, so it samples the deterministic
                  RFC 0002 §4.5 sequence (`mica-floating-v2`)
```

| Drive mode   | `pin_output` 0 | `pin_output` 1 |
| ------------ | -------------- | -------------- |
| `push-pull`  | pulls low      | pulls high     |
| `open-drain` | pulls low      | releases       |
| `high-z`     | releases       | releases       |

```ts
const sda = api.pin('sda');
sda.configure({ mode: 'open-drain' }); // or PIN_MODE.openDrain
sda.pull('up'); // weak bias, independent of the latch
```

`solve_net_<id>` reads `pin_mode`, `pin_output` and `pin_pull` by constant index,
so a solve is a handful of typed-array loads and `select`s — never a netlist
walk. A strong driver beats any bias and a rail beats a weak bias; several
open-drain drivers form a wired-OR net (`electrical: { allowMultiDriver: true }`
accepts one at compile time, which is how an I²C bus is wired).

### Analog voltage model

The same solve also produces a voltage per node (RFC 0002 §4/§5), stored in
`pin_voltage` and readable through the analog API:

```text
1. rail      GND / VCC / 3V3 — a stiff source, always wins
2. strong    push-pull (high = domain supply, low = 0 V)
             open-drain (low = 0 V, released otherwise)
             analog (pin_voltage_intent, after `writeAnalog` enables the output)
3. weak      pull-up = supply, pull-down = 0 V
4. floating  0 V
```

```ts
const out = api.pin('DAC');
out.writeAnalog(2.5); // stores pin_voltage_intent and switches to `analog`
const sensed = api.pin('ADC').sampleAnalog(); // solved voltage, in volts
api.pin('ADC').configure({ lowThreshold: 0.8, highThreshold: 2.0 });
```

Digital reads of a node with no switch use the thresholds, not the boolean
wired-OR: `v < low` reads 0, `v > high` reads 1, and the band in between keeps
the previous level. Thresholds are seeded per pin from its power-domain supply
(`0.8 V / 2.0 V` for 3.3 V, scaled for 1.8 V and 5 V), which keeps low-voltage
logic readable without any configuration.

Two strong drivers whose voltages differ by more than `0.001 V` are an
electrical conflict: the solver latches `electrical_fault`, the generated step
returns before any device update, and the host sees
`CircuitError('electrical-conflict')`. `circuit.electricalFault`,
`clearElectricalFault()` and `reset()` manage the pause. Hosts sample the analog
trace with `circuit.samplePinVoltage(symbol, pin)` or the executor's
`samplePinVoltage` probe, next to the digital `samplePin`.

### Switchable connections and observations

A description may declare two domain features; both are lowered to core IR at
compile time, so the generated module contains no executor call and no host hop.

```ts
const description: DeviceDescription = {
  pins: { A: { direction: 'passive' }, B: { direction: 'passive' } },
  connections: { contact: { pins: ['A', 'B'], initial: 'open' } },
  ports: { pressed: { direction: 'input', type: 'boolean' } },
  behaviors: {
    initialize: (api) => {
      api.connection.set('contact', false); // compile-time constant: no state read
      api.topics.subscribe('pressed', (handler) => {
        handler.connection.apply([
          { connection: 'contact', closed: handler.args[0] as Value<'bool'> },
        ]);
      });
    },
  },
};
```

`connection.apply` writes `connection_states[i]` and stores
`PIN_INPUT[sink] = select(closed, mergedLevel, baseLevel)` for every sink of the
two merged nets. The merged level is a compile-time expanded driver read, and the
net solvers fold the same `select` into their own sink writes every tick, so a
closed switch survives the electrical solve. Poles that share a net (an SPDT
relay) are compiled into one `solve_connections_<id>` function: one call, one
store per sink.

```ts
const description: DeviceDescription = {
  pins: { IN: { direction: 'input' }, COM: {}, NO: {}, NC: {} },
  observers: { control: { trigger: 'IN', captures: ['IN'], edges: 'both' } },
  behaviors: {
    initialize: (api) => {
      api.observe.configure('control', {
        handler: (handler, captured) => {
          const level = captured[0]!;
          handler.connection.set('normallyOpen', level);
          handler.connection.set('normallyClosed', handler.builder.bool.not(level));
        },
      });
    },
  },
};
```

`observe.configure` seeds `observe_baselines[i]` and the main loop appends the
edge detection after every device update:

```text
unified_tick:
  ... device ticks, solve_net_*, device updates ...
  %current = array.load @pin_input, trigger
  %last    = array.load @observe_baselines, i
  branch bool.xor(%last, %current), detect, after
detect:
  call @<device>_observe_<name>, [captured...]
  jump after
after:
  array.store @observe_baselines, i, %current
```

The pass lives in `compiler/lowering/`; `DomainInstructionLowering.run()` fails
compilation if any `connection.apply` / `observe.configure` instruction reaches
the module.

### Power domains (RFC 0007)

A description may declare the power domains its device owns. The first entry is
the **primary domain**: it gates the device's own `tick`/`update` phases, and
every pin without an explicit `powerDomain` inherits it.

```ts
const description: DeviceDescription = {
  pins: {
    PA0: { direction: 'output' }, // inherits the primary domain
    VBAT_SENSE: { direction: 'input', powerDomain: 'vbat' },
  },
  powerDomains: [
    { name: 'vdd', voltage: 3.3 },
    { name: 'vbat', voltage: 3 },
  ],
  behaviors: {
    initialize: (api) => {
      api.pin('PA0').configure('push-pull');
      api.pin('PA0').writeDigital(api.builder.const('bool', true));
    },
  },
};

circuit.isPowered('mcu1', 'vdd'); // true — every domain starts powered
circuit.turnOff('mcu1', 'vdd'); // release PA0, skip the device's phases
circuit.turnOn('mcu1', 'vdd'); // resume with the retained latch
```

The compiler packs one `bool` per declared domain into the shared `power_ready`
array. An unpowered domain changes three emitted paths, all branch-free:

```text
drive   solve_net_<id>   driven/high = ... && power_ready[domain]
sample  pin.sampleDigital  select(power_ready[domain], PIN_INPUT[pin], false)
logic   unified_tick       branch power_ready[primary], <device phase>, after
```

`Circuit.getPin` applies the same sampling rule to host reads, and observer edge
detection is skipped for an unpowered device (its baseline still follows the
trigger so a missed edge is not replayed). Configuration and output latches are
retained, exactly like the scheduler path's pin intent: turning the domain back
on restores the previous drive.

`voltage` is metadata only. The circuit is a boolean model, so no voltage
arithmetic is emitted; the field is reserved for a future voltage solver. A
circuit that declares no domains keeps the ungated fast path — no
`power_ready` array is allocated and every generator emits its pre-RFC-0007
instructions.

## Performance

Typical improvements vs. scheduler-based architecture:

| Scenario                    |   Speedup |
| --------------------------- | --------: |
| Single device, single-step  |    10-20× |
| Single device, batch        |   50-100× |
| Multi-device, batch         | 100-1000× |
| Instruction execution (DBT) |   70-170× |

Compilation overhead: ~0.4 ms for MCU + LED (amortized over execution).

Measured scenarios, methodology and reproduction steps: [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md).

## Design Constraints

- **CSP-safe codegen**: Uses `new Function()`, not `eval()`
- **Deterministic execution**: Same inputs always produce same outputs
- **IR validation**: All generated IR passes semantic checks
- **No device coupling**: Simulator doesn't bundle device implementations

## Important Notes

**examples/ devices are test-only**: The `examples/teaching-mcu` device is provided solely for testing and as a reference implementation. It is **not** a built-in device. Production devices should be:

- Provided by separate packages (`@mica-js/device`, third-party packages)
- Loaded by the host application
- Not maintained within the simulator core
