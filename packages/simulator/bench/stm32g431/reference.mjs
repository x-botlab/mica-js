/**
 * Independent host reference machine for the STM32G431 Thumb fixtures.
 *
 * This model exists to cross-check the real CPU/bus implementation: it never
 * touches the Builder, the compiler or a device model. It decodes raw Thumb
 * bytes itself, applies cycle costs from the fixture timing contract and keeps
 * its own GPIO/SysTick/RCC bookkeeping so a CPI/MIPS signature can be compared.
 *
 * Timing contract (the STM32G431 bench contract):
 *   - guest instructions start while `time < target`; effects are applied when
 *     the instruction starts and the PC moves to `nextPc` first,
 *   - an instruction that finishes at or after `target` starts no successor,
 *   - ALU 1, load/store 2, taken branch 3, not-taken 1, push/pop regs+1,
 *     exception entry / exception return 12 cycles,
 *   - SysTick events at exactly `target` are visible in that snapshot.
 *
 * Snapshots mirror the fixture capture: `pa5Level` (also `states.pa5.level`)
 * is 0 (low), 1 (high) or 2 (floating: input/alternate mode or GPIOA clock
 * off). `gpioEdges` holds electrical 0/1 changes with floating treated as low,
 * and `gpioWrites` holds ODR/BSRR writes only; both are stamped with absolute
 * ps time and cycle count. `states.pc` is the next instruction (even address)
 * and `cycles` is the requested target expressed in cycles.
 *
 * createReference({ firmware, cyclePs = 10000 }) -> { advance(ps), snapshot() }
 * `firmware` is a Uint8Array/ArrayBuffer/Array of flash bytes or an object
 * `{ bytes, entry?, initialSp?, vtor? }` carrying the 0x08000000 image.
 */

import {
  DEFAULT_CYCLE_PS,
  EXC_RETURN,
  FLASH_BASE,
  FLASH_SIZE,
  GPIOA_BASE,
  RCC_AHB2ENR,
  RESET_PC,
  SCB_ICSR,
  SCB_VTOR,
  SRAM_BASE,
  SRAM_SIZE,
  STACK_TOP,
  SYSTICK_BASE,
} from './constants.mjs';

const PERIPHERAL_LIMIT = 0xe0100000;
const FLASH_END = FLASH_BASE + FLASH_SIZE;
const SRAM_END = SRAM_BASE + SRAM_SIZE;

const CYCLES_ALU = 1;
const CYCLES_LOAD_STORE = 2;
const CYCLES_BRANCH_TAKEN = 3;
const CYCLES_BRANCH_NOT_TAKEN = 1;
const CYCLES_EXCEPTION = 12;

const SYSTICK_CTRL = SYSTICK_BASE;
const SYSTICK_LOAD = SYSTICK_BASE + 0x04;
const SYSTICK_VAL = SYSTICK_BASE + 0x08;
const SYSTICK_CALIB = SYSTICK_BASE + 0x0c;

const GPIOA_MODER = GPIOA_BASE + 0x00;
const GPIOA_OTYPER = GPIOA_BASE + 0x04;
const GPIOA_OSPEEDR = GPIOA_BASE + 0x08;
const GPIOA_PUPDR = GPIOA_BASE + 0x0c;
const GPIOA_IDR = GPIOA_BASE + 0x10;
const GPIOA_ODR = GPIOA_BASE + 0x14;
const GPIOA_BSRR = GPIOA_BASE + 0x18;
const GPIOA_LCKR = GPIOA_BASE + 0x1c;
const GPIOA_AFR = GPIOA_BASE + 0x20;
const GPIO_END = GPIOA_BASE + 0x400;

const RCC_BASE = 0x40021000;
const RCC_END = 0x40022000;
const SCB_BASE = 0xe000ed00;
const SCB_END = 0xe000ee00;

const PA5_SHIFT = 5;
const PA5_MODE_SHIFT = 10;
const MODE_OUTPUT = 0b01;

function toBytes(firmware) {
  if (firmware == null) throw new TypeError('createReference requires firmware bytes');
  let source = firmware;
  if (
    typeof firmware === 'object' &&
    !ArrayBuffer.isView(firmware) &&
    !(firmware instanceof ArrayBuffer)
  ) {
    source = firmware.bytes;
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source).slice();
  if (ArrayBuffer.isView(source))
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  if (Array.isArray(source)) return Uint8Array.from(source);
  throw new TypeError('firmware must be a Uint8Array, ArrayBuffer, byte array or { bytes }');
}

function hex(value, width = 4) {
  return `0x${(value >>> 0).toString(16).padStart(width, '0')}`;
}

function signExtend(value, bits) {
  const limit = 1 << (bits - 1);
  return value >= limit ? value - (1 << bits) : value;
}

// Old fixture builds emitted `.word handler + 1` against a symbol that already
// carried the Thumb bit, landing two bytes past the handler. Normalise both
// conventions (`...01` and `...02`) to the real halfword-aligned address.
function normalizeThumbVector(value) {
  const raw = value >>> 0;
  if ((raw & 1) !== 0) return raw & ~1;
  if ((raw & 3) === 2) return (raw - 2) >>> 0;
  return raw;
}

function addWithCarry(a, b, carryIn) {
  const sum = a + b + carryIn;
  return {
    result: sum >>> 0,
    carry: sum > 0xffffffff,
    overflow: ((a ^ (sum >>> 0)) & (b ^ (sum >>> 0))) >>> 31 === 1,
  };
}

function subWithBorrow(a, b, borrowIn) {
  const diff = a - b - borrowIn;
  return {
    result: diff >>> 0,
    borrow: diff < 0,
    overflow: ((a ^ b) & (a ^ (diff >>> 0))) >>> 31 === 1,
  };
}

function shiftLsl(value, amount) {
  if (amount === 0) return { result: value, carry: undefined };
  if (amount < 32)
    return { result: (value << amount) >>> 0, carry: ((value >>> (32 - amount)) & 1) === 1 };
  if (amount === 32) return { result: 0, carry: (value & 1) === 1 };
  return { result: 0, carry: false };
}

function shiftLsr(value, amount) {
  if (amount === 0) return { result: value, carry: undefined };
  if (amount < 32) return { result: value >>> amount, carry: ((value >>> (amount - 1)) & 1) === 1 };
  if (amount === 32) return { result: 0, carry: value >>> 31 === 1 };
  return { result: 0, carry: false };
}

function shiftAsr(value, amount) {
  if (amount === 0) return { result: value, carry: undefined };
  const signed = value | 0;
  if (amount < 32)
    return { result: (signed >> amount) >>> 0, carry: ((signed >> (amount - 1)) & 1) === 1 };
  return { result: (signed >> 31) >>> 0, carry: signed < 0 };
}

function shiftRor(value, amount) {
  if (amount === 0) return { result: value, carry: undefined };
  const rotate = amount & 31;
  if (rotate === 0) return { result: value, carry: value >>> 31 === 1 };
  return {
    result: ((value >>> rotate) | (value << (32 - rotate))) >>> 0,
    carry: ((value >>> (rotate - 1)) & 1) === 1,
  };
}

export function createReference({ firmware, cyclePs = DEFAULT_CYCLE_PS } = {}) {
  if (!Number.isFinite(cyclePs) || cyclePs <= 0) {
    throw new RangeError('cyclePs must be a positive number of picoseconds');
  }

  const meta =
    typeof firmware === 'object' && firmware !== null && !ArrayBuffer.isView(firmware)
      ? firmware
      : {};
  const image = toBytes(firmware);
  if (image.length > FLASH_SIZE) {
    throw new RangeError(`firmware image ${image.length} exceeds ${FLASH_SIZE} bytes of flash`);
  }

  const flash = new Uint8Array(FLASH_SIZE);
  flash.set(image);
  const ram = new Uint8Array(SRAM_SIZE);

  const regs = new Uint32Array(16);
  const flags = { n: false, z: false, c: false, v: false };

  let pcNext = RESET_PC;
  let itstate = 0;
  let primask = 0;
  let ipsr = 0;
  let cpuTimePs = 0;
  let clockPs = 0;
  let instructionsIssued = 0;
  let exceptionEntries = 0;

  const gpio = {
    moder: 0xffffebff, // RM0440 reset value: PA5 stays in alternate-function (floating) mode
    otyper: 0,
    ospeedr: 0,
    pupdr: 0,
    odr: 0,
    lckr: 0,
    afr0: 0,
    afr1: 0,
  };
  const rcc = { ahb2enr: 0 };
  const scb = { vtor: FLASH_BASE };
  const systick = {
    enabled: false,
    tickint: false,
    clksource: false,
    reload: 0,
    startPs: 0,
    valAtStart: 0,
    frozenVal: 0,
    ticksDone: 0,
    countflag: false,
    pending: false,
    lastEnsurePs: 0,
  };
  const gpioEdges = [];
  const gpioWrites = [];
  let pa5Level = 2; // 0 low, 1 high, 2 floating (input, analog or GPIOA clock off)
  let pa5EdgeLevel = 0; // floating counts as low for edge detection, as in the bench capture
  // Loads read memory and advance the pc at issue time but retire their target
  // register write after the access: the CPU model must not expose rt while
  // clockPs === duePs, so keep at most one pending suffix.
  let pendingLoad = null;

  // Reset state: the bench pins reset at 0x08000100; the initial MSP still
  // comes from vector slot 0 so the image can override it.
  if (image.length >= 8) {
    const initialSp = meta.initialSp ?? readFlashWord(0);
    regs[13] = initialSp !== 0 && initialSp <= SRAM_END ? initialSp >>> 0 : STACK_TOP;
  } else {
    regs[13] = STACK_TOP;
  }
  pcNext = ((meta.entry ?? meta.resetPc ?? RESET_PC) & ~1) >>> 0;
  if (meta.vtor != null) scb.vtor = meta.vtor >>> 0;
  regs[14] = 0;

  function readFlashWord(address) {
    const offset = address - FLASH_BASE;
    return (
      (flash[offset] |
        (flash[offset + 1] << 8) |
        (flash[offset + 2] << 16) |
        (flash[offset + 3] << 24)) >>>
      0
    );
  }

  function systickEnabled() {
    return systick.enabled;
  }

  function totalTicksAt(timePs) {
    if (!systickEnabled()) return systick.ticksDone;
    const elapsed = Math.floor((timePs - systick.startPs) / cyclePs);
    if (elapsed <= systick.valAtStart) return 0;
    return 1 + Math.floor((elapsed - systick.valAtStart - 1) / (systick.reload + 1));
  }

  function systickValueAt(timePs) {
    if (!systickEnabled()) return systick.frozenVal;
    const elapsed = Math.floor((timePs - systick.startPs) / cyclePs);
    if (elapsed <= systick.valAtStart) return (systick.valAtStart - elapsed) >>> 0;
    const wrapped = (elapsed - systick.valAtStart - 1) % (systick.reload + 1);
    return (systick.reload - wrapped) >>> 0;
  }

  function ensureTimers(timePs) {
    if (timePs <= systick.lastEnsurePs) return;
    systick.lastEnsurePs = timePs;
    if (!systickEnabled()) return;
    const ticks = totalTicksAt(timePs);
    if (ticks > systick.ticksDone) {
      if (systick.tickint) systick.pending = true;
      systick.countflag = true;
      systick.ticksDone = ticks;
    }
  }

  function systickCtrlValue() {
    let value = 0;
    if (systick.enabled) value |= 1;
    if (systick.tickint) value |= 2;
    if (systick.clksource) value |= 4;
    if (systick.countflag) value |= 1 << 16;
    return value >>> 0;
  }

  function restartSystick(timePs, value) {
    systick.startPs = timePs;
    systick.valAtStart = value & 0xffffff;
    systick.ticksDone = 0;
  }

  function writeSystickCtrl(timePs, value) {
    const wasEnabled = systick.enabled;
    const liveValue = systickValueAt(timePs);
    systick.enabled = (value & 1) !== 0;
    systick.tickint = (value & 2) !== 0;
    systick.clksource = (value & 4) !== 0;
    systick.countflag = false;
    if (systick.enabled !== wasEnabled) {
      if (systick.enabled) {
        restartSystick(timePs, systick.reload);
      } else {
        systick.frozenVal = liveValue;
        systick.ticksDone = 0;
      }
    }
  }

  function computePa5Level() {
    const clocked = (rcc.ahb2enr & 1) !== 0;
    const mode = (gpio.moder >>> PA5_MODE_SHIFT) & 3;
    if (!clocked || mode !== MODE_OUTPUT) return 2;
    return (gpio.odr >>> PA5_SHIFT) & 1;
  }

  function refreshPin(timePs) {
    ensureTimers(timePs);
    pa5Level = computePa5Level();
    const electricLevel = pa5Level === 2 ? 0 : pa5Level;
    if (electricLevel !== pa5EdgeLevel) {
      pa5EdgeLevel = electricLevel;
      gpioEdges.push({ time: timePs, cycle: timePs / cyclePs, value: electricLevel });
    }
  }

  function computeIdr() {
    const clocked = (rcc.ahb2enr & 1) !== 0;
    if (!clocked) return 0;
    // The bus mirrors the ODR latch on every pin; only PA5 substitutes the
    // solved pin level when it is not a general-purpose output.
    const output = ((gpio.moder >>> PA5_MODE_SHIFT) & 3) === MODE_OUTPUT;
    const pa5 = output ? (gpio.odr >>> PA5_SHIFT) & 1 : pa5Level === 1 ? 1 : 0;
    return ((gpio.odr & 0xffff & ~(1 << PA5_SHIFT)) | (pa5 << PA5_SHIFT)) >>> 0;
  }

  function readGpioWord(timePs, address) {
    if ((rcc.ahb2enr & 1) === 0) return 0; // unclocked GPIOA reads return zero
    switch (address) {
      case GPIOA_MODER:
        return gpio.moder;
      case GPIOA_OTYPER:
        return gpio.otyper;
      case GPIOA_OSPEEDR:
        return gpio.ospeedr;
      case GPIOA_PUPDR:
        return gpio.pupdr;
      case GPIOA_IDR:
        return computeIdr();
      case GPIOA_ODR:
        return gpio.odr;
      case GPIOA_BSRR:
        return 0;
      case GPIOA_LCKR:
        return gpio.lckr;
      case GPIOA_AFR:
        return gpio.afr0;
      case GPIOA_AFR + 4:
        return gpio.afr1;
      default:
        return 0;
    }
  }

  function writeGpioWord(timePs, address, value) {
    if ((rcc.ahb2enr & 1) === 0) return true; // unclocked GPIOA writes are dropped
    switch (address) {
      case GPIOA_MODER:
        gpio.moder = value >>> 0;
        break;
      case GPIOA_OTYPER:
        gpio.otyper = value & 0xffff;
        break;
      case GPIOA_OSPEEDR:
        gpio.ospeedr = value >>> 0;
        break;
      case GPIOA_PUPDR:
        gpio.pupdr = value >>> 0;
        break;
      case GPIOA_ODR:
        gpio.odr = value & 0xffff;
        gpioWrites.push({
          time: timePs,
          cycle: timePs / cyclePs,
          register: 'ODR',
          value: value >>> 0,
          odr: gpio.odr,
        });
        break;
      case GPIOA_BSRR: {
        const set = value & 0xffff;
        const reset = (value >>> 16) & 0xffff;
        gpio.odr = (((gpio.odr & ~reset) | set) & 0xffff) >>> 0;
        gpioWrites.push({
          time: timePs,
          cycle: timePs / cyclePs,
          register: 'BSRR',
          value: value >>> 0,
          odr: gpio.odr,
        });
        break;
      }
      case GPIOA_LCKR:
        gpio.lckr = value >>> 0;
        break;
      case GPIOA_AFR:
        gpio.afr0 = value >>> 0;
        break;
      case GPIOA_AFR + 4:
        gpio.afr1 = value >>> 0;
        break;
      default:
        return false;
    }
    refreshPin(timePs);
    return true;
  }

  function scbReadWord(address) {
    switch (address) {
      case SCB_ICSR:
        return (systick.pending ? 1 << 26 : 0) >>> 0;
      case SCB_VTOR:
        return scb.vtor >>> 0;
      default:
        return 0;
    }
  }

  function scbWriteWord(timePs, address, value) {
    switch (address) {
      case SCB_ICSR:
        if (value & (1 << 26)) systick.pending = true;
        else if (value & (1 << 25)) systick.pending = false;
        break;
      case SCB_VTOR:
        scb.vtor = value >>> 0;
        break;
      default:
        break;
    }
  }

  // ---- bus -------------------------------------------------------------

  function readPeripheralWord(timePs, address) {
    ensureTimers(timePs);
    if (address >= SYSTICK_BASE && address < SYSTICK_BASE + 0x10) {
      switch (address) {
        case SYSTICK_CTRL: {
          const value = systickCtrlValue();
          systick.countflag = false;
          return value;
        }
        case SYSTICK_LOAD:
          return systick.reload & 0xffffff;
        case SYSTICK_VAL: {
          const value = systickValueAt(timePs);
          systick.countflag = false;
          return value;
        }
        case SYSTICK_CALIB:
          return 0;
        default:
          return 0;
      }
    }
    if (address >= GPIOA_BASE && address < GPIO_END) return readGpioWord(timePs, address);
    if (address >= RCC_BASE && address < RCC_END) {
      if (address === RCC_AHB2ENR) return rcc.ahb2enr >>> 0;
      return 0;
    }
    if (address >= SCB_BASE && address < SCB_END) return scbReadWord(address);
    throw new Error(`reference: unmapped peripheral read at ${hex(address, 8)}`);
  }

  function writePeripheralWord(timePs, address, value, size, rawAddress) {
    ensureTimers(timePs);
    const shift = (rawAddress & 3) * 8;
    const sizeMask = size === 4 ? 0xffffffff : (1 << (size * 8)) - 1;
    const mask = (sizeMask << shift) >>> 0;
    const merged = (current) => ((current & ~mask) | ((value << shift) & mask)) >>> 0;

    if (address >= SYSTICK_BASE && address < SYSTICK_BASE + 0x10) {
      if (size !== 4) throw new Error('reference: sub-word SysTick write is unsupported');
      switch (address) {
        case SYSTICK_CTRL:
          writeSystickCtrl(timePs, value);
          return;
        case SYSTICK_LOAD:
          systick.reload = value & 0xffffff;
          return;
        case SYSTICK_VAL:
          // The bus restarts the count from zero and clears COUNTFLAG.
          systick.frozenVal = 0;
          systick.countflag = false;
          if (systick.enabled) restartSystick(timePs, 0);
          return;
        default:
          return;
      }
    }
    if (address >= GPIOA_BASE && address < GPIO_END) {
      if (address === GPIOA_BSRR && size !== 4) {
        throw new Error('reference: BSRR requires a word write');
      }
      const current = readGpioWord(timePs, address);
      writeGpioWord(timePs, address, merged(current));
      return;
    }
    if (address >= RCC_BASE && address < RCC_END) {
      if (address === RCC_AHB2ENR) {
        rcc.ahb2enr = merged(rcc.ahb2enr);
        refreshPin(timePs);
      }
      return;
    }
    if (address >= SCB_BASE && address < SCB_END) {
      if (size === 4) scbWriteWord(timePs, address, value);
      else if (address === SCB_ICSR)
        throw new Error('reference: sub-word ICSR write is unsupported');
      else if (address === SCB_VTOR) scb.vtor = merged(scb.vtor) >>> 0;
      return;
    }
    throw new Error(`reference: unmapped peripheral write at ${hex(address, 8)}`);
  }

  function read8(address) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END) return ram[addr - SRAM_BASE];
    if (addr >= FLASH_BASE && addr < FLASH_END) return flash[addr - FLASH_BASE];
    if (addr < PERIPHERAL_LIMIT) {
      const word = readPeripheralWord(cpuTimePs, (addr & ~3) >>> 0);
      return (word >>> ((addr & 3) * 8)) & 0xff;
    }
    throw new Error(`reference: unmapped read8 at ${hex(addr, 8)}`);
  }

  function read16(address) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END - 1) {
      const offset = addr - SRAM_BASE;
      return ram[offset] | (ram[offset + 1] << 8);
    }
    if (addr >= FLASH_BASE && addr < FLASH_END - 1) {
      const offset = addr - FLASH_BASE;
      return flash[offset] | (flash[offset + 1] << 8);
    }
    if (addr < PERIPHERAL_LIMIT) {
      const word = readPeripheralWord(cpuTimePs, (addr & ~3) >>> 0);
      return (word >>> ((addr & 3) * 8)) & 0xffff;
    }
    throw new Error(`reference: unmapped read16 at ${hex(addr, 8)}`);
  }

  function read32(address) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END - 3) {
      const offset = addr - SRAM_BASE;
      return (
        (ram[offset] |
          (ram[offset + 1] << 8) |
          (ram[offset + 2] << 16) |
          (ram[offset + 3] << 24)) >>>
        0
      );
    }
    if (addr >= FLASH_BASE && addr < FLASH_END - 3) {
      const offset = addr - FLASH_BASE;
      return (
        (flash[offset] |
          (flash[offset + 1] << 8) |
          (flash[offset + 2] << 16) |
          (flash[offset + 3] << 24)) >>>
        0
      );
    }
    if (addr < PERIPHERAL_LIMIT) return readPeripheralWord(cpuTimePs, (addr & ~3) >>> 0);
    throw new Error(`reference: unmapped read32 at ${hex(addr, 8)}`);
  }

  function write8(address, value) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END) {
      ram[addr - SRAM_BASE] = value & 0xff;
      return;
    }
    if (addr >= FLASH_BASE && addr < FLASH_END)
      throw new Error(`reference: flash write at ${hex(addr, 8)}`);
    writePeripheralWord(cpuTimePs, (addr & ~3) >>> 0, value & 0xff, 1, addr);
  }

  function write16(address, value) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END - 1) {
      const offset = addr - SRAM_BASE;
      ram[offset] = value & 0xff;
      ram[offset + 1] = (value >>> 8) & 0xff;
      return;
    }
    if (addr >= FLASH_BASE && addr < FLASH_END)
      throw new Error(`reference: flash write at ${hex(addr, 8)}`);
    writePeripheralWord(cpuTimePs, (addr & ~3) >>> 0, value & 0xffff, 2, addr);
  }

  function write32(address, value) {
    const addr = address >>> 0;
    if (addr >= SRAM_BASE && addr < SRAM_END - 3) {
      const offset = addr - SRAM_BASE;
      ram[offset] = value & 0xff;
      ram[offset + 1] = (value >>> 8) & 0xff;
      ram[offset + 2] = (value >>> 16) & 0xff;
      ram[offset + 3] = (value >>> 24) & 0xff;
      return;
    }
    if (addr >= FLASH_BASE && addr < FLASH_END)
      throw new Error(`reference: flash write at ${hex(addr, 8)}`);
    writePeripheralWord(cpuTimePs, (addr & ~3) >>> 0, value >>> 0, 4, addr);
  }

  // ---- register and flag helpers ---------------------------------------

  function setReg(index, value) {
    const v = value >>> 0;
    if (index === 15) pcNext = (v & ~1) >>> 0;
    else regs[index] = v;
  }

  function deferLoad(index, value) {
    const result = value >>> 0;
    pendingLoad = {
      duePs: cpuTimePs + CYCLES_LOAD_STORE * cyclePs,
      apply() {
        if (index === 15) pcNext = (result & ~1) >>> 0;
        else regs[index] = result;
      },
    };
  }

  function retirePendingLoad() {
    if (pendingLoad === null || clockPs <= pendingLoad.duePs) return;
    const apply = pendingLoad.apply;
    pendingLoad = null;
    apply();
  }

  function setNz(result) {
    flags.n = result >>> 31 === 1;
    flags.z = result === 0;
  }

  function setNzcv(result, carry, overflow) {
    flags.n = result >>> 31 === 1;
    flags.z = result === 0;
    flags.c = carry;
    flags.v = overflow;
  }

  function conditionPassed(cond) {
    switch (cond) {
      case 0x0:
        return flags.z;
      case 0x1:
        return !flags.z;
      case 0x2:
        return flags.c;
      case 0x3:
        return !flags.c;
      case 0x4:
        return flags.n;
      case 0x5:
        return !flags.n;
      case 0x6:
        return flags.v;
      case 0x7:
        return !flags.v;
      case 0x8:
        return flags.c && !flags.z;
      case 0x9:
        return !flags.c || flags.z;
      case 0xa:
        return flags.n === flags.v;
      case 0xb:
        return flags.n !== flags.v;
      case 0xc:
        return !flags.z && flags.n === flags.v;
      case 0xd:
        return flags.z || flags.n !== flags.v;
      case 0xe:
        return true;
      default:
        return false;
    }
  }

  function advanceItState() {
    if ((itstate & 7) === 0) itstate = 0;
    else itstate = (itstate & 0xe0) | ((itstate << 1) & 0x1f);
  }

  function xpsrValue() {
    let value = 0;
    if (flags.n) value |= 1 << 31;
    if (flags.z) value |= 1 << 30;
    if (flags.c) value |= 1 << 29;
    if (flags.v) value |= 1 << 28;
    value |= 1 << 24; // Thumb
    value |= (itstate & 0xfc) << 8; // IT[7:2] -> bits 15:10
    value |= (itstate & 0x3) << 25; // IT[1:0] -> bits 26:25
    value |= ipsr & 0x1ff;
    return value >>> 0;
  }

  function restoreXpsr(value) {
    flags.n = (value & (1 << 31)) !== 0;
    flags.z = (value & (1 << 30)) !== 0;
    flags.c = (value & (1 << 29)) !== 0;
    flags.v = (value & (1 << 28)) !== 0;
    const itHigh = (value >>> 10) & 0x3f;
    const itLow = (value >>> 25) & 0x3;
    itstate = ((itHigh << 2) | itLow) & 0xff;
    ipsr = value & 0x1ff;
  }

  // ---- exceptions ------------------------------------------------------

  function enterException() {
    const sp = (regs[13] - 32) >>> 0;
    const returnPc = pcNext >>> 0;
    const stacked = [regs[0], regs[1], regs[2], regs[3], regs[12], regs[14], returnPc, xpsrValue()];
    for (let i = 0; i < stacked.length; i += 1) {
      const address = (sp + i * 4) >>> 0;
      if (address < SRAM_BASE || address + 3 >= SRAM_END) {
        throw new Error(`reference: exception stack outside SRAM at ${hex(address, 8)}`);
      }
      write32(address, stacked[i]);
    }
    regs[13] = sp;
    regs[14] = EXC_RETURN;
    ipsr = 15;
    itstate = 0;
    systick.pending = false;
    const vector = scb.vtor + 60;
    const handler = normalizeThumbVector(read32(vector));
    if (handler === 0)
      throw new Error(`reference: no SysTick handler in vector table at ${hex(vector, 8)}`);
    pcNext = handler;
    exceptionEntries += 1;
    cpuTimePs += CYCLES_EXCEPTION * cyclePs;
  }

  function returnFromException(sp) {
    const stacked = [];
    for (let i = 0; i < 8; i += 1) stacked.push(read32((sp + i * 4) >>> 0));
    regs[0] = stacked[0];
    regs[1] = stacked[1];
    regs[2] = stacked[2];
    regs[3] = stacked[3];
    regs[12] = stacked[4];
    regs[14] = stacked[5];
    pcNext = (stacked[6] & ~1) >>> 0;
    restoreXpsr(stacked[7]);
    regs[13] = (sp + 32) >>> 0;
  }

  // ---- Thumb-16 execution ----------------------------------------------

  function execute16(hw, addr) {
    // Shift (immediate) / add-subtract
    if ((hw & 0xe000) === 0) {
      if ((hw & 0x1800) === 0x1800) {
        const op = (hw >>> 9) & 1;
        const rd = hw & 7;
        if ((hw & 0x0400) === 0) {
          const rm = (hw >>> 6) & 7;
          const rn = (hw >>> 3) & 7;
          if (op === 0) {
            const { result, carry, overflow } = addWithCarry(regs[rn], regs[rm], 0);
            setReg(rd, result);
            setNzcv(result, carry, overflow);
          } else {
            const { result, borrow, overflow } = subWithBorrow(regs[rn], regs[rm], 0);
            setReg(rd, result);
            setNzcv(result, !borrow, overflow);
          }
        } else {
          const imm = (hw >>> 6) & 7;
          const rn = (hw >>> 3) & 7;
          if (op === 0) {
            const { result, carry, overflow } = addWithCarry(regs[rn], imm, 0);
            setReg(rd, result);
            setNzcv(result, carry, overflow);
          } else {
            const { result, borrow, overflow } = subWithBorrow(regs[rn], imm, 0);
            setReg(rd, result);
            setNzcv(result, !borrow, overflow);
          }
        }
        return CYCLES_ALU;
      }
      const op = (hw >>> 11) & 3;
      const imm5 = (hw >>> 6) & 0x1f;
      const rm = (hw >>> 3) & 7;
      const rd = hw & 7;
      let shifted;
      if (op === 0) shifted = shiftLsl(regs[rm], imm5);
      else if (op === 1) shifted = shiftLsr(regs[rm], imm5 === 0 ? 32 : imm5);
      else shifted = shiftAsr(regs[rm], imm5 === 0 ? 32 : imm5);
      setReg(rd, shifted.result);
      setNz(shifted.result);
      if (shifted.carry !== undefined) flags.c = shifted.carry;
      return CYCLES_ALU;
    }

    // MOV/CMP/ADD/SUB immediate 8
    if ((hw & 0xe000) === 0x2000) {
      const op = (hw >>> 11) & 3;
      const rdn = (hw >>> 8) & 7;
      const imm = hw & 0xff;
      if (op === 0) {
        setReg(rdn, imm);
        setNz(imm);
      } else if (op === 1) {
        const { result, borrow, overflow } = subWithBorrow(regs[rdn], imm, 0);
        setNzcv(result, !borrow, overflow);
      } else if (op === 2) {
        const { result, carry, overflow } = addWithCarry(regs[rdn], imm, 0);
        setReg(rdn, result);
        setNzcv(result, carry, overflow);
      } else {
        const { result, borrow, overflow } = subWithBorrow(regs[rdn], imm, 0);
        setReg(rdn, result);
        setNzcv(result, !borrow, overflow);
      }
      return CYCLES_ALU;
    }

    // Data processing (register)
    if ((hw & 0xfc00) === 0x4000) {
      const op = (hw >>> 6) & 0xf;
      const rm = (hw >>> 3) & 7;
      const rdn = hw & 7;
      const a = regs[rdn];
      const b = regs[rm];
      switch (op) {
        case 0x0: {
          const result = (a & b) >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
        case 0x1: {
          const result = (a ^ b) >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
        case 0x2: {
          const shifted = shiftLsl(a, b & 0xff);
          setReg(rdn, shifted.result);
          setNz(shifted.result);
          if (shifted.carry !== undefined) flags.c = shifted.carry;
          break;
        }
        case 0x3: {
          const shifted = shiftLsr(a, b & 0xff);
          setReg(rdn, shifted.result);
          setNz(shifted.result);
          if (shifted.carry !== undefined) flags.c = shifted.carry;
          break;
        }
        case 0x4: {
          const shifted = shiftAsr(a, b & 0xff);
          setReg(rdn, shifted.result);
          setNz(shifted.result);
          if (shifted.carry !== undefined) flags.c = shifted.carry;
          break;
        }
        case 0x5: {
          const { result, carry, overflow } = addWithCarry(a, b, flags.c ? 1 : 0);
          setReg(rdn, result);
          setNzcv(result, carry, overflow);
          break;
        }
        case 0x6: {
          const { result, borrow, overflow } = subWithBorrow(a, b, flags.c ? 0 : 1);
          setReg(rdn, result);
          setNzcv(result, !borrow, overflow);
          break;
        }
        case 0x7: {
          const shifted = shiftRor(a, b & 0xff);
          setReg(rdn, shifted.result);
          setNz(shifted.result);
          if (shifted.carry !== undefined) flags.c = shifted.carry;
          break;
        }
        case 0x8: {
          const result = (a & b) >>> 0;
          setNz(result);
          break;
        }
        case 0x9: {
          const { result, borrow, overflow } = subWithBorrow(0, b, 0);
          setReg(rdn, result);
          setNzcv(result, !borrow, overflow);
          break;
        }
        case 0xa: {
          const { result, borrow, overflow } = subWithBorrow(a, b, 0);
          setNzcv(result, !borrow, overflow);
          break;
        }
        case 0xb: {
          const { result, carry, overflow } = addWithCarry(a, b, 0);
          setNzcv(result, carry, overflow);
          break;
        }
        case 0xc: {
          const result = (a | b) >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
        case 0xd: {
          const result = Math.imul(a, b) >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
        case 0xe: {
          const result = (a & ~b) >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
        default: {
          const result = ~b >>> 0;
          setReg(rdn, result);
          setNz(result);
          break;
        }
      }
      return CYCLES_ALU;
    }

    // Special data processing / branch and exchange
    if ((hw & 0xfc00) === 0x4400) {
      const op = (hw >>> 8) & 3;
      const rm = (hw >>> 3) & 0xf;
      const rdn = ((hw >>> 4) & 8) | (hw & 7);
      if (op === 0) {
        setReg(rdn, (regs[rdn] + regs[rm]) >>> 0);
        return CYCLES_ALU;
      }
      if (op === 1) {
        const { result, borrow, overflow } = subWithBorrow(regs[rdn], regs[rm], 0);
        setNzcv(result, !borrow, overflow);
        return CYCLES_ALU;
      }
      if (op === 2) {
        if (rdn === 15) {
          pcNext = (regs[rm] & ~1) >>> 0;
          return CYCLES_BRANCH_TAKEN;
        }
        setReg(rdn, regs[rm]);
        return CYCLES_ALU;
      }
      // BX / BLX
      if ((hw & 0x0007) !== 0)
        throw new Error(`reference: unsupported special data ${hex(hw)} at ${hex(addr, 8)}`);
      const link = (hw & 0x0080) !== 0;
      const target = regs[rm];
      if (link) {
        regs[14] = (addr + 2) | 1;
        pcNext = (target & ~1) >>> 0;
        return CYCLES_BRANCH_TAKEN;
      }
      if (ipsr !== 0 && target >>> 28 === 0xf) {
        returnFromException(regs[13]);
        return CYCLES_EXCEPTION;
      }
      if ((target & ~1) === 0) throw new Error(`reference: bx to null at ${hex(addr, 8)}`);
      pcNext = (target & ~1) >>> 0;
      return CYCLES_BRANCH_TAKEN;
    }

    // LDR (literal)
    if ((hw & 0xf800) === 0x4800) {
      const rt = (hw >>> 8) & 7;
      const imm = (hw & 0xff) * 4;
      const base = ((addr + 4) & ~3) >>> 0;
      deferLoad(rt, read32((base + imm) >>> 0));
      return CYCLES_LOAD_STORE;
    }

    // Load/store (register offset)
    if ((hw & 0xf000) === 0x5000) {
      const op = (hw >>> 9) & 7;
      const rm = (hw >>> 6) & 7;
      const rn = (hw >>> 3) & 7;
      const rt = hw & 7;
      const address = (regs[rn] + regs[rm]) >>> 0;
      switch (op) {
        case 0:
          write32(address, regs[rt]);
          break;
        case 1:
          write16(address, regs[rt]);
          break;
        case 2:
          write8(address, regs[rt]);
          break;
        case 3:
          deferLoad(rt, (read8(address) << 24) >> 24);
          break;
        case 4:
          deferLoad(rt, read32(address));
          break;
        case 5:
          deferLoad(rt, read16(address));
          break;
        case 6:
          deferLoad(rt, read8(address));
          break;
        default:
          deferLoad(rt, ((read16(address) << 16) >> 16) >>> 0);
          break;
      }
      return CYCLES_LOAD_STORE;
    }

    // Load/store (immediate offset, word/byte)
    if ((hw & 0xe000) === 0x6000) {
      const rn = (hw >>> 3) & 7;
      const rt = hw & 7;
      const byte = (hw & 0x1000) !== 0;
      const load = (hw & 0x0800) !== 0;
      const imm5 = (hw >>> 6) & 0x1f;
      const address = (regs[rn] + (byte ? imm5 : imm5 * 4)) >>> 0;
      if (load) {
        if (byte) deferLoad(rt, read8(address));
        else deferLoad(rt, read32(address));
      } else if (byte) write8(address, regs[rt]);
      else write32(address, regs[rt]);
      return CYCLES_LOAD_STORE;
    }

    // Load/store halfword (immediate offset)
    if ((hw & 0xf000) === 0x8000) {
      const rn = (hw >>> 3) & 7;
      const rt = hw & 7;
      const load = (hw & 0x0800) !== 0;
      const address = (regs[rn] + ((hw >>> 6) & 0x1f) * 2) >>> 0;
      if (load) deferLoad(rt, read16(address));
      else write16(address, regs[rt]);
      return CYCLES_LOAD_STORE;
    }

    // SP-relative load/store
    if ((hw & 0xf000) === 0x9000) {
      const load = (hw & 0x0800) !== 0;
      const rt = (hw >>> 8) & 7;
      const address = (regs[13] + (hw & 0xff) * 4) >>> 0;
      if (load) deferLoad(rt, read32(address));
      else write32(address, regs[rt]);
      return CYCLES_LOAD_STORE;
    }

    // ADR / ADD SP
    if ((hw & 0xf000) === 0xa000) {
      const rd = (hw >>> 8) & 7;
      const imm = (hw & 0xff) * 4;
      const base = (hw & 0x0800) !== 0 ? regs[13] : (addr + 4) & ~3;
      setReg(rd, (base + imm) >>> 0);
      return CYCLES_ALU;
    }

    if ((hw & 0xff00) === 0xb000) {
      const sub = (hw & 0x0080) !== 0;
      const imm = (hw & 0x7f) * 4;
      regs[13] = sub ? (regs[13] - imm) >>> 0 : (regs[13] + imm) >>> 0;
      return CYCLES_ALU;
    }

    if ((hw & 0xf500) === 0xb100) {
      const rn = hw & 7;
      const imm = (((hw >>> 9) & 1) << 6) | (((hw >>> 3) & 0x1f) << 1);
      const nonzero = (hw & 0x0800) !== 0;
      const target = (addr + 4 + imm) >>> 0;
      if ((regs[rn] === 0) !== nonzero) {
        pcNext = target;
        return CYCLES_BRANCH_TAKEN;
      }
      return CYCLES_BRANCH_NOT_TAKEN;
    }

    if ((hw & 0xfe00) === 0xb400) {
      const withLr = (hw & 0x0100) !== 0;
      const list = [];
      for (let i = 0; i < 8; i += 1) if (hw & (1 << i)) list.push(i);
      if (withLr) list.push(14);
      const sp = (regs[13] - list.length * 4) >>> 0;
      for (let i = 0; i < list.length; i += 1) write32((sp + i * 4) >>> 0, regs[list[i]]);
      regs[13] = sp;
      return list.length + 1;
    }

    if ((hw & 0xfe00) === 0xbc00) {
      const withPc = (hw & 0x0100) !== 0;
      let sp = regs[13];
      let pcLoad = null;
      for (let i = 0; i < 8; i += 1) {
        if (hw & (1 << i)) {
          setReg(i, read32(sp));
          sp = (sp + 4) >>> 0;
        }
      }
      if (withPc) {
        pcLoad = read32(sp);
        sp = (sp + 4) >>> 0;
      }
      regs[13] = sp;
      if (pcLoad !== null) pcNext = (pcLoad & ~1) >>> 0;
      return ((hw & 0xff) !== 0 ? countBits(hw & 0xff) : 0) + (withPc ? 1 : 0) + 1;
    }

    if ((hw & 0xffe0) === 0xb660) {
      primask = (hw & 0x0010) !== 0 ? 1 : 0;
      return CYCLES_ALU;
    }

    if ((hw & 0xff00) === 0xbf00) {
      const mask = hw & 0x0f;
      if (mask !== 0) {
        itstate = hw & 0xff;
        return CYCLES_ALU;
      }
      if ((hw & 0xff0f) === 0xbf00) {
        return CYCLES_ALU; // NOP / YIELD / WFE / WFI / SEV
      }
      throw new Error(`reference: unsupported hint ${hex(hw)} at ${hex(addr, 8)}`);
    }

    // Load/store multiple
    if ((hw & 0xf000) === 0xc000) {
      const load = (hw & 0x0800) !== 0;
      const rn = (hw >>> 8) & 7;
      const list = [];
      for (let i = 0; i < 8; i += 1) if (hw & (1 << i)) list.push(i);
      if (list.length === 0) throw new Error(`reference: empty ldm/stm at ${hex(addr, 8)}`);
      let address = regs[rn];
      for (const r of list) {
        if (load) setReg(r, read32(address));
        else write32(address, regs[r]);
        address = (address + 4) >>> 0;
      }
      if (!(load && list.includes(rn))) regs[rn] = address;
      return list.length + CYCLES_LOAD_STORE;
    }

    // Conditional branch / UDF / SVC
    if ((hw & 0xf000) === 0xd000) {
      const cond = (hw >>> 8) & 0xf;
      if (cond === 0xe || cond === 0xf) {
        throw new Error(`reference: unsupported service instruction ${hex(hw)} at ${hex(addr, 8)}`);
      }
      if (conditionPassed(cond)) {
        pcNext = (addr + 4 + signExtend((hw & 0xff) << 1, 9)) >>> 0;
        return CYCLES_BRANCH_TAKEN;
      }
      return CYCLES_BRANCH_NOT_TAKEN;
    }

    // Unconditional branch
    if ((hw & 0xf800) === 0xe000) {
      pcNext = (addr + 4 + signExtend((hw & 0x7ff) << 1, 12)) >>> 0;
      return CYCLES_BRANCH_TAKEN;
    }

    throw new Error(`reference: unknown Thumb instruction ${hex(hw)} at ${hex(addr, 8)}`);
  }

  function countBits(value) {
    let count = 0;
    let v = value;
    while (v !== 0) {
      count += v & 1;
      v >>>= 1;
    }
    return count;
  }

  // ---- Thumb-32 execution ----------------------------------------------

  function execute32(hw1, hw2, addr) {
    if ((hw2 & 0x8000) === 0 && ((hw1 & 0xfbf0) === 0xf240 || (hw1 & 0xfbf0) === 0xf2c0)) {
      const top = (hw1 & 0xfbf0) === 0xf2c0;
      const imm4 = hw1 & 0xf;
      const i = (hw1 >>> 10) & 1;
      const imm3 = (hw2 >>> 12) & 7;
      const rd = (hw2 >>> 8) & 0xf;
      const imm8 = hw2 & 0xff;
      const imm = ((imm4 << 12) | (i << 11) | (imm3 << 8) | imm8) >>> 0;
      if (top) setReg(rd, ((regs[rd] & 0xffff) | (imm << 16)) >>> 0);
      else setReg(rd, imm);
      return CYCLES_ALU;
    }
    if ((hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000) {
      const s = (hw1 >>> 10) & 1;
      const imm10 = hw1 & 0x3ff;
      const j1 = (hw2 >>> 13) & 1;
      const j2 = (hw2 >>> 11) & 1;
      const imm11 = hw2 & 0x7ff;
      const i1 = ~(j1 ^ s) & 1;
      const i2 = ~(j2 ^ s) & 1;
      let imm = ((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)) >>> 0;
      if (s) imm = (imm - (1 << 25)) >>> 0;
      regs[14] = (addr + 4) | 1;
      pcNext = (addr + 4 + (imm | 0)) >>> 0;
      return CYCLES_BRANCH_TAKEN;
    }
    throw new Error(
      `reference: unsupported Thumb-32 instruction ${hex(hw1)} ${hex(hw2)} at ${hex(addr, 8)}`,
    );
  }

  // ---- stepping --------------------------------------------------------

  function step() {
    const addr = pcNext >>> 0;
    ensureTimers(cpuTimePs);
    if (addr < FLASH_BASE || addr >= FLASH_END) {
      throw new Error(`reference: instruction fetch outside flash at ${hex(addr, 8)}`);
    }
    const hw1 = read16(addr);
    let cond = 0xe;
    if (itstate !== 0) {
      cond = (itstate >>> 4) & 0xf;
      advanceItState();
    }
    const passes = conditionPassed(cond);
    const wide = (hw1 & 0xf800) === 0xe800 || (hw1 & 0xf000) === 0xf000;
    let cost;
    if (wide) {
      if (addr + 3 >= FLASH_END)
        throw new Error(`reference: truncated Thumb-32 at ${hex(addr, 8)}`);
      const hw2 = read16(addr + 2);
      regs[15] = addr;
      pcNext = (addr + 4) >>> 0;
      cost = passes ? execute32(hw1, hw2, addr) : CYCLES_ALU;
    } else {
      regs[15] = addr;
      pcNext = (addr + 2) >>> 0;
      cost = passes ? execute16(hw1, addr) : CYCLES_ALU;
    }
    instructionsIssued += 1;
    cpuTimePs += (cost || CYCLES_ALU) * cyclePs;
  }

  function boundary() {
    retirePendingLoad();
    ensureTimers(cpuTimePs);
    if (systick.pending && primask === 0 && ipsr === 0) {
      enterException();
      return;
    }
    step();
  }

  // ---- snapshots -------------------------------------------------------

  function snapshot() {
    ensureTimers(clockPs);
    const states = {};
    for (let i = 0; i <= 14; i += 1) states[`r${i}`] = regs[i];
    states.pc = pcNext >>> 0;
    states.n = flags.n;
    states.z = flags.z;
    states.c = flags.c;
    states.v = flags.v;
    states.itstate = itstate;
    states.primask = primask;
    states.ipsr = ipsr;
    states.xpsr = xpsrValue();
    states.vtor = scb.vtor >>> 0;
    states.rcc = { ahb2enr: rcc.ahb2enr >>> 0, gpioaClock: (rcc.ahb2enr & 1) !== 0 };
    states.systick = {
      ctrl: systickCtrlValue(),
      load: systick.reload & 0xffffff,
      val: systickValueAt(clockPs),
      enabled: systick.enabled,
      tickint: systick.tickint,
      clksource: systick.clksource,
      pending: systick.pending,
      countflag: systick.countflag,
      ticks: systick.ticksDone,
    };
    states.gpioa = {
      moder: gpio.moder >>> 0,
      odr: gpio.odr & 0xffff,
      idr: computeIdr(),
      otyper: gpio.otyper,
      ospeedr: gpio.ospeedr,
      pupdr: gpio.pupdr,
    };
    states.pa5 = {
      clocked: (rcc.ahb2enr & 1) !== 0,
      output: ((gpio.moder >>> PA5_MODE_SHIFT) & 3) === MODE_OUTPUT,
      level: pa5Level,
      floating: pa5Level === 2,
    };
    return {
      time: clockPs,
      cycles: clockPs / cyclePs,
      cpuTimePs,
      cpuCycles: cpuTimePs / cyclePs,
      instructionsIssued,
      exceptionEntries,
      pa5Level,
      states,
      ram: ram.slice(),
      gpioEdges: gpioEdges.map((edge) => ({ ...edge })),
      gpioWrites: gpioWrites.map((write) => ({ ...write })),
    };
  }

  function advance(timePs) {
    if (!Number.isFinite(timePs))
      throw new TypeError('advance(timePs) requires a finite picosecond time');
    if (timePs < clockPs) {
      throw new RangeError(
        `reference: advance(${timePs}) cannot move time backwards from ${clockPs}`,
      );
    }
    clockPs = timePs;
    while (cpuTimePs < clockPs) boundary();
    ensureTimers(clockPs);
    return snapshot();
  }

  return { advance, snapshot };
}
