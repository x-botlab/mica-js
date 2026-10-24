# Example Devices

This directory contains **reference device implementations** for testing and documentation purposes. These are **not built-in devices** — the simulator does not bundle device implementations.

## Purpose

Example devices serve three purposes:

1. **Validation**: Exercise the unified IR compiler and runtime with realistic complexity
2. **Reference**: Demonstrate device development patterns and best practices
3. **Testing**: Provide fixtures for integration and performance tests

## Available Examples

### teaching-mcu

Complete ARM Cortex-M3 implementation demonstrating:

- Dual ISA support (teaching 16-bit + M3 32-bit)
- Register file and memory management
- GPIO and pin electrical integration
- NVIC interrupt controller
- Exception entry/return
- Runtime firmware patching

**Performance**: 71-168× faster than scheduler-based architecture (13-31 M inst/s).

See [teaching-mcu/README.md](./teaching-mcu/README.md) for detailed documentation.

## Device Development Guide

### File Structure

A complete device implementation consists of:

```
my-device/
├── my-device.ts           # IR factory
├── my-device.ac.ts        # Accessor builder
├── my-device.d.ts         # TypeScript types
├── my-device.errors.ts    # Error definitions (optional)
├── my-device.test.ts      # Unit tests
└── README.md              # Documentation
```

### 1. IR Factory (`my-device.ts`)

Generates IR functions for device behavior:

```typescript
import type { IRDevice } from '@mica-js/simulator/unified-ir/compiler';

export function createMyDeviceIR(id: string, config: MyDeviceConfig): IRDevice {
  return {
    id,
    type: 'my-device',
    pins: [
      { id: `${id}.input`, mode: 'input' },
      { id: `${id}.output`, mode: 'output' },
    ],
    resources: {
      scalars: { count: 2 }, // state variables
      arrays: { count: 0 },
      bytes: { count: 0 },
    },
    kernel: (ctx) => {
      // Generate IR for device tick
      ctx.body((b) => {
        const input = b.readPin(0);
        const state = b.getScalar(0);
        // ... device logic ...
        b.writePin(1, result);
      });
    },
  };
}
```

### 2. Accessor Builder (`my-device.ac.ts`)

Provides high-level API over storage:

```typescript
import type { StorageAccessor } from '@mica-js/simulator/unified-ir/runtime';

export function buildAccessor(deviceId: string, storage: StorageAccessor) {
  return {
    getState(): number {
      return storage.getScalar(0);
    },
    setState(value: number): void {
      storage.setScalar(0, value);
    },
    readOutput(): boolean {
      return storage.getPin(1);
    },
  };
}
```

### 3. TypeScript Types (`my-device.d.ts`)

Export accessor interface:

```typescript
export interface MyDeviceAccessor {
  getState(): number;
  setState(value: number): void;
  readOutput(): boolean;
}
```

### 4. Usage

```typescript
import { Circuit } from '@mica-js/simulator/unified-ir/runtime';
import { createMyDeviceIR } from './my-device';
import type { MyDeviceAccessor } from './my-device';

interface Devices {
  dev1: MyDeviceAccessor;
}

const circuit = await Circuit.create<Devices>({
  devices: [
    { id: 'dev1', type: 'my-device', factory: createMyDeviceIR, config: {...} }
  ],
  netlist: [...]
});

circuit.devices.dev1.setState(42);
circuit.step();
console.log(circuit.devices.dev1.readOutput());
```

## Key Principles

### No device coupling

The simulator does not know about specific device types. Device loading, type mapping, and instantiation are the **user's responsibility**.

### Explicit type mapping

Users declare their circuit's device types explicitly:

```typescript
interface MyCircuit {
  mcu: TeachingMCUAccessor;
  led: MyLEDAccessor;
}

const circuit = await Circuit.create<MyCircuit>(...);
```

No magic inference from literals or registries.

### StorageAccessor interface

Device accessors receive `StorageAccessor`, which hides JIT/compiled internals:

```typescript
interface StorageAccessor {
  getScalar(index: number): number;
  setScalar(index: number, value: number): void;
  getArray(index: number): Float64Array;
  getBytes(index: number): Uint8Array;
  getPin(pinIndex: number): boolean;
  setPin(pinIndex: number, value: boolean): void;
}
```

Accessors should not depend on IR implementation details.

## Testing

Example devices include comprehensive tests:

- **Unit tests**: IR generation, accessor methods, edge cases
- **Integration tests**: Multi-device circuits, electrical networks
- **Performance tests**: Throughput benchmarks, latency measurements

Run tests:

```bash
pnpm test packages/simulator/src/unified-ir/examples/
```

## Contributing

Example devices are part of the simulator's test suite. When adding new examples:

1. Provide complete implementation (IR factory + accessor + types)
2. Include comprehensive tests
3. Document design decisions and tradeoffs
4. Measure performance vs. baseline

Example devices are **not production devices** — they exist to validate and document the unified IR architecture.
