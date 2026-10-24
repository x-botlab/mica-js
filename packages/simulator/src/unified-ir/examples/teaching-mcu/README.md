# Teaching MCU - Example Device

Complete ARM Cortex-M3 implementation for the unified IR architecture. This is a **reference example**, not a built-in device.

## Purpose

Teaching MCU serves as:

- **Complexity validation**: Exercises compiler with real instruction set, peripherals, interrupts
- **Performance baseline**: Demonstrates 70-170× speedup for instruction execution
- **Developer reference**: Shows patterns for complex stateful devices

## Features

### Dual ISA Support

**Teaching ISA** (16-bit, educational):

```
MOV  r0, #42      ; Load immediate
ADD  r1, r0, r2   ; Register arithmetic
LDR  r3, [r0]     ; Memory load
STR  r4, [r1]     ; Memory store
```

**M3 ISA** (32-bit, ARM Cortex-M3 subset):

```
movs  r0, #42
adds  r1, r0, r2
ldr   r3, [r0]
str   r4, [r1]
b     label
bl    subroutine
```

### Architecture Components

- **Register file**: 16 general-purpose registers (r0-r15)
- **Flags**: N, Z, C, V condition codes
- **Memory**: Unified 64KB address space (Flash 0x0000-0x7FFF, RAM 0x8000-0xFFFF)
- **GPIO**: PA0-PA15, PB0-PB15 (32 pins total)
- **NVIC**: Nested Vectored Interrupt Controller (16 external interrupts)
- **Exceptions**: Reset, NMI, HardFault, SVCall, PendSV, SysTick

### Electrical Integration

GPIO pins participate in unified network solving:

- Output mode: Drive HIGH/LOW onto electrical network
- Input mode: Read resolved network voltage
- Interrupt on edge (rising/falling/both)

### Runtime Firmware Patching

Supports updating firmware without recompilation:

```typescript
const snapshot = mcu.snapshot();
mcu.patchFirmware(0x1000, new Uint8Array([0x20, 0x00, ...]));
// Invalidates affected provider blocks, syncs writable mirror
mcu.run(1000);
```

## Performance

Measured on prototype implementation (71-168× vs. scheduler baseline):

| Mode                      |           Rate | Speedup |
| ------------------------- | -------------: | ------: |
| Teaching ISA, batch       | 13.10 M inst/s |   71.3× |
| M3 ISA, batch             | 30.82 M inst/s |  167.7× |
| Teaching ISA, single-step |  2.10 M inst/s |   11.4× |

Baseline: 0.184 M inst/s (scheduler-based architecture).

Batch mode processes instructions in tight IR loop (amortizes dispatch overhead).

## File Structure

```
teaching-mcu/
├── teaching-mcu.ts               # IR factory
├── teaching-mcu.ac.ts            # Accessor builder
├── teaching-mcu.d.ts             # TypeScript types
├── teaching-mcu.errors.ts        # Error definitions
├── teaching-mcu.test-helpers.ts  # Test utilities (firmware builders, reference model)
├── teaching-mcu.test.ts          # Unit tests (45 tests)
├── teaching-mcu.integration.test.ts  # Integration tests (12 tests)
├── teaching-mcu.performance.test.ts  # Performance benchmarks (2 tests)
├── index.ts                      # Public exports
└── README.md                     # This file
```

## Usage Example

```typescript
import { Circuit } from '@mica-js/simulator/unified-ir/runtime';
import { createTeachingMCUCircuit } from './teaching-mcu';
import type { TeachingMCUAccessor } from './teaching-mcu';

interface Devices {
  mcu: TeachingMCUAccessor;
}

const circuit = await Circuit.create<Devices>({
  devices: [
    {
      id: 'mcu',
      type: 'teaching-mcu-ir',
      factory: createTeachingMCUCircuit,
      config: {
        isa: 'm3',  // or 'teaching'
        firmware: new Uint8Array([...]),
        clockHz: 16_000_000
      }
    }
  ],
  netlist: []
});

// Write registers
circuit.devices.mcu.writeRegister('r0', 42);
circuit.devices.mcu.writeRegister('pc', 0x1000);

// Execute
circuit.devices.mcu.step();  // Single instruction
circuit.devices.mcu.run(1000);  // 1000 instructions (batch)

// Read state
const r0 = circuit.devices.mcu.readRegister('r0');
const flags = circuit.devices.mcu.readFlags();
const gpio = circuit.devices.mcu.readGPIO('PA', 0);

// Memory access
circuit.devices.mcu.writeMemory(0x8000, new Uint8Array([1, 2, 3, 4]));
const data = circuit.devices.mcu.readMemory(0x8000, 4);

// NVIC
circuit.devices.mcu.triggerInterrupt(5);  // External interrupt 5
```

## Design Decisions

### Single-block exception handling

Original design used block parameters for exception entry/return. Discovered JIT GVN miscompile in certain block-parameter paths (`vN is not defined`). Workaround: use single-block ISR bodies and remove block params from exception sequences.

### Unified memory map

Flash (0x0000-0x7FFF) and RAM (0x8000-0xFFFF) share single address space. Provider blocks handle flash (read-only, patchable), typed arrays handle RAM (writable).

### Instruction counting

`cycles` field counts retired instructions, not clock cycles. Exception entry charges configurable `exceptionCycles` (default 12).

### GPIO mapping

Legacy `GPIO` pin becomes `PA0`. Full GPIO ports PA/PB with 16 pins each.

## Implementation Notes

### IR Generation

Device kernel generates:

1. **Instruction decode**: Fetch, decode, dispatch to handler
2. **Register operations**: Arithmetic, logic, shifts
3. **Memory access**: Load/store with address translation
4. **Branch/call**: PC updates, link register management
5. **Exception handling**: Vector fetch, stack push/pop, mode transitions
6. **GPIO access**: Memory-mapped peripheral reads/writes
7. **NVIC**: Interrupt pending/enable/priority management

### Accessor API

`StorageAccessor` wrapper provides:

- **Registers**: `readRegister(name)`, `writeRegister(name, value)`
- **Memory**: `readMemory(addr, len)`, `writeMemory(addr, data)`
- **GPIO**: `readGPIO(port, pin)`, `writeGPIO(port, pin, value)`
- **NVIC**: `triggerInterrupt(n)`, `clearInterrupt(n)`
- **Execution**: `step()`, `run(count)`, `reset()`
- **Introspection**: `snapshot()`, `patchFirmware(addr, data)`

### Test Strategy

- **Unit tests**: Instruction semantics, register/memory operations, GPIO/NVIC
- **Integration tests**: Multi-instruction programs, interrupt handling, Circuit API
- **Performance tests**: Throughput benchmarks, validate speedup targets

### Known Limitations

- No cycle-accurate timing (instruction counting only)
- Limited M3 instruction subset (common ops only)
- No MPU, SysTick, or debug features
- Exception priorities simplified (fixed order)

## Future Extensions

Possible enhancements (not currently implemented):

- Full ARMv7-M instruction set
- Cycle-accurate timing model
- DMA controller
- Additional peripherals (UART, SPI, I2C)
- Multi-core support

## Testing

Run teaching-mcu tests:

```bash
pnpm test packages/simulator/src/unified-ir/examples/teaching-mcu
```

Expected:

- 45 unit tests passing
- 12 integration tests passing
- 2 performance tests passing (with speedup validation)

## Related Files

- Main README: [../../README.md](../../README.md)
- Examples overview: [../README.md](../README.md)
- Compiler: [../../compiler/](../../compiler/)
- Runtime: [../../runtime/](../../runtime/)
