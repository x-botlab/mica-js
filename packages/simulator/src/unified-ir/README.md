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

## Device Development

Devices consist of three parts (see `examples/teaching-mcu/` for reference):

1. **IR factory** (`device.ts`): Generates IR functions for device behavior
2. **Accessor builder** (`device.ac.ts`): Provides high-level API over storage
3. **TypeScript types** (`device.d.ts`): Type definitions for accessor

See [examples/teaching-mcu/README.md](./examples/teaching-mcu/README.md) for detailed guide.

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
