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

| Mode                      |             Rate |     Speedup |
| ------------------------- | ---------------: | ----------: |
| Teaching ISA, batch       |      486–505 M/s | ~2900–3300× |
| M3 ISA, batch             |      583–595 M/s | ~3400–3900× |
| Teaching ISA, single-step | 4.2–4.6 M tick/s |     ~25–28× |

Baseline: 0.13–0.18 M inst/s (scheduler-based architecture), i.e. ~1.6 µs per
guest instruction.

Both ISAs are far above the 72 M inst/s needed to emulate a 72 MHz classroom
board in real time. These numbers are observations only: the perf files are
excluded from `pnpm test` and run on demand with `pnpm test:perf`, and they
contain no thresholds or assertions (a busy machine must never fail a test).
Time-sliced simulation (`instructionsPerTick: 1000`,
see `bench/unified-devices.bench.ts`) reaches 390 M inst/s, and
[docs/PERFORMANCE.md](../../../../docs/PERFORMANCE.md) lists both methodologies.

### Reading these numbers

A _batch_ figure counts guest instructions retired per second of host time once
the machine is warm. The very first `tick()` of a fresh process is much slower
(≈0.1 M inst/s) because the host compiles the translated blocks and V8 has not
optimized the generated code; that cost is paid once per process. Per-tick
_latency_ is bounded below by the IR engine entry cost (~390 ns of
`jit.execute` bookkeeping), so the debugging path is ~600–700 ns per tick, not
per instruction.

## One block per dispatch

The provider translates exactly one guest basic block per artifact:
`decodeGuestBlock` decodes linearly from the fetch address and stops at the
first terminator (or when `maxBlockInstructions` is reached). The emitted IR
function holds that block's instructions, its terminator, the cycle-budget gate
and two exits — yield to the engine, or `dispatch` the successor.

A guest loop is therefore a chain of artifacts, and closing it is the engine's
job: the JIT's region compiler (`packages/ir/src/jit/region.ts`) fuses the hot
dispatch chain into one compiled function once an artifact has been entered
`REGION_THRESHOLD` (500) times. This example relies on that: a warm M3 loop
ticks at 1.00 dispatch per tick, which is what the removed provider-side
superblock translation used to achieve. `region-debug.test.ts` asserts that a
region is formed and reports the dispatch split with regions on and off, while
`region-performance.test.ts` reports the throughput without asserting it.

## Fusible edges and the tick checkpoint

Every artifact ends in one boundary block, not one per successor: the block's
own instructions run, its terminator picks the next PC **as a value**, and a
single gate compares the cycle counter against the slice budget. That shape has
two consequences the JIT relies on:

- the edge into the gate is a plain IR `jump` with no host boundary and no
  duplicated exit block, so the artifact structurizes (straight-line code plus
  one `if`) instead of falling back to a `switch (pc)` loop, and a region member
  re-entered from another member costs no dispatch;
- a dispatch stays _inside the tick_: it neither publishes the pin memory nor
  writes the step counter, because the host only observes those at a tick
  boundary.

The engine mirrors that with `checkpointGranularity` (see
`packages/ir/src/types.ts`). Under the default `'per-tick'` a region keeps
promoted storage (including constant-index register-file elements and the
constant-offset GPIO bytes), the step counter and the control flags in locals
across artifact boundaries, so the intermediate dispatches of a tick disappear
entirely; `'per-instruction'` turns that off for single-stepping debuggers.
Storage, epochs, the provider cache and the step count still match the reference
engine at the end of every tick, which is what the parity fuzzing compares.

```
        guest loop                        after warmup (one JIT region)
  ┌──────────────────────────┐      ┌────────────────────────────────────┐
  │ 0x0  MOVI r1, #0         │      │ artifact [0x0]  prologue           │
  │ 0x4  MOVI r2, #50        │  ──► │ artifact [0x8]  loop (self-loop)   │
  │ 0x8  ADDI r1, r1, #1     │      │ artifact [0x14] HALT               │
  │ 0xC  CMP  r1, r2         │      │                                    │
  │ 0x10 BNE  0x8            │      │ one host dispatch per tick         │
  │ 0x14 HALT                │      └────────────────────────────────────┘
  └──────────────────────────┘
```

A backward branch whose target is the artifact's own entry stays an IR loop
inside that artifact, which is why the tight loop retires 10⁵ guest
instructions per dispatch.

### Semantics kept by the one-block translation

- **Cycle accounting.** A block adds its own instruction count to `cycles` and
  stores the total when it exits.
- **Yield granularity.** The cycle budget (`sliceEnd`) is checked at every guest
  terminator, so one tick retires the same instructions as before.
- **Faults and yields.** `HALT`/`WFI`/`TFAULT` leave the artifact with the same
  `fault`, `halted`, `sleeping` and `pc` state.
- **Peripherals.** The teaching ISA latches `r0 & 1` into the ODR register after
  each block (guest-visible MMIO). The pin-memory publish — the part only the
  host can observe — happens when the artifact yields, i.e. once per tick
  instead of once per block.
- **Self-modifying code.** Guest stores cannot change the flash: writes below
  `flashSize` fault in `store32`/`store8`, and the flash image is a read-only
  `BytesRef`. A translated block therefore never goes stale.

The earlier window-CFG translation (`decodeGuestProgram`, the `superblock`
config option and `MICA_DISABLE_SUPERBLOCK`) has been removed; it is no longer
needed now that the engine fuses hot dispatch chains. `teaching-mcu.block-translator.test.ts`
pins the decoded block shape.

The translator also removed the last source of a latent host-code bug: a
single-definition constant could be emitted inline in the block that was
emitted _first_ while another block referenced it by name (tier-2 emits the
hottest case first), which produced `v17 is not defined`. The emitter now
reserves inlined values before any body is emitted.

## File Structure

```
teaching-mcu/
├── teaching-mcu.ts               # IR factory + block decoder
├── teaching-mcu.ac.ts            # Accessor builder
├── teaching-mcu.d.ts             # TypeScript types
├── teaching-mcu.errors.ts        # Error definitions
├── teaching-mcu.test-helpers.ts  # Test utilities (firmware builders, reference model)
├── teaching-mcu.test.ts          # Unit tests (46 tests)
├── teaching-mcu.integration.test.ts  # Integration tests (12 tests)
├── teaching-mcu.block-translator.test.ts  # Block decoding shape (9 tests)
├── region-debug.test.ts          # Region formation + dispatch diagnostics
├── region-performance.test.ts    # JIT region throughput (observation only)
├── teaching-mcu.performance.test.ts  # Performance observations (no assertions)
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

### One block per dispatch, loops closed by JIT regions

The hot path is a guest loop. One provider artifact covers one guest basic block,
so the loop is a chain of artifacts; the JIT's region compiler fuses that hot
dispatch chain into one compiled function (see
[One block per dispatch](#one-block-per-dispatch)). The example therefore needs
no provider-side fusion of its own: the former `superblock` option and
`MICA_DISABLE_SUPERBLOCK` switch are gone.

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
- **Performance observations**: Throughput numbers for humans; run with
  `pnpm test:perf`, print only, never assert (performance is not a test result)

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

- 46 unit tests passing
- 12 integration tests passing
- 9 translation tests passing (unit shape and fusion on/off parity)

The two `*performance*` files are observation-only benchmarks: they are
excluded from `pnpm test` (which must only verify correctness) and print their
numbers when you run `pnpm test:perf`.

## Related Files

- Main README: [../../README.md](../../README.md)
- Examples overview: [../README.md](../README.md)
- Compiler: [../../compiler/](../../compiler/)
- Runtime: [../../runtime/](../../runtime/)
