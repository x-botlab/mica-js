/**
 * STM32G431 memory bus and peripheral model for the benchmark MCU.
 *
 * The module owns three things:
 *
 * 1. `registerBus(d, { cyclePs })` declares the peripheral state, the SysTick timer
 *    process, the GPIO drive reaction, the `gpioChanged` output channel and the
 *    `supply` / `reference` / `pa5` pins on a device definition the parent owns. The
 *    caller declares `code` (Flash, `FLASH_SIZE` bytes) and `ram` (public SRAM,
 *    `SRAM_SIZE` bytes) memories before calling it.
 * 2. `emitLoad` / `emitStore` turn one CPU bus access into canonical IR inside the
 *    caller's instruction body. Nothing is emulated by host JavaScript at run time:
 *    the address decode is a chain of IR branches and assertions.
 * 3. `busInitialState` is the single source of truth for the peripheral state names and
 *    their reset values; the parent uses it to lay out its diagnostic snapshot.
 *
 * Access contract (deliberately narrow, every other case fails fast through `b.assert`):
 *
 * - Flash (`0x08000000`, 128 KiB) is the `code` memory; reads only.
 * - SRAM (`0x20000000`, 32 KiB) is the `ram` memory; reads and writes.
 * - Normal memory accepts 1, 2 and 4 byte accesses and unaligned addresses, matching
 *   Cortex-M4 normal memory rules. The `bytes` profile (default) assembles every access
 *   from byte ops, which the direct JIT supports today; the `wide` profile uses
 *   `load16le` / `load32le` / `store16le` / `store32le` for 2 and 4 byte accesses, which
 *   makes those blocks fall out of today's direct JIT and is used to A/B issue #254.
 * - MMIO accepts aligned 32-bit accesses only; byte, half-word or unaligned MMIO access
 *   fails fast, as does Flash writing and any unmapped address.
 * - An access that starts inside a region but crosses its end fails fast instead of
 *   silently wrapping.
 *
 * Peripheral support is limited to the registers the benchmark needs: GPIOA MODER, IDR,
 * ODR and BSRR gated by RCC AHB2ENR.GPIOAEN, SysTick CTRL, LOAD and VAL, SCB ICSR
 * (PENDSTSET / PENDSTCLR) and SCB VTOR. Every other GPIOA / SysTick / SCB register
 * fails fast by address, so a firmware that needs one has to extend this table.
 *
 * GPIO boundary: only PA5 has an electrical driver. `gpioDrive` (0 low, 1 high, 2 high-Z)
 * depends on RCC.GPIOAEN, MODER[11:10] and ODR[5], and the `drivePa5` reaction applies a
 * 25 ohm branch to `supply` / `reference` or releases the pin with an empty intent, so a
 * clock or mode change re-drives the pin without an ODR write. Every accepted ODR or
 * BSRR write publishes the full 16-bit ODR latch on the `gpioChanged` output channel
 * (also when the value did not change). IDR mirrors the ODR latch for PA5 while PA5 is a
 * general purpose output, reads the solved pin level otherwise, and mirrors the ODR bit
 * of every other pin - this model has no external drivers for them.
 */
import { types } from '../../../device-model/dist/index.js';
import {
  DEFAULT_CYCLE_PS,
  FLASH_BASE,
  FLASH_SIZE,
  GPIOA_BASE,
  RCC_AHB2ENR,
  SCB_ICSR,
  SCB_VTOR,
  SRAM_BASE,
  SRAM_SIZE,
  SYSTICK_BASE,
} from './constants.mjs';

const GPIOA_MODER = GPIOA_BASE + 0x00;
const GPIOA_IDR = GPIOA_BASE + 0x10;
const GPIOA_ODR = GPIOA_BASE + 0x14;
const GPIOA_BSRR = GPIOA_BASE + 0x18;
const SYSTICK_CTRL = SYSTICK_BASE + 0x00;
const SYSTICK_LOAD = SYSTICK_BASE + 0x04;
const SYSTICK_VAL = SYSTICK_BASE + 0x08;

const GPIOAEN = 0x1;
const SYSTICK_ENABLE = 0x1;
const SYSTICK_TICKINT = 0x2;
const SYSTICK_CLKSOURCE = 0x4;
const SYSTICK_COUNTFLAG_SHIFT = 16;
const ICSR_PENDSTSET = 0x04000000;
const ICSR_PENDSTCLR = 0x02000000;

/** PA5: bit 5 of the ODR / IDR, MODER bits [11:10]. */
export const PA5_BIT = 0x20;
const PA5_MODER_SHIFT = 10;

/**
 * `gpioDrive` encoding: the reaction drives the pin from the ODR latch only while GPIOA
 * is clocked and PA5 is a general purpose output, and releases it (high-Z) otherwise.
 */
export const GPIO_DRIVE = Object.freeze({ low: 0, high: 1, floating: 2 });

/** Register address table; the order is the dynamic-decode branch order. */
export const MMIO = Object.freeze({
  gpioModer: GPIOA_MODER,
  gpioIdr: GPIOA_IDR,
  gpioOdr: GPIOA_ODR,
  gpioBsrr: GPIOA_BSRR,
  rccAhb2enr: RCC_AHB2ENR,
  systickCtrl: SYSTICK_CTRL,
  systickLoad: SYSTICK_LOAD,
  systickVal: SYSTICK_VAL,
  scbIcsr: SCB_ICSR,
  scbVtor: SCB_VTOR,
});
const MMIO_REGISTERS = Object.freeze(Object.keys(MMIO));
const MMIO_BY_ADDRESS = new Map(MMIO_REGISTERS.map((name) => [MMIO[name], name]));

/** Normal-memory regions, searched in this order by the dynamic decode. */
export const MEMORY_MAP = Object.freeze([
  Object.freeze({ name: 'flash', memory: 'code', base: FLASH_BASE, size: FLASH_SIZE }),
  Object.freeze({ name: 'sram', memory: 'ram', base: SRAM_BASE, size: SRAM_SIZE }),
]);
const [FLASH_REGION, SRAM_REGION] = MEMORY_MAP;

/**
 * Reset values for every peripheral state. `irqPending` is the only bool; everything else
 * is a number so the parent can snapshot it with `store32le`.
 *
 * Notes:
 * - `gpioModer` starts at the RM0440 GPIOA_MODER reset value, which leaves PA5 in
 *   alternate-function mode, so the pin starts floating.
 * - `systickArmedAt` is the board time (ps) of the last counter restart (the enabling
 *   CTRL write, or a VAL write). The timer process derives its next reload from it, so a
 *   reference oracle only needs the write time it already tracks.
 * - `systickVal` and `systickCountflag` are reload-granularity: VAL holds the reload
 *   value from the last reload until the next one, and nothing decrements it between
 *   reloads (that would need per-cycle polling). COUNTFLAG is 1 until the next CTRL or
 *   VAL read/write clears it.
 */
export const busInitialState = Object.freeze({
  gpioModer: 0xffffebff,
  gpioOdr: 0,
  rccAhb2enr: 0,
  systickCtrl: 0,
  systickReload: 0,
  systickVal: 0,
  systickCountflag: 0,
  systickTicks: 0,
  systickArmedAt: 0,
  irqPending: false,
  vtor: FLASH_BASE,
});

/** Every state declared by `registerBus`, in `busInitialState` order. */
export const snapshotStateNames = Object.freeze(Object.keys(busInitialState));

const hex = (value) => `0x${value.toString(16)}`;

function checkWidth(width, operation, address) {
  if (width !== 1 && width !== 2 && width !== 4)
    throw new RangeError(
      `${operation} width ${String(width)} is not supported; use 1, 2 or 4 (${
        typeof address === 'number' ? hex(address) : 'dynamic address'
      })`,
    );
}

function regionOf(address) {
  return MEMORY_MAP.find((region) => address >= region.base && address < region.base + region.size);
}

function normalizeAccess(options) {
  if (options === undefined) return Object.freeze({ memoryAccess: 'bytes' });
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Bus access options must be an object');
  const { memoryAccess = 'bytes' } = options;
  if (memoryAccess !== 'bytes' && memoryAccess !== 'wide')
    throw new RangeError(
      `memoryAccess must be 'bytes' or 'wide', received ${String(memoryAccess)}`,
    );
  return Object.freeze({ memoryAccess });
}

function normalizePeripheralOptions(options) {
  if (options === undefined) return Object.freeze({ cyclePs: DEFAULT_CYCLE_PS });
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Bus options must be an object');
  for (const key of Object.keys(options))
    if (key !== 'cyclePs') throw new TypeError(`Unknown bus option: ${key}`);
  const { cyclePs = DEFAULT_CYCLE_PS } = options;
  if (!Number.isSafeInteger(cyclePs) || cyclePs < 1)
    throw new RangeError('cyclePs must be a positive safe integer');
  return Object.freeze({ cyclePs });
}

const unsigned32 = (b, value) => b.shiftRightUnsigned(value, 0);
const constant = (b, value) => b.constant(types.number, value);
const atOffset = (b, offset, delta) =>
  typeof offset === 'number' ? offset + delta : b.add(offset, delta);

function assertFalse(b, message) {
  b.assert(b.constant(types.bool, false), (c) => c.constant(types.string, message));
}

function emitMemoryLoad(b, memory, offset, width, profile) {
  if (width === 1) return b.load8(memory, offset);
  if (profile.memoryAccess === 'wide')
    return width === 2 ? b.load16le(memory, offset) : b.load32le(memory, offset);
  let value = b.load8(memory, offset);
  for (let index = 1; index < width; index++)
    value = b.bitOr(value, b.shiftLeft(b.load8(memory, atOffset(b, offset, index)), index * 8));
  return unsigned32(b, value);
}

function emitMemoryStore(b, memory, offset, value, width, profile) {
  if (width === 1) {
    b.store8(memory, offset, b.bitAnd(value, 0xff));
    return;
  }
  if (profile.memoryAccess === 'wide') {
    if (width === 2) b.store16le(memory, offset, b.bitAnd(value, 0xffff));
    else b.store32le(memory, offset, value);
    return;
  }
  for (let index = 0; index < width; index++)
    b.store8(
      memory,
      atOffset(b, offset, index),
      b.bitAnd(b.shiftRightUnsigned(value, index * 8), 0xff),
    );
}

const gpioClockOn = (b) =>
  b.notEqual(types.number, b.bitAnd(b.readState('rccAhb2enr', types.number), GPIOAEN), 0);

const gated = (b, read) =>
  b.select(
    types.number,
    gpioClockOn(b),
    (c) => read(c),
    (c) => c.constant(types.number, 0),
  );

function emitRegisterLoad(b, register) {
  switch (register) {
    case 'gpioModer':
      return gated(b, (c) => c.readState('gpioModer', types.number));
    case 'gpioIdr':
      return gated(b, (c) => c.readDerived('gpioaIdr', types.number));
    case 'gpioOdr':
      return gated(b, (c) => c.readState('gpioOdr', types.number));
    case 'gpioBsrr':
      return constant(b, 0);
    case 'rccAhb2enr':
      return b.readState('rccAhb2enr', types.number);
    case 'systickCtrl': {
      const value = b.bitOr(
        b.readState('systickCtrl', types.number),
        b.shiftLeft(b.readState('systickCountflag', types.number), SYSTICK_COUNTFLAG_SHIFT),
      );
      b.writeState('systickCountflag', 0);
      return value;
    }
    case 'systickLoad':
      return b.readState('systickReload', types.number);
    case 'systickVal': {
      const value = b.readState('systickVal', types.number);
      b.writeState('systickCountflag', 0);
      return value;
    }
    case 'scbIcsr':
      return b.select(
        types.number,
        b.readState('irqPending', types.bool),
        (c) => c.constant(types.number, ICSR_PENDSTSET),
        (c) => c.constant(types.number, 0),
      );
    case 'scbVtor':
      return b.readState('vtor', types.number);
    default:
      throw new Error(`Unhandled STM32G431 register read: ${register}`);
  }
}

function writeOdr(b, next) {
  b.if(gpioClockOn(b), (c) => {
    c.writeState('gpioOdr', next);
    c.send('gpioChanged', next);
  });
}

function emitRegisterStore(b, register, value) {
  switch (register) {
    case 'gpioModer':
      b.if(gpioClockOn(b), (c) => c.writeState('gpioModer', unsigned32(c, value)));
      return;
    case 'gpioIdr':
      // Read-only in hardware: the write is ignored instead of failing the board.
      return;
    case 'gpioOdr':
      writeOdr(b, b.bitAnd(value, 0xffff));
      return;
    case 'gpioBsrr': {
      // Low half sets, high half resets; set wins when a bit is written to both halves.
      const set = b.bitAnd(value, 0xffff);
      const reset = b.bitAnd(b.shiftRightUnsigned(value, 16), 0xffff);
      const next = b.bitAnd(
        b.bitOr(b.bitAnd(b.readState('gpioOdr', types.number), b.bitNot(reset)), set),
        0xffff,
      );
      writeOdr(b, next);
      return;
    }
    case 'rccAhb2enr':
      b.writeState('rccAhb2enr', unsigned32(b, value));
      return;
    case 'systickCtrl': {
      const next = b.bitAnd(value, SYSTICK_ENABLE | SYSTICK_TICKINT | SYSTICK_CLKSOURCE);
      const wasEnabled = b.notEqual(
        types.number,
        b.bitAnd(b.readState('systickCtrl', types.number), SYSTICK_ENABLE),
        0,
      );
      const enabling = b.and(
        b.equal(types.number, b.bitAnd(next, SYSTICK_ENABLE), SYSTICK_ENABLE),
        (c) => c.not(wasEnabled),
      );
      b.writeState('systickCtrl', next);
      b.writeState('systickCountflag', 0);
      // The counter restarts on the 0 -> 1 ENABLE transition, so the first reload lands
      // exactly `(reload + 1) * cyclePs` after this write.
      b.if(enabling, (c) => c.writeState('systickArmedAt', c.now()));
      return;
    }
    case 'systickLoad':
      b.writeState('systickReload', b.bitAnd(value, 0xffffff));
      return;
    case 'systickVal':
      b.writeState('systickVal', 0);
      b.writeState('systickCountflag', 0);
      // Writing VAL restarts the count from zero.
      b.writeState('systickArmedAt', b.now());
      return;
    case 'scbIcsr': {
      const pendstset = b.equal(types.number, b.bitAnd(value, ICSR_PENDSTSET), ICSR_PENDSTSET);
      const pendstclr = b.equal(types.number, b.bitAnd(value, ICSR_PENDSTCLR), ICSR_PENDSTCLR);
      b.if(
        pendstset,
        (c) => c.writeState('irqPending', true),
        (c) => c.if(pendstclr, (d) => d.writeState('irqPending', false)),
      );
      return;
    }
    case 'scbVtor':
      b.writeState('vtor', unsigned32(b, value));
      return;
    default:
      throw new Error(`Unhandled STM32G431 register write: ${register}`);
  }
}

function emitMmioLoad(b, register, width, address) {
  if (width !== 4 || (typeof address === 'number' && address % 4 !== 0))
    throw new RangeError(
      `MMIO read at ${hex(address)} must be an aligned 32-bit access, received width ${width}`,
    );
  return emitRegisterLoad(b, register);
}

function emitMmioStore(b, register, value, width, address) {
  if (width !== 4 || (typeof address === 'number' && address % 4 !== 0))
    throw new RangeError(
      `MMIO write at ${hex(address)} must be an aligned 32-bit access, received width ${width}`,
    );
  emitRegisterStore(b, register, value);
}

/** A register-sized window that starts at an aligned address and covers `address`. */
function misalignedRegister(address) {
  return MMIO_BY_ADDRESS.get(address - (address % 4));
}

function staticLoad(b, address, width, profile) {
  const region = regionOf(address);
  if (region) {
    if (address + width > region.base + region.size)
      throw new RangeError(
        `${region.name} read at ${hex(address)} of ${width} byte(s) crosses the end of the region`,
      );
    return emitMemoryLoad(b, region.memory, address - region.base, width, profile);
  }
  const register = MMIO_BY_ADDRESS.get(address);
  if (register) return emitMmioLoad(b, register, width, address);
  const misaligned = misalignedRegister(address);
  if (misaligned)
    throw new RangeError(
      `MMIO read of register ${misaligned} at ${hex(address)} must be an aligned 32-bit access`,
    );
  throw new RangeError(`Unmapped STM32G431 bus read at ${hex(address)} (width ${width})`);
}

function staticStore(b, address, value, width, profile) {
  const region = regionOf(address);
  if (region) {
    if (region.name === 'flash')
      throw new RangeError(`Flash is read-only; refused write at ${hex(address)}`);
    if (address + width > region.base + region.size)
      throw new RangeError(
        `${region.name} write at ${hex(address)} of ${width} byte(s) crosses the end of the region`,
      );
    emitMemoryStore(b, region.memory, address - region.base, value, width, profile);
    return;
  }
  const register = MMIO_BY_ADDRESS.get(address);
  if (register) {
    emitMmioStore(b, register, value, width, address);
    return;
  }
  const misaligned = misalignedRegister(address);
  if (misaligned)
    throw new RangeError(
      `MMIO write of register ${misaligned} at ${hex(address)} must be an aligned 32-bit access`,
    );
  throw new RangeError(`Unmapped STM32G431 bus write at ${hex(address)} (width ${width})`);
}

const inRegion = (b, address, region) =>
  b.and(b.greaterThanOrEqual(address, region.base), (c) =>
    c.lessThan(address, region.base + region.size),
  );

const withinRegion = (b, address, region, width) =>
  b.lessThanOrEqual(address, region.base + region.size - width);

const unmapped = (b, operation, width) =>
  assertFalse(
    b,
    `STM32G431 bus: unmapped ${operation} (width ${width}); extend the register table`,
  );

function registerChain(index, emit) {
  return (c) => {
    if (index >= MMIO_REGISTERS.length) {
      emit.unmapped(c);
      return;
    }
    const register = MMIO_REGISTERS[index];
    c.if(
      c.equal(types.number, emit.aligned, MMIO[register]),
      (d) => {
        if (emit.width !== 4) {
          assertFalse(d, `STM32G431 MMIO: register ${register} requires a 32-bit access`);
          return;
        }
        d.assert(d.equal(types.number, d.remainder(emit.address, 4), 0), (e) =>
          e.constant(types.string, `STM32G431 MMIO: register ${register} is unaligned`),
        );
        emit.register(d, register);
      },
      registerChain(index + 1, emit),
    );
  };
}

function dynamicLoad(b, address, width, profile) {
  const result = b.local(types.number, 0);
  const register = (c, name) => c.setLocal(result, emitRegisterLoad(c, name));
  const emit = {
    address,
    aligned: b.subtract(address, b.remainder(address, 4)),
    width,
    register,
    unmapped: (c) => unmapped(c, 'read', width),
  };
  b.if(
    inRegion(b, address, FLASH_REGION),
    (c) => {
      c.assert(withinRegion(c, address, FLASH_REGION, width), (d) =>
        d.constant(types.string, 'STM32G431 Flash: read crosses the end of the region'),
      );
      c.setLocal(
        result,
        emitMemoryLoad(c, 'code', c.subtract(address, FLASH_REGION.base), width, profile),
      );
    },
    (c) =>
      c.if(
        inRegion(c, address, SRAM_REGION),
        (d) => {
          d.assert(withinRegion(d, address, SRAM_REGION, width), (e) =>
            e.constant(types.string, 'STM32G431 SRAM: read crosses the end of the region'),
          );
          d.setLocal(
            result,
            emitMemoryLoad(d, 'ram', d.subtract(address, SRAM_REGION.base), width, profile),
          );
        },
        registerChain(0, emit),
      ),
  );
  return b.getLocal(result);
}

function dynamicStore(b, address, value, width, profile) {
  const emit = {
    address,
    aligned: b.subtract(address, b.remainder(address, 4)),
    width,
    register: (c, name) => emitRegisterStore(c, name, value),
    unmapped: (c) => unmapped(c, 'write', width),
  };
  b.if(
    inRegion(b, address, FLASH_REGION),
    (c) => assertFalse(c, 'STM32G431 Flash: writes are not modelled (fail-fast)'),
    (c) =>
      c.if(
        inRegion(c, address, SRAM_REGION),
        (d) => {
          d.assert(withinRegion(d, address, SRAM_REGION, width), (e) =>
            e.constant(types.string, 'STM32G431 SRAM: write crosses the end of the region'),
          );
          emitMemoryStore(d, 'ram', d.subtract(address, SRAM_REGION.base), value, width, profile);
        },
        registerChain(0, emit),
      ),
  );
}

const DEFAULT_ACCESS = normalizeAccess();

/** Emit one CPU load; `address` is a literal or a Builder `Value<number>`. */
export function emitLoad(b, address, width) {
  return load(b, address, width, DEFAULT_ACCESS);
}

/** Emit one CPU store; `address` is a literal or a Builder `Value<number>`. */
export function emitStore(b, address, value, width) {
  store(b, address, value, width, DEFAULT_ACCESS);
}

/**
 * Bind an access profile. `bytes` (default) keeps every access on byte ops, `wide` uses
 * the canonical 16/32-bit ops for 2 and 4 byte normal-memory accesses so the same model
 * can measure the #254 direct-JIT gap.
 */
export function createBusAccess(options) {
  const profile = normalizeAccess(options);
  return Object.freeze({
    memoryAccess: profile.memoryAccess,
    emitLoad: (b, address, width) => load(b, address, width, profile),
    emitStore: (b, address, value, width) => store(b, address, value, width, profile),
  });
}

function load(b, address, width, profile) {
  checkWidth(width, 'read', address);
  if (typeof address === 'number') {
    if (!Number.isSafeInteger(address) || address < 0)
      throw new RangeError(`Bus address must be a non-negative safe integer, received ${address}`);
    return staticLoad(b, address, width, profile);
  }
  return dynamicLoad(b, address, width, profile);
}

function store(b, address, value, width, profile) {
  checkWidth(width, 'write', address);
  if (typeof address === 'number') {
    if (!Number.isSafeInteger(address) || address < 0)
      throw new RangeError(`Bus address must be a non-negative safe integer, received ${address}`);
    staticStore(b, address, value, width, profile);
    return;
  }
  dynamicStore(b, address, value, width, profile);
}

/**
 * Declare the peripheral half of the device. The caller owns `code` (Flash,
 * `FLASH_SIZE` bytes) and `ram` (public SRAM, `SRAM_SIZE` bytes) memories, `pc`, the
 * core registers and the JIT binding.
 *
 * Timing contract:
 * - The first reload after an enabling CTRL write lands exactly `(reload + 1) * cyclePs`
 *   after that write; `systickArmedAt` records the write time so the timer process can
 *   subtract the delay between the store and the following board boundary.
 * - Every later reload is `(reload + 1) * cyclePs` after the previous reload, using the
 *   reload value read at that reload, so a LOAD write takes effect at the next reload.
 * - A VAL write restarts the count from zero and clears COUNTFLAG, exactly like the
 *   enabling CTRL write: the next reload lands `(reload + 1) * cyclePs` after the write.
 * - A `wait` is never preempted. A CTRL or VAL write while a wait is pending re-anchors
 *   `systickArmedAt`; the pending wait ends at its original deadline, the loop notices
 *   `now() < deadline` and waits again instead of raising a reload.
 * - A disable observed at a reload boundary ends the timer process; the next enabling
 *   CTRL write starts it again from the reload boundary of that write.
 * - CLKSOURCE selects the cyclePs clock (the only clock modelled); the /8 prescaler is
 *   not modelled.
 * - COUNTFLAG is set at every reload (also without TICKINT) and cleared by reading CTRL
 *   or VAL and by writing CTRL or VAL. TICKINT additionally raises the SysTick
 *   exception by setting `irqPending`, which stays set until the CPU services it or a
 *   PENDSTCLR ICSR write clears it.
 */
export function registerBus(d, options) {
  const { cyclePs } = normalizePeripheralOptions(options);
  for (const [name, initial] of Object.entries(busInitialState))
    d.state({
      name,
      type: typeof initial === 'boolean' ? types.bool : types.number,
      initial,
    });

  d.pin({ name: 'supply' });
  d.pin({ name: 'reference' });
  d.pin({ name: 'pa5', low: 0.8, high: 2.0 });
  // Every accepted ODR/BSRR write publishes the 16-bit ODR latch here; the adapter drains
  // the channel on every batch, so the capacity only has to cover one run slice.
  d.channel({ name: 'gpioChanged', direction: 'output', type: types.number, capacity: 4096 });

  d.derived({ name: 'pa5OutputEnabled', type: types.bool }, (b) =>
    b.returnValue(
      b.and(
        b.equal(types.number, b.bitAnd(b.readState('rccAhb2enr', types.number), GPIOAEN), GPIOAEN),
        (c) =>
          c.equal(
            types.number,
            c.bitAnd(
              c.shiftRightUnsigned(c.readState('gpioModer', types.number), PA5_MODER_SHIFT),
              3,
            ),
            1,
          ),
      ),
    ),
  );

  d.derived({ name: 'gpioDrive', type: types.number }, (b) => {
    const latch = b.bitAnd(b.shiftRightUnsigned(b.readState('gpioOdr', types.number), 5), 1);
    b.returnValue(
      b.select(
        types.number,
        b.readDerived('pa5OutputEnabled', types.bool),
        () => latch,
        () => GPIO_DRIVE.floating,
      ),
    );
  });

  d.derived({ name: 'gpioaIdr', type: types.number }, (b) => {
    const odr = b.readState('gpioOdr', types.number);
    const output = b.equal(
      types.number,
      b.bitAnd(b.shiftRightUnsigned(b.readState('gpioModer', types.number), PA5_MODER_SHIFT), 3),
      1,
    );
    const high = b.equal(
      types.logic,
      b.field(b.readSample('pa5'), 'level'),
      types.logic.members.high,
    );
    // PA5 mirrors the ODR latch while it is a general purpose output and the solved pin
    // level otherwise; every other IDR bit mirrors its ODR bit, which is the documented
    // boundary of this single-pin GPIO model (only PA5 has an electrical driver).
    const pa5 = b.select(
      types.number,
      output,
      (c) => c.bitAnd(c.shiftRightUnsigned(odr, 5), 1),
      (c) =>
        c.select(
          types.number,
          high,
          () => 1,
          () => 0,
        ),
    );
    const idr = b.bitOr(b.bitAnd(odr, 0xffff & ~PA5_BIT), b.shiftLeft(pa5, 5));
    b.returnValue(
      b.select(
        types.number,
        b.equal(types.number, b.bitAnd(b.readState('rccAhb2enr', types.number), GPIOAEN), GPIOAEN),
        () => idr,
        () => 0,
      ),
    );
  });

  d.reaction(
    {
      name: 'drivePa5',
      sourcePath: ['gpioDrive'],
      sourceType: types.number,
      previous: 'pa5DrivePrevious',
      current: 'pa5DriveCurrent',
      captures: [],
    },
    {},
    (b, { current }) => {
      b.if(
        b.equal(types.number, current, GPIO_DRIVE.high),
        (c) => c.writeIntent('pa5', c.resistor('supply', 25)),
        (c) =>
          c.if(
            c.equal(types.number, current, GPIO_DRIVE.low),
            (d) => d.writeIntent('pa5', d.resistor('reference', 25)),
            (d) => d.writeIntent('pa5', d.combineIntents()),
          ),
      );
    },
  );

  d.on({ name: 'systickTimer', sourcePath: ['systickCtrl'] }, (b) => {
    b.loop((c) => {
      const period = c.multiply(c.add(c.readState('systickReload', types.number), 1), cyclePs);
      const deadline = c.add(c.readState('systickArmedAt', types.number), period);
      const remaining = c.subtract(deadline, c.now());
      c.if(
        c.greaterThan(remaining, 0),
        (e) => e.wait(remaining),
        (e) => {
          const control = () => e.readState('systickCtrl', types.number);
          e.if(
            e.not(e.equal(types.number, e.bitAnd(control(), SYSTICK_ENABLE), SYSTICK_ENABLE)),
            (f) => f.return(),
          );
          const reload = e.readState('systickReload', types.number);
          e.writeState('systickVal', reload);
          e.writeState('systickCountflag', 1);
          e.writeState('systickTicks', e.add(e.readState('systickTicks', types.number), 1));
          e.if(e.equal(types.number, e.bitAnd(control(), SYSTICK_TICKINT), SYSTICK_TICKINT), (f) =>
            f.writeState('irqPending', true),
          );
          e.writeState('systickArmedAt', deadline);
        },
      );
    });
  });
}
