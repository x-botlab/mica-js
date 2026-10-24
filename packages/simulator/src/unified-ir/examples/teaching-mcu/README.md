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

`teaching-mcu.performance.test.ts` compares this device with the scheduler-based
`packages/device/examples/teaching-mcu` on the same machine. The batch figures
are steady-state medians (the host has translated the firmware and V8 has
tiered the generated code up):

| Mode                      |             Rate | Speedup |
| ------------------------- | ---------------: | ------: |
| Teaching ISA, batch       |      527–561 M/s |  ~3300× |
| M3 ISA, batch             |      449–465 M/s |  ~2900× |
| Teaching ISA, single-step | 3.6–4.1 M tick/s |    ~24× |

Baseline: 0.155–0.160 M inst/s (scheduler-based architecture), i.e. ~1.6 µs per
guest instruction.

Both ISAs are far above the 72 M inst/s needed to emulate a 72 MHz classroom
board in real time. Time-sliced simulation (`instructionsPerTick: 1000`, see
`bench/unified-devices.bench.ts`) reaches 390 M inst/s, and
[docs/PERFORMANCE.md](../../../../docs/PERFORMANCE.md) lists both methodologies.

### Reading these numbers

A _batch_ figure counts guest instructions retired per second of host time once
the machine is warm. The very first `tick()` of a fresh process is much slower
(≈0.1 M inst/s) because the host compiles the translated units and V8 has not
optimized the generated code; that cost is paid once per process and is
independent of the translator (it is identical with
`MICA_DISABLE_SUPERBLOCK=1`). Per-tick _latency_ is bounded below by the IR
engine entry cost (~390 ns of `jit.execute` bookkeeping), so the debugging path
is ~600–700 ns per tick, not per instruction.

## Superblock translation

One provider artifact would normally cover one guest basic block, so a guest
loop pays a provider dispatch (inline-cache probe, key normalization, tail
transfer, cycle-slice check) on every iteration. `decodeGuestProgram` instead
translates a whole _window_ of up to `maxBlockInstructions` instructions
(capped at 256) into a single unit:

1. The window is decoded linearly.
2. It is partitioned into guest basic blocks: a node starts at the window start,
   after every terminator and at every static branch target inside the window.
3. Only blocks reachable from the window start are emitted, in address order.
4. Edges whose target is inside the window become IR jumps — a backward edge is
   a plain IR loop, i.e. a JavaScript loop inside one compiled function. Edges
   that leave the window still `dispatch`, so the unit is observably identical
   to per-block translation.

```
        window from 0x0                       emitted unit
  ┌──────────────────────────┐        ┌────────────────────────────┐
  │ 0x0  MOVI r1, #0         │        │ node 0x0  (2 instr)        │
  │ 0x4  MOVI r2, #50        │  ───►  │   └─► node 0x8 (no check)  │
  │ 0x8  ADDI r1, r1, #1     │        │ node 0x8  (3 instr, BNE)   │
  │ 0xC  CMP  r1, r2         │        │   ├─ taken ──► node 0x8 ⟲  │
  │ 0x10 BNE  0x8            │        │   └─ fall  ──► node 0x14   │
  │ 0x14 HALT                │        │ node 0x14 (HALT)           │
  └──────────────────────────┘        └────────────────────────────┘
```

### Semantics that the fusion preserves

- **Cycle accounting.** Every node adds its own instruction count to a value
  threaded through the unit, so `cycles` stays exact.
- **Yield granularity.** The cycle budget (`sliceEnd`) is checked where a
  translated block used to end: at guest terminators and at the window end. A
  node that only ends because the next instruction is a branch target
  (`checksSlice: false`) continues straight through, so one tick retires the
  same instructions as before.
- **Faults and yields.** `fault`, `halted` and `yieldRequested` are observed at
  the same boundaries, and `HALT`/`WFI`/`TFAULT` leave the unit in the same
  state.
- **Peripherals.** `emitGpioBlockSync` runs on every unit exit instead of every
  block exit. Nothing inside a unit reads pin memory, so the host observes the
  same pin state.
- **Self-modifying code.** Guest stores cannot change the flash: writes below
  `flashSize` fault in `store32`/`store8`, and the flash image is a read-only
  `BytesRef`. A unit therefore never goes stale, and no invalidation is needed.

`decodeGuestProgram(..., fuse = false)` reproduces the original
one-block-per-dispatch translation and is used as the fallback:

```typescript
createTeachingMCUIR('mcu', { isa: 'm3', firmware, superblock: false });
```

or, for a whole process, `MICA_DISABLE_SUPERBLOCK=1`. `teaching-mcu.block-translator.test.ts`
pins the unit shape and asserts that both paths retire identical register,
memory, flag and pin state.

The translator also removed the last source of a latent host-code bug: a
single-definition constant could be emitted inline in the block that was
emitted _first_ while another block referenced it by name (tier-2 emits the
hottest case first), which produced `v17 is not defined`. The emitter now
reserves inlined values before any body is emitted.

## File Structure

```
teaching-mcu/
├── teaching-mcu.ts               # IR factory + superblock translator
├── teaching-mcu.ac.ts            # Accessor builder
├── teaching-mcu.d.ts             # TypeScript types
├── teaching-mcu.errors.ts        # Error definitions
├── teaching-mcu.test-helpers.ts  # Test utilities (firmware builders, reference model)
├── teaching-mcu.test.ts          # Unit tests (45 tests)
├── teaching-mcu.integration.test.ts  # Integration tests (12 tests)
├── teaching-mcu.block-translator.test.ts  # Translation shape + parity (9 tests)
├── teaching-mcu.performance.test.ts  # Performance benchmarks (2 tests)
├── index.ts                      # Public exports
└── README.md                     # This file
```

## Usage Example

```typescript
import { Circuit, createTeachingMCUIR, TEACHING_MCU_IR_TYPE } from '@mica-js/simulator';

const mcu = createTeachingMCUIR('mcu', {
  isa: 'm3', // or 'teaching'
  firmware: new Uint8Array([...]),
  instructionsPerTick: 1,
});

const circuit = await Circuit.create({
  devices: [{ id: 'mcu', type: TEACHING_MCU_IR_TYPE, description: mcu.device.description }],
  connections: [],
});

const guest = circuit.devices.mcu; // TeachingMCUAccessor

// Registers (r0–r15 plus pc/sp/lr/xpsr/cycles/ipsr)
guest.writeRegister('r0', 42);
guest.setPC(0x1000);
const r0 = guest.readRegister('r0');

// Execute: one tick retires `instructionsPerTick` instructions
circuit.step();
circuit.runBatch(1000);
guest.step(10); // accessor shortcut: 10 ticks on the same circuit

// Memory (unified address space, 4-byte or 1-byte access)
guest.writeMemoryBlock(0x2000_0000, new Uint8Array([1, 2, 3, 4]));
const data = guest.readMemoryBlock(0x2000_0000, 4);

// GPIO and NVIC
guest.writeGPIODirection('A', 0b1);
guest.writeGPIO('A', 0b1);
guest.enableInterrupt(5);
guest.raiseInterrupt(5);
```

## Design Decisions

### Superblock translation instead of one block per dispatch

The hot path is a guest loop, and one provider dispatch per basic block dominated
the cost. Units now span a whole decoding window and close guest loops inside
one compiled function (see [Superblock translation](#superblock-translation)).
`superblock: false` / `MICA_DISABLE_SUPERBLOCK=1` restores the per-block
translation, which the parity tests keep working.

### Single-block exception handling

Original design used block parameters for exception entry/return. Discovered JIT GVN miscompile in certain block-parameter paths (`vN is not defined`). Workaround: use single-block ISR bodies and remove block params from exception sequences. The root cause (inlined constants registered after a use had already been emitted) is now fixed in the emitter, so the workaround is no longer required; ISR sequences keep their flatter shape because it is cheaper.

### Unified memory map

Flash (0x0000-0x7FFF) and RAM (0x8000-0xFFFF) share single address space. Provider blocks handle flash (read-only, patchable), typed arrays handle RAM (writable).

### Instruction counting

`cycles` field counts retired instructions, not clock cycles. Exception entry charges configurable `exceptionCycles` (default 12).

### GPIO mapping

Legacy `GPIO` pin becomes `PA0`. Full GPIO ports PA/PB with 16 pins each.

## Implementation Notes

### Instruction decode

Device kernel generates:

1. **Instruction decode**: fetch a window of `maxBlockInstructions` instructions, partition it into guest basic blocks, keep the reachable ones and emit one IR block per guest block (loops inside the window become IR loops)
2. **Register operations**: Arithmetic, logic, shifts
3. **Memory access**: Load/store with address translation
4. **Branch/call**: PC updates, link register management
5. **Exception handling**: Vector fetch, stack push/pop, mode transitions
6. **GPIO access**: Memory-mapped peripheral reads/writes
7. **NVIC**: Interrupt pending/enable/priority management

### Accessor API

`TeachingMCUAccessor` provides:

- **Registers**: `readRegister(name | index)`, `writeRegister(name | index, value)`, `getPC` / `setPC`, `getSP` / `setSP`, `getLR` / `setLR`, `getCycles`, `getFlags`
- **Memory**: `readMemory(addr, width)`, `writeMemory(addr, value, width)`, `readMemoryBlock(addr, len)`, `writeMemoryBlock(addr, bytes)`, `patchFirmware(addr, bytes)`
- **GPIO**: `readGPIO(port)`, `writeGPIO(port, value)`, `readGPIOInput(port)`, `readGPIODirection(port)`, `writeGPIODirection(port, mask)`
- **NVIC**: `enableInterrupt(n)`, `disableInterrupt(n)`, `raiseInterrupt(n)`, `clearInterrupt(n)`, `isInterruptPending(n)`, `isInterruptActive(n)`, `readInterruptRegisters()`
- **Execution**: `step(count?)`, `run(count)` (ticks on the owning circuit)
- **Introspection**: `snapshot()`, `isHalted()`, `isFaulted()`, `isSleeping()`

### Test Strategy

- **Unit tests**: Instruction semantics, register/memory operations, GPIO/NVIC
- **Integration tests**: Multi-instruction programs, interrupt handling, Circuit API
- **Performance tests**: Throughput benchmarks, validate speedup targets

### Known Limitations

- No cycle-accurate timing (instruction counting only)
- Limited M3 instruction subset (common ops only)
- No MPU, SysTick, or debug features
- Exception priorities simplified (fixed order)
- The unit window is capped at 256 instructions, so a hot loop larger than that
  still pays one dispatch per window (measured at 390 M inst/s for the
  time-sliced blinky firmware, so the cap only matters for very large loops)
- Condition flags are still computed eagerly: a `CMP` stores all four NZCV bits
  even when the next consumer only reads `Z`. Skipping that needs a lazy-flag
  scheme threaded through the unit and is not implemented.

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
- 9 translation tests passing (unit shape and fusion on/off parity)
- 2 performance tests passing (steady-state throughput and the 72 M inst/s budget)

## Related Files

- Main README: [../../README.md](../../README.md)
- Examples overview: [../README.md](../README.md)
- Compiler: [../../compiler/](../../compiler/)
- Runtime: [../../runtime/](../../runtime/)
