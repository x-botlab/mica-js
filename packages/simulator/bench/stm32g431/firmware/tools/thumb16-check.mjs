// Reference Thumb execution model for the STM32G431 firmware fixtures.
//
// This is a host-side cross-check, not part of the firmware contract: the
// fixtures themselves contain only real Thumb instructions. The model runs the
// captured bytes with a minimal STM32G431 map (flash, 32 KiB SRAM, RCC AHB2ENR,
// GPIOA MODER/IDR/ODR/BSRR and SysTick) so the generator can verify that every
// workload makes the SRAM and peripheral progress its metadata claims.
//
// Simplifications, none of which change the fixtures' arithmetic: one
// instruction retires per core cycle (a real M4 varies), there is no prefetch
// or bus stall, SysTick exceptions are not nested, and GPIOA IDR reflects the
// driven ODR value unless an external level is supplied.

const FLASH_BASE = 0x08000000;
const SRAM_BASE = 0x20000000;
const SRAM_SIZE = 0x8000;

const RCC_AHB2ENR = 0x4002104c;
const GPIOA_MODER = 0x48000000;
const GPIOA_IDR = 0x48000010;
const GPIOA_ODR = 0x48000014;
const GPIOA_BSRR = 0x48000018;
const SYST_CSR = 0xe000e010;
const SYST_LOAD = 0xe000e014;
const SYST_VAL = 0xe000e018;

const MASK32 = 0xffffffff;
const PA5 = 0x20;

export const SNAPSHOT_WORDS = 0x38;

const isPeripheral = (address) =>
  (address >= 0x40000000 && address < 0x60000000) || address >= 0xe0000000;

class Machine {
  constructor(bytes, options = {}) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('firmware bytes must be a Uint8Array');
    this.flash = bytes;
    this.sram = new Uint8Array(SRAM_SIZE);
    this.regs = new Uint32Array(16);
    this.n = 0;
    this.z = 0;
    this.c = 0;
    this.v = 0;
    this.itstate = 0;
    this.primask = 0;
    this.ipsp = 0;
    this.instructions = 0;
    this.cycles = 0;
    this.exceptionCount = 0;
    this.itTaken = 0;
    this.itSkipped = 0;
    this.conditionStats = new Map();
    this.gpioWrites = [];
    this.maxSramAddress = 0;
    this.options = { externalPins: 0, ...options };
    this.systick = {
      enable: 0,
      tickint: 0,
      clksource: 0,
      countflag: 0,
      load: 0,
      val: 0,
      pending: false,
    };
    this.gpio = { moder: 0, odr: 0 };
    this.rcc = { ahb2enr: 0 };
    this.regs[15] = this.readWord(this.flash, 4) & ~1;
    this.regs[13] = this.readWord(this.flash, 0);
    if (this.regs[13] % 8 !== 0) throw new Error('initial MSP is not 8-byte aligned');
  }

  readWord(buffer, offset) {
    return (
      (buffer[offset] |
        (buffer[offset + 1] << 8) |
        (buffer[offset + 2] << 16) |
        (buffer[offset + 3] << 24)) >>>
      0
    );
  }

  readHalf(address) {
    return this.readByte(address) | (this.readByte(address + 1) << 8);
  }

  readByte(address) {
    address >>>= 0;
    if (isPeripheral(address)) return this.readPeripheralByte(address);
    if (address >= SRAM_BASE && address < SRAM_BASE + SRAM_SIZE)
      return this.sram[address - SRAM_BASE];
    if (address >= FLASH_BASE && address < FLASH_BASE + this.flash.length) {
      return this.flash[address - FLASH_BASE];
    }
    throw new Error(`read from unmapped address 0x${address.toString(16)}`);
  }

  writeByte(address, value) {
    address >>>= 0;
    value &= 0xff;
    if (address >= SRAM_BASE && address < SRAM_BASE + SRAM_SIZE) {
      this.sram[address - SRAM_BASE] = value;
      if (address > this.maxSramAddress) this.maxSramAddress = address;
      return;
    }
    if (isPeripheral(address)) return this.writePeripheralByte(address, value);
    throw new Error(`write to unmapped address 0x${address.toString(16)}`);
  }

  read32(address) {
    address >>>= 0;
    if (isPeripheral(address)) return this.readPeripheral32(address);
    if (address >= SRAM_BASE && address < SRAM_BASE + SRAM_SIZE) {
      if (address + 4 > SRAM_BASE + SRAM_SIZE) throw new Error('SRAM read crosses the 32 KiB end');
      return this.readWord(this.sram, address - SRAM_BASE);
    }
    if (address >= FLASH_BASE && address + 4 <= FLASH_BASE + this.flash.length) {
      return this.readWord(this.flash, address - FLASH_BASE);
    }
    throw new Error(`read from unmapped address 0x${address.toString(16)}`);
  }

  write32(address, value) {
    address >>>= 0;
    value >>>= 0;
    if (isPeripheral(address)) return this.writePeripheral32(address, value);
    if (address >= SRAM_BASE && address < SRAM_BASE + SRAM_SIZE) {
      if (address + 4 > SRAM_BASE + SRAM_SIZE) throw new Error('SRAM write crosses the 32 KiB end');
      const offset = address - SRAM_BASE;
      this.sram[offset] = value & 0xff;
      this.sram[offset + 1] = (value >>> 8) & 0xff;
      this.sram[offset + 2] = (value >>> 16) & 0xff;
      this.sram[offset + 3] = (value >>> 24) & 0xff;
      if (address + 3 > this.maxSramAddress) this.maxSramAddress = address + 3;
      return;
    }
    throw new Error(`write to unmapped address 0x${address.toString(16)}`);
  }

  readPeripheralByte(address) {
    const word = this.readPeripheral32(address & ~3);
    return (word >>> ((address & 3) * 8)) & 0xff;
  }

  writePeripheralByte(address) {
    throw new Error(`byte write to peripheral 0x${address.toString(16)} is not modelled`);
  }

  readPeripheral32(address) {
    switch (address) {
      case RCC_AHB2ENR:
        return this.rcc.ahb2enr;
      case GPIOA_MODER:
        return this.gpio.moder;
      case GPIOA_IDR:
        return ((this.gpio.odr & PA5) | (this.options.externalPins & ~PA5)) >>> 0;
      case GPIOA_ODR:
        return this.gpio.odr;
      case SYST_CSR:
        return (
          ((this.systick.enable && 1) |
            (this.systick.tickint && 2) |
            (this.systick.clksource && 4) |
            (this.systick.countflag << 16)) >>>
          0
        );
      case SYST_LOAD:
        return this.systick.load;
      case SYST_VAL:
        return this.systick.val;
      default:
        throw new Error(`read from unmapped peripheral 0x${address.toString(16)}`);
    }
  }

  writePeripheral32(address, value) {
    switch (address) {
      case RCC_AHB2ENR:
        this.rcc.ahb2enr = value;
        return;
      case GPIOA_MODER:
        this.gpio.moder = value;
        return;
      case GPIOA_ODR:
        this.gpio.odr = value;
        return;
      case GPIOA_BSRR: {
        const set = value & 0xffff;
        const clear = value >>> 16;
        this.gpio.odr = ((this.gpio.odr | set) & ~clear) >>> 0;
        this.gpioWrites.push({ value, odr: this.gpio.odr, cycle: this.cycles });
        return;
      }
      case SYST_CSR: {
        const wasEnabled = this.systick.enable;
        this.systick.enable = value & 1;
        this.systick.tickint = (value >>> 1) & 1;
        this.systick.clksource = (value >>> 2) & 1;
        this.systick.countflag = 0;
        if (this.systick.enable && !wasEnabled) this.systick.val = 0;
        return;
      }
      case SYST_LOAD:
        this.systick.load = value & 0xffffff;
        return;
      case SYST_VAL:
        this.systick.val = 0;
        this.systick.countflag = 0;
        return;
      default:
        throw new Error(`write to unmapped peripheral 0x${address.toString(16)}`);
    }
  }

  readSramWord(address) {
    const offset = address - SRAM_BASE;
    if (offset < 0 || offset + 4 > SRAM_SIZE) throw new Error('SRAM snapshot out of range');
    return this.readWord(this.sram, offset);
  }

  snapshot() {
    const ram = [];
    for (let index = 0; index < SNAPSHOT_WORDS; index++) {
      ram.push({ address: SRAM_BASE + index * 4, value: this.readSramWord(SRAM_BASE + index * 4) });
    }
    return {
      instructions: this.instructions,
      cycles: this.cycles,
      ram,
      registers: {
        r0: this.regs[0],
        r1: this.regs[1],
        r2: this.regs[2],
        r3: this.regs[3],
        r4: this.regs[4],
        r5: this.regs[5],
        r6: this.regs[6],
        r7: this.regs[7],
        sp: this.regs[13],
        lr: this.regs[14],
      },
      pc: this.regs[15],
      gpio: { moder: this.gpio.moder, odr: this.gpio.odr, idr: this.readPeripheral32(GPIOA_IDR) },
      systick: { ...this.systick },
      systickExceptions: this.exceptionCount,
    };
  }

  conditionPasses(cond) {
    switch (cond) {
      case 0x0:
        return this.z === 1;
      case 0x1:
        return this.z === 0;
      case 0x2:
        return this.c === 1;
      case 0x3:
        return this.c === 0;
      case 0x4:
        return this.n === 1;
      case 0x5:
        return this.n === 0;
      case 0x6:
        return this.v === 1;
      case 0x7:
        return this.v === 0;
      case 0x8:
        return this.c === 1 && this.z === 0;
      case 0x9:
        return this.c === 0 || this.z === 1;
      case 0xa:
        return this.n === this.v;
      case 0xb:
        return this.n !== this.v;
      case 0xc:
        return this.z === 0 && this.n === this.v;
      case 0xd:
        return this.z === 1 || this.n !== this.v;
      case 0xe:
        return true;
      default:
        throw new Error('NV condition in Thumb code');
    }
  }

  setNz(value) {
    value >>>= 0;
    this.n = value >>> 31;
    this.z = value === 0 ? 1 : 0;
    return value;
  }

  addWithCarry(a, b, carry) {
    const unsigned = a + b + carry;
    const result = unsigned >>> 0;
    this.c = unsigned > MASK32 ? 1 : 0;
    this.v = (~(a ^ b) & (a ^ result) & 0x80000000) !== 0 ? 1 : 0;
    return this.setNz(result);
  }

  subWithBorrow(a, b) {
    return this.addWithCarry(a, ~b >>> 0, 1);
  }

  shiftLeft(value, amount) {
    if (amount === 0) return this.setNz(value);
    this.c = (value >>> (32 - amount)) & 1;
    return this.setNz((value << amount) >>> 0);
  }

  shiftRight(value, amount) {
    if (amount === 0) return this.setNz(value);
    this.c = (value >>> (amount - 1)) & 1;
    return this.setNz(value >>> amount);
  }

  arithmeticShiftRight(value, amount) {
    const signed = value | 0;
    if (amount === 0) return this.setNz(value);
    this.c = (signed >> (amount - 1)) & 1;
    return this.setNz((signed >> amount) >>> 0);
  }

  step() {
    const pc = this.regs[15];
    const first = this.readHalf(pc);
    const wide = (first & 0xf800) === 0xf000 || (first & 0xf800) === 0xe800;
    const size = wide ? 4 : 2;
    let condition = 0xe;
    if (this.itstate !== 0) condition = (this.itstate >>> 4) & 0xf;
    const run = this.conditionPasses(condition);
    const itstateBefore = this.itstate;
    if (itstateBefore !== 0) {
      if (run) this.itTaken++;
      else this.itSkipped++;
    }

    this.regs[15] = (pc + size) >>> 0;
    if (run) {
      if (wide) this.executeWide(pc, first, this.readHalf((pc + 2) >>> 0));
      else this.executeNarrow(pc, first);
    }

    if (itstateBefore !== 0) {
      if ((itstateBefore & 7) === 0) this.itstate = 0;
      else this.itstate = (itstateBefore & 0xe0) | ((itstateBefore << 1) & 0x1f);
    }

    this.instructions++;
    this.tick();
    if (this.systick.pending && this.ipsp === 0 && this.primask === 0) this.enterSystick();
  }

  tick() {
    const systick = this.systick;
    if (!systick.enable) return;
    if (systick.val === 0) {
      systick.val = systick.load;
      systick.countflag = 1;
      if (systick.tickint) systick.pending = true;
    } else {
      systick.val = (systick.val - 1) & 0xffffff;
    }
  }

  enterSystick() {
    if (this.ipsp !== 0) return;
    const handler = this.readWord(this.flash, 15 * 4) & ~1;
    if (handler === 0) throw new Error('SysTick exception with an empty vector');
    const frame = [
      this.regs[0],
      this.regs[1],
      this.regs[2],
      this.regs[3],
      this.regs[12],
      this.regs[14],
      this.regs[15],
      ((this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) | 0x01000000) >>> 0,
    ];
    const sp = (this.regs[13] - 32) >>> 0;
    for (let index = 0; index < frame.length; index++)
      this.write32((sp + index * 4) >>> 0, frame[index]);
    this.regs[13] = sp;
    this.regs[14] = 0xfffffff9;
    this.regs[15] = handler;
    this.ipsp = 15;
    this.systick.pending = false;
    this.exceptionCount++;
  }

  exceptionReturn() {
    const frame = [];
    for (let index = 0; index < 8; index++)
      frame.push(this.read32((this.regs[13] + index * 4) >>> 0));
    this.regs[0] = frame[0];
    this.regs[1] = frame[1];
    this.regs[2] = frame[2];
    this.regs[3] = frame[3];
    this.regs[12] = frame[4];
    this.regs[14] = frame[5];
    this.regs[15] = frame[6] & ~1;
    const xpsr = frame[7];
    this.n = (xpsr >>> 31) & 1;
    this.z = (xpsr >>> 30) & 1;
    this.c = (xpsr >>> 29) & 1;
    this.v = (xpsr >>> 28) & 1;
    this.regs[13] = (this.regs[13] + 32) >>> 0;
    this.ipsp = 0;
  }

  pushRegisters(list, includeLr) {
    const registers = [];
    for (let index = 0; index < 8; index++) if (list & (1 << index)) registers.push(index);
    if (includeLr) registers.push(14);
    const base = (this.regs[13] - registers.length * 4) >>> 0;
    if (base % 4 !== 0) throw new Error('unaligned push');
    registers.forEach((register, index) =>
      this.write32((base + index * 4) >>> 0, this.regs[register]),
    );
    this.regs[13] = base;
  }

  popRegisters(list, includePc) {
    const registers = [];
    for (let index = 0; index < 8; index++) if (list & (1 << index)) registers.push(index);
    let sp = this.regs[13];
    for (const register of registers) {
      this.regs[register] = this.read32(sp);
      sp = (sp + 4) >>> 0;
    }
    if (includePc) {
      this.regs[15] = this.read32(sp) & ~1;
      sp = (sp + 4) >>> 0;
    }
    this.regs[13] = sp;
  }

  executeNarrow(pc, instruction) {
    if ((instruction & 0xf800) < 0x1800) {
      const operation = (instruction >>> 11) & 3;
      let amount = (instruction >>> 6) & 0x1f;
      const source = (instruction >>> 3) & 7;
      const target = instruction & 7;
      if (operation === 0) this.regs[target] = this.shiftLeft(this.regs[source], amount);
      else if (operation === 1) {
        if (amount === 0) amount = 32;
        this.regs[target] = this.shiftRight(this.regs[source], amount);
      } else if (operation === 2) {
        if (amount === 0) amount = 32;
        this.regs[target] = this.arithmeticShiftRight(this.regs[source], amount);
      } else {
        throw new Error(`unsupported narrow opcode 0x${instruction.toString(16)}`);
      }
      return;
    }

    if ((instruction & 0xf800) === 0x1800) {
      const immediate = (instruction & 0x0400) !== 0;
      const subtract = (instruction & 0x0200) !== 0;
      const operand = immediate ? (instruction >>> 6) & 7 : this.regs[(instruction >>> 6) & 7];
      const source = (instruction >>> 3) & 7;
      const target = instruction & 7;
      this.regs[target] = subtract
        ? this.subWithBorrow(this.regs[source], operand)
        : this.addWithCarry(this.regs[source], operand, 0);
      return;
    }

    if ((instruction & 0xf800) === 0x2000) {
      this.regs[(instruction >>> 8) & 7] = this.setNz(instruction & 0xff);
      return;
    }
    if ((instruction & 0xf800) === 0x2800) {
      this.subWithBorrow(this.regs[(instruction >>> 8) & 7], instruction & 0xff);
      return;
    }
    if ((instruction & 0xf800) === 0x3000) {
      const target = (instruction >>> 8) & 7;
      this.regs[target] = this.addWithCarry(this.regs[target], instruction & 0xff, 0);
      return;
    }
    if ((instruction & 0xf800) === 0x3800) {
      const target = (instruction >>> 8) & 7;
      this.regs[target] = this.subWithBorrow(this.regs[target], instruction & 0xff);
      return;
    }

    if ((instruction & 0xfc00) === 0x4000) {
      const operation = (instruction >>> 6) & 0xf;
      const target = instruction & 7;
      const source = (instruction >>> 3) & 7;
      const a = this.regs[target];
      const b = this.regs[source];
      switch (operation) {
        case 0x0:
          this.regs[target] = this.setNz(a & b);
          return;
        case 0x1:
          this.regs[target] = this.setNz(a ^ b);
          return;
        case 0x2:
          this.regs[target] = this.shiftLeft(a, b & 0xff);
          return;
        case 0x3:
          this.regs[target] = this.shiftRight(a, b & 0xff);
          return;
        case 0x4:
          this.regs[target] = this.arithmeticShiftRight(a, b & 0xff);
          return;
        case 0x5:
          this.regs[target] = this.addWithCarry(a, b, this.c);
          return;
        case 0x6:
          this.regs[target] = this.addWithCarry(a, ~b >>> 0, this.c);
          return;
        case 0x7: {
          const rotation = b & 0x1f;
          if (rotation === 0) {
            this.c = (a >>> 31) & 1;
            this.regs[target] = this.setNz(a);
          } else {
            const result = ((a >>> rotation) | (a << (32 - rotation))) >>> 0;
            this.c = (result >>> 31) & 1;
            this.regs[target] = this.setNz(result);
          }
          return;
        }
        case 0x8:
          this.setNz(a & b);
          return;
        case 0x9:
          this.regs[target] = this.subWithBorrow(0, b);
          return;
        case 0xa:
          this.subWithBorrow(a, b);
          return;
        case 0xb:
          this.addWithCarry(a, b, 0);
          return;
        case 0xc:
          this.regs[target] = this.setNz(a | b);
          return;
        case 0xd:
          this.regs[target] = this.setNz(Math.imul(a, b) >>> 0);
          return;
        case 0xe:
          this.regs[target] = this.setNz(a & ~b);
          return;
        default:
          this.regs[target] = this.setNz(~a);
          return;
      }
    }

    if ((instruction & 0xfc00) === 0x4400) {
      const operation = (instruction >>> 8) & 3;
      const target = ((instruction >>> 4) & 8) | (instruction & 7);
      const source = (instruction >>> 3) & 0xf;
      if (operation === 0) this.regs[target] = (this.regs[target] + this.regs[source]) >>> 0;
      else if (operation === 1) this.subWithBorrow(this.regs[target], this.regs[source]);
      else if (operation === 2) this.regs[target] = this.regs[source];
      else {
        const branchAddress = this.regs[source];
        if (branchAddress >>> 28 === 0xf) this.exceptionReturn();
        else this.regs[15] = branchAddress & ~1;
      }
      return;
    }

    if ((instruction & 0xf800) === 0x4800) {
      const target = (instruction >>> 8) & 7;
      const offset = (instruction & 0xff) * 4;
      this.regs[target] = this.read32((((pc + 4) & ~3) + offset) >>> 0);
      return;
    }

    if ((instruction & 0xf000) === 0x5000) {
      const operation = (instruction >>> 9) & 7;
      const target = instruction & 7;
      const base = (instruction >>> 3) & 7;
      const index = (instruction >>> 6) & 7;
      this.loadStore(operation, target, (this.regs[base] + this.regs[index]) >>> 0);
      return;
    }

    if ((instruction & 0xe000) === 0x6000) {
      const load = (instruction & 0x0800) !== 0;
      const byte = (instruction & 0x1000) !== 0;
      const target = instruction & 7;
      const base = (instruction >>> 3) & 7;
      const offset = ((instruction >>> 6) & 0x1f) * (byte ? 1 : 4);
      const address = (this.regs[base] + offset) >>> 0;
      if (byte) {
        if (load) this.regs[target] = this.readByte(address);
        else this.writeByte(address, this.regs[target]);
      } else if (load) this.regs[target] = this.read32(address);
      else this.write32(address, this.regs[target]);
      return;
    }

    if ((instruction & 0xf000) === 0x8000) {
      const load = (instruction & 0x0800) !== 0;
      const target = instruction & 7;
      const base = (instruction >>> 3) & 7;
      const offset = ((instruction >>> 6) & 0x1f) * 2;
      const address = (this.regs[base] + offset) >>> 0;
      if (load)
        this.regs[target] = (this.readByte(address) | (this.readByte(address + 1) << 8)) >>> 0;
      else {
        this.writeByte(address, this.regs[target] & 0xff);
        this.writeByte(address + 1, (this.regs[target] >>> 8) & 0xff);
      }
      return;
    }

    if ((instruction & 0xf000) === 0x9000) {
      const load = (instruction & 0x0800) !== 0;
      const target = (instruction >>> 8) & 7;
      const address = (this.regs[13] + (instruction & 0xff) * 4) >>> 0;
      if (load) this.regs[target] = this.read32(address);
      else this.write32(address, this.regs[target]);
      return;
    }

    if ((instruction & 0xf000) === 0xa000) {
      const target = (instruction >>> 8) & 7;
      const base = this.regs[(instruction & 0x0800) !== 0 ? 13 : 15];
      this.regs[target] = (base + (instruction & 0xff) * 4) >>> 0;
      return;
    }

    if ((instruction & 0xff80) === 0xb000) {
      const amount = (instruction & 0x7f) * 4;
      this.regs[13] =
        (instruction & 0x80) !== 0
          ? (this.regs[13] - amount) >>> 0
          : (this.regs[13] + amount) >>> 0;
      return;
    }

    if ((instruction & 0xfe00) === 0xb400) {
      this.pushRegisters(instruction & 0xff, (instruction & 0x100) !== 0);
      return;
    }
    if ((instruction & 0xfe00) === 0xbc00) {
      this.popRegisters(instruction & 0xff, (instruction & 0x100) !== 0);
      return;
    }

    if ((instruction & 0xff00) === 0xbf00) {
      if ((instruction & 0xf) !== 0) this.itstate = instruction & 0xff;
      return;
    }

    if ((instruction & 0xffe0) === 0xb660) {
      const disable = (instruction & 0x10) !== 0;
      const flags = instruction & 7;
      if (flags & 4) throw new Error('CPS with the A flag is not modelled');
      if (flags & 1) throw new Error('CPS with the F flag is not modelled');
      if (flags & 2) this.primask = disable ? 1 : 0;
      return;
    }

    if ((instruction & 0xf000) === 0xd000) {
      const condition = (instruction >>> 8) & 0xf;
      const passes = this.conditionPasses(condition);
      const stats = this.conditionStats.get(condition) ?? { taken: 0, skipped: 0 };
      if (passes) stats.taken++;
      else stats.skipped++;
      this.conditionStats.set(condition, stats);
      if (passes) {
        this.regs[15] = (this.regs[15] + (((instruction & 0xff) << 24) >> 23) + 2) >>> 0;
      }
      return;
    }

    if ((instruction & 0xf800) === 0xe000) {
      this.regs[15] = (this.regs[15] + (((instruction & 0x7ff) << 21) >> 20) + 2) >>> 0;
      return;
    }

    throw new Error(
      `unsupported 16-bit instruction 0x${instruction.toString(16)} at 0x${(pc >>> 0).toString(16)}`,
    );
  }

  loadStore(operation, target, address) {
    switch (operation) {
      case 0:
        this.write32(address, this.regs[target]);
        return;
      case 1:
        this.writeByte(address, this.regs[target] & 0xff);
        this.writeByte(address + 1, (this.regs[target] >>> 8) & 0xff);
        return;
      case 2:
        this.writeByte(address, this.regs[target]);
        return;
      case 3:
        this.regs[target] = (this.readByte(address) << 24) >> 24;
        return;
      case 4:
        this.regs[target] = this.read32(address);
        return;
      case 5:
        this.regs[target] = (this.readByte(address) | (this.readByte(address + 1) << 8)) >>> 0;
        return;
      case 6:
        this.regs[target] = this.readByte(address);
        return;
      default:
        this.regs[target] =
          ((this.readByte(address) | (this.readByte(address + 1) << 8)) << 16) >> 16;
        return;
    }
  }

  executeWide(pc, first, second) {
    if ((first & 0xfb00) === 0xf200) {
      const moveTop = (first & 0x0080) !== 0;
      const immediate =
        (((first & 0x000f) << 12) |
          (((first >>> 10) & 1) << 11) |
          (((second >>> 12) & 7) << 8) |
          (second & 0xff)) >>>
        0;
      const target = (second >>> 8) & 0xf;
      if (moveTop) this.regs[target] = ((this.regs[target] & 0xffff) | (immediate << 16)) >>> 0;
      else this.regs[target] = ((this.regs[target] & 0xffff0000) | immediate) >>> 0;
      return;
    }

    if ((first & 0xf800) === 0xf000 && (second & 0xc000) === 0xc000) {
      const sign = (first >>> 10) & 1;
      const j1 = (second >>> 13) & 1;
      const j2 = (second >>> 11) & 1;
      const i1 = ~(j1 ^ sign) & 1;
      const i2 = ~(j2 ^ sign) & 1;
      let offset =
        (sign << 24) |
        (i1 << 23) |
        (i2 << 22) |
        (((first & 0x03ff) << 12) | ((second & 0x07ff) << 1));
      offset = (offset << 7) >> 7;
      this.regs[14] = (pc + 4) | 1;
      this.regs[15] = (pc + 4 + offset) >>> 0;
      return;
    }

    throw new Error(
      `unsupported 32-bit instruction ${first.toString(16)} ${second.toString(16)} at 0x${(pc >>> 0).toString(16)}`,
    );
  }
}

export { Machine };
export const createMachine = (bytes, options) => new Machine(bytes, options);
