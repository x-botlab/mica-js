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
│   ├── index.ts          - Main compiler entry
│   ├── allocator.ts      - Global resource allocation
│   ├── topology.ts       - Electrical network analysis
│   ├── device-gen.ts     - Device IR generation
│   ├── solver-gen.ts     - Network solver generation
│   └── mainloop-gen.ts   - Main loop generation
├── runtime/          # Circuit execution runtime
│   ├── circuit.ts        - Circuit class and factory
│   ├── accessors.ts      - Device accessor loading
│   ├── factory.ts        - Helper factories
│   └── types.ts          - Runtime type definitions
├── pin-space.ts      # Shared pin address space and pin modes
└── validation.ts     # Validation grants derived from a generated module

```

## Usage

### Compile a circuit

```typescript
import { compileCircuit } from '@mica-js/simulator/unified-ir/compiler';

const compiled = compileCircuit({
  devices: [
    { id: 'drive1', type: 'push-pull-driver', description: driverDescription },
    { id: 'sink1', type: 'lamp-sink', description: sinkDescription },
  ],
  connections: [
    { from: 'drive1.PA0', to: 'sink1.anode' },
    { from: 'sink1.cathode', to: 'GND' },
  ],
});
```

### Build a circuit

```typescript
import { Circuit } from '@mica-js/simulator';

const circuit = await Circuit.create({
  devices: [{ id: 'counter1', type: 'counter-ir', description }],
  connections: [{ from: 'counter1.clk', to: 'VCC' }],
});

circuit.devices.counter1; // DeviceAccessor; caller-owned types assert the richer surface
circuit.step();
```

Devices are supplied by the caller: @mica-js/simulator exports no device models.

## Device Development

Devices consist of three parts (the Playground library in `apps/playground/src/sim` is the
reference: contracts in `public/devices`, models in `device-models.ts`):

1. **IR factory** (`device.ts`): Generates IR functions for device behavior
2. **Accessor builder** (`device.ac.ts`): Provides high-level API over storage
3. **TypeScript types** (`device.d.ts`): Type definitions for accessor

Hosts that resolve schematic references additionally supply a `SchematicDeviceBinding` with the
topics and accessor bridges the device exposes.

## Performance

Typical improvements vs. scheduler-based architecture:

| Scenario                    |   Speedup |
| --------------------------- | --------: |
| Single device, single-step  |    10-20× |
| Single device, batch        |   50-100× |
| Multi-device, batch         | 100-1000× |
| Instruction execution (DBT) |   70-170× |

Compilation overhead: ~0.4 ms for a two-device circuit (amortized over execution).

Measured scenarios, methodology and reproduction steps: [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md).

## Design Constraints

- **CSP-safe codegen**: Uses `new Function()`, not `eval()`
- **Deterministic execution**: Same inputs always produce same outputs
- **IR validation**: All generated IR passes semantic checks
- **No device coupling**: Simulator doesn't bundle device implementations

## Important Notes

**No built-in devices**: the package ships no device models and no schematic device catalog. Device
definitions and implementations live in the application that needs them — the Playground keeps its
own library in `apps/playground/public/devices` (definitions) and `apps/playground/src/sim`
(models). Third-party devices follow the same shape: separate packages, loaded by the host, never
maintained inside the simulator core
