/**
 * Typed accessor for the unified-IR teaching MCU (U03).
 *
 * The accessor is the only surface that knows the IR storage layout. Callers
 * go through register names, absolute byte addresses, GPIO port names and IRQ
 * numbers; array indices, state refs and memory offsets stay private.
 *
 * ```ts
 * const mcu = createTeachingMCUIR('mcu');
 * const accessor = mcu.buildAccessor(jit.storage, {
 *   step: () => jit.execute(mcu.layout.entries.tick, []),
 * });
 * accessor.writeRegister('r0', 0x2an);
 * accessor.step();
 * expect(accessor.readRegister('pc')).toBe(0x2an);
 * ```
 */
import type {
  ArrayRef,
  BytesRef,
  Endian,
  NumericType,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  WritableBytesRef,
} from '@mica-js/ir';
import type { McuAccessor } from '../../runtime/types';
import { PIN_MODE } from '../../pin-space';
import { TeachingMCUError } from './teaching-mcu.errors';
import type { TeachingMCULayout, TeachingMCUPin, TeachingMCUISAType } from './teaching-mcu';

/** Storage subset the accessor needs; `IRStorage` satisfies it structurally. */
export interface StorageAccessor {
  loadState<T extends ScalarType>(ref: StateRef<T>): RuntimeScalar;
  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void;
  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): RuntimeScalar;
  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void;
  loadBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: ReadableBytesRef,
    offset: number,
  ): RuntimeScalar;
  storeBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: WritableBytesRef,
    offset: number,
    value: RuntimeScalar,
  ): void;
  /**
   * Host-only versioned update for read-only byte regions. `IRStorage` already
   * provides it; accessors without it reject {@link TeachingMCUAccessor.patchFirmware}.
   */
  updateBytesFromBytes?(ref: BytesRef, offset: number, bytes: Uint8Array): void;
}

/** Optional host services used by `step()` / disposal checks. */
export interface TeachingMCUAccessorOptions {
  /** Invoked before every access; the owning circuit throws once disposed. */
  readonly assertActive?: () => void;
  /** Executes one circuit tick. */
  readonly step?: () => void;
  /** Executes `count` circuit ticks in one engine call. */
  readonly runBatch?: (count: number) => void;
}

/** NZCV view of the guest status register. */
export interface TeachingMCUFlags {
  readonly n: boolean;
  readonly z: boolean;
  readonly c: boolean;
  readonly v: boolean;
}

/** One GPIO port triple. */
export interface TeachingMCUGpioState {
  readonly output: number;
  readonly direction: number;
  readonly input: number;
}

/** NVIC bit-field view. */
export interface TeachingMCUNvicSnapshot {
  readonly enabled: number;
  readonly pending: number;
  readonly active: number;
  readonly priority: number;
}

/** Complete observable state of one teaching MCU. */
export interface TeachingMCUSnapshot {
  readonly pc: number;
  readonly sp: number;
  readonly lr: number;
  readonly cycles: number;
  readonly ipsr: number;
  readonly halted: boolean;
  readonly faulted: boolean;
  readonly sleeping: boolean;
  readonly flags: TeachingMCUFlags;
  readonly registers: readonly number[];
  readonly gpio: Readonly<Record<string, TeachingMCUGpioState>>;
  readonly nvic: TeachingMCUNvicSnapshot;
}

/**
 * High-level MCU surface. Extends the generic `McuAccessor`, so code written
 * against `readRegister`/`writeRegister`/`readPin` keeps working.
 */
export interface TeachingMCUAccessor extends McuAccessor {
  /** Instruction set executed by this instance. */
  readonly isa: TeachingMCUISAType;
  /** Guest register count (16). */
  readonly registerCount: number;
  /** GPIO port names in declaration order. */
  readonly ports: readonly string[];
  /** `r0`–`r15` plus `pc`, `sp`, `lr`, `xpsr`, `cycles`, `ipsr`. */
  readonly registerNames: readonly string[];
  /** Reads one register as a bigint bit pattern. */
  readRegister(name: string | number): bigint;
  /** Writes one register; values are truncated to 32 bits. */
  writeRegister(name: string | number, value: bigint | number): void;
  /** Reads one byte (default) or one little-endian word from the guest map. */
  readMemory(address: number, width?: 1 | 4): number;
  /** Writes one byte (default) or one little-endian word. Flash writes throw. */
  writeMemory(address: number, value: number, width?: 1 | 4): void;
  /** Reads `length` bytes starting at `address`. */
  readMemoryBlock(address: number, length: number): Uint8Array;
  /** Writes `bytes` starting at `address`; rejects ranges touching flash. */
  writeMemoryBlock(address: number, bytes: Uint8Array): void;
  /**
   * Replaces instruction bytes at `address` as the host (the legacy
   * `firmwarePatch` path). Affected provider blocks are invalidated and the
   * writable data mirror is updated; guest stores still cannot touch flash.
   */
  patchFirmware(address: number, bytes: Uint8Array): void;
  /** Reads the GPIO output-data register (ODR). */
  readGPIO(port: string | number): number;
  /** Writes the GPIO output-data register (ODR). */
  writeGPIO(port: string | number, value: number): void;
  /** Reads the GPIO input-data register (IDR) sampled by the solver. */
  readGPIOInput(port: string | number): number;
  /** Reads the GPIO direction register (`1` = output). */
  readGPIODirection(port: string | number): number;
  /** Writes the GPIO direction register. */
  writeGPIODirection(port: string | number, mask: number): void;
  getPC(): number;
  setPC(value: number): void;
  getSP(): number;
  setSP(value: number): void;
  getLR(): number;
  setLR(value: number): void;
  getCycles(): number;
  getIPSR(): number;
  getFlags(): TeachingMCUFlags;
  setFlags(flags: Partial<TeachingMCUFlags>): void;
  toXPSR(): number;
  isHalted(): boolean;
  isFaulted(): boolean;
  isSleeping(): boolean;
  /** Latches one IRQ in the NVIC pending register. */
  raiseInterrupt(irq: number): void;
  /** Clears one NVIC pending bit. */
  clearInterrupt(irq: number): void;
  /** Enables one NVIC IRQ line. */
  enableInterrupt(irq: number): void;
  /** Disables one NVIC IRQ line. */
  disableInterrupt(irq: number): void;
  isInterruptPending(irq: number): boolean;
  isInterruptActive(irq: number): boolean;
  readInterruptRegisters(): TeachingMCUNvicSnapshot;
  /** Executes `count` circuit ticks (one instruction per tick by default). */
  step(count?: number): void;
  /** Alias of {@link step}. */
  run(count: number): void;
  /** Reads the solved level on one of the device's input pins. */
  readPinInput(pinName: string): boolean;
  snapshot(): TeachingMCUSnapshot;
}

/** Layout registry used by the two-argument `buildAccessor` form. */
const layouts = new Map<string, TeachingMCULayout>();

/** Registers the layout of one generated device; used by `createTeachingMCUIR`. */
export function registerTeachingMCULayout(deviceId: string, layout: TeachingMCULayout): void {
  layouts.set(deviceId, layout);
}

/** Drops one registered layout (or every layout when called without an id). */
export function unregisterTeachingMCULayout(deviceId?: string): void {
  if (deviceId === undefined) {
    layouts.clear();
    return;
  }
  layouts.delete(deviceId);
}

/**
 * Builds the typed accessor of one teaching MCU.
 *
 * @param deviceId Circuit-unique device id.
 * @param storage Live engine storage.
 * @param layout Layout produced by the IR factory. When omitted, the layout
 *   registered by `createTeachingMCUIR` for `deviceId` is used.
 */
export function buildAccessor(
  deviceId: string,
  storage: StorageAccessor,
  layout?: TeachingMCULayout,
  options: TeachingMCUAccessorOptions = {},
): TeachingMCUAccessor {
  const resolved = layout ?? layouts.get(deviceId);
  if (resolved === undefined) {
    throw new TeachingMCUError(
      'layout-not-found',
      `Teaching MCU "${deviceId}" has no registered IR layout; pass the layout or call createTeachingMCUIR first`,
      { deviceId },
    );
  }
  const target = resolved;

  const active = (): void => options.assertActive?.();

  const loadU32 = (offset: number): number =>
    Number(storage.loadBytes('u32', 'little', target.memory, offset));
  const storeU32 = (offset: number, value: number): void =>
    storage.storeBytes('u32', 'little', target.memory, offset, value >>> 0);
  const loadU8 = (offset: number): number =>
    Number(storage.loadBytes('u8', 'little', target.memory, offset));
  const storeU8 = (offset: number, value: number): void =>
    storage.storeBytes('u8', 'little', target.memory, offset, value & 0xff);
  const loadRegister = (index: number): number =>
    Number(storage.loadArray(target.registers, index));
  const storeRegister = (index: number, value: number): void =>
    storage.storeArray(target.registers, index, value >>> 0);
  const loadBool = (ref: StateRef<'bool'>): boolean => storage.loadState(ref) === true;
  const storeBool = (ref: StateRef<'bool'>, value: boolean): void => storage.storeState(ref, value);
  const loadStateU32 = (ref: StateRef<'u32'>): number => Number(storage.loadState(ref));
  const storeStateU32 = (ref: StateRef<'u32'>, value: number): void =>
    storage.storeState(ref, value >>> 0);

  const gpioOffset = (portIndex: number, register: number): number =>
    target.peripheralOffset + portIndex * 0x10 + register;
  const nvicOffset = (register: number): number => target.nvicOffset + register;

  const setNvic = (ref: StateRef<'u32'>, memoryRegister: number, next: number): void => {
    storeStateU32(ref, next);
    storeU32(nvicOffset(memoryRegister), next);
  };

  /**
   * Publishes one port's ODR/DIR words into the shared pin memory. The host
   * writes registers through the accessor, so this keeps pin levels current
   * without paying for a GPIO sync in every generated tick.
   */
  const syncPort = (portIndex: number): void => {
    const odr = loadU32(gpioOffset(portIndex, 0x00));
    const dir = loadU32(gpioOffset(portIndex, 0x04));
    for (const pin of target.pins.values()) {
      if (pin.portIndex !== portIndex) continue;
      const mask = (1 << pin.bit) >>> 0;
      storage.storeArray(
        target.pinMemory.mode,
        pin.globalPinId,
        (dir & mask) !== 0 ? PIN_MODE.pushPull : PIN_MODE.highZ,
      );
      storage.storeArray(target.pinMemory.output, pin.globalPinId, (odr & mask) !== 0);
    }
  };

  const syncPortsInRange = (startOffset: number, length: number): void => {
    const gpioStart = target.peripheralOffset;
    const gpioEnd = gpioStart + target.portCount * 0x10;
    const end = startOffset + length;
    if (end <= gpioStart || startOffset >= gpioEnd) return;
    const first = Math.max(startOffset, gpioStart);
    const last = Math.min(end - 1, gpioEnd - 1);
    for (
      let portIndex = Math.floor((first - gpioStart) / 0x10);
      portIndex <= Math.floor((last - gpioStart) / 0x10);
      portIndex += 1
    ) {
      syncPort(portIndex);
    }
  };

  /** Mirrors host writes to the NVIC MMIO window into the scalar register file. */
  const syncNvicStates = (startOffset: number, length: number): void => {
    const nvicStart = target.nvicOffset;
    const nvicEnd = nvicStart + 0x20;
    if (startOffset + length <= nvicStart || startOffset >= nvicEnd) return;
    storage.storeState(target.nvic.enabled, loadU32(nvicOffset(0x00)));
    storage.storeState(target.nvic.pending, loadU32(nvicOffset(0x04)));
    storage.storeState(target.nvic.active, loadU32(nvicOffset(0x08)));
    storage.storeState(target.nvic.priority, loadU32(nvicOffset(0x0c)));
  };

  const assertIrq = (irq: number): void => {
    if (!Number.isInteger(irq) || irq < 0 || irq >= target.config.irqCount) {
      throw new TeachingMCUError(
        'invalid-value',
        `IRQ must be an integer in [0, ${target.config.irqCount - 1}], received ${String(irq)}`,
        { deviceId },
      );
    }
  };

  const portIndex = (port: string | number): number => {
    if (typeof port === 'number') {
      if (!Number.isInteger(port) || port < 0 || port >= target.portCount) {
        throw new TeachingMCUError(
          'unknown-port',
          `Port index ${String(port)} is outside [0, ${target.portCount - 1}]`,
          { deviceId },
        );
      }
      return port;
    }
    const normalized = port.trim().toUpperCase().replace(/^GPIO/, '').replace(/^P/, '');
    const index = target.config.ports.findIndex((entry) => entry.toUpperCase() === normalized);
    if (index < 0) {
      throw new TeachingMCUError(
        'unknown-port',
        `Port "${port}" is not one of [${target.config.ports.join(', ')}]`,
        { deviceId },
      );
    }
    return index;
  };

  const registerIndex = (name: string | number): number => {
    if (typeof name === 'number') {
      if (!Number.isInteger(name) || name < 0 || name >= target.registerCount) {
        throw new TeachingMCUError(
          'unknown-register',
          `Register index ${String(name)} is outside [0, ${target.registerCount - 1}]`,
          { deviceId },
        );
      }
      return name;
    }
    const normalized = name.trim().toLowerCase();
    if (normalized === 'sp') return 13;
    if (normalized === 'lr') return 14;
    const match = /^r(\d+)$/.exec(normalized);
    if (match === null) {
      throw new TeachingMCUError(
        'unknown-register',
        `Register "${name}" is not one of [${target.registerNames.join(', ')}]`,
        { deviceId },
      );
    }
    const index = Number(match[1]);
    if (index < 0 || index >= target.registerCount) {
      throw new TeachingMCUError(
        'unknown-register',
        `Register "${name}" is outside [r0, r${target.registerCount - 1}]`,
        { deviceId },
      );
    }
    return index;
  };

  const memoryOffset = (address: number): number => {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff_ffff) {
      return -1;
    }
    if (address < target.flashSize) return address;
    if (address >= target.ramBase && address < target.ramBase + target.ramSize) {
      return target.flashSize + (address - target.ramBase);
    }
    if (
      address >= target.peripheralBase &&
      address < target.peripheralBase + target.peripheralSize
    ) {
      return target.peripheralOffset + (address - target.peripheralBase);
    }
    return -1;
  };

  const requireMemoryOffset = (address: number): number => {
    const offset = memoryOffset(address);
    if (offset < 0) {
      throw new TeachingMCUError(
        'address-out-of-range',
        `Address 0x${address.toString(16)} is outside the teaching MCU memory map`,
        { deviceId, address },
      );
    }
    return offset;
  };

  const findPin = (pinName: string): TeachingMCUPin => {
    const pin =
      target.pins.get(pinName) ??
      [...target.pins.values()].find((entry) => entry.name.toUpperCase() === pinName.toUpperCase());
    if (pin === undefined) {
      throw new TeachingMCUError(
        'unknown-pin',
        `Device "${deviceId}" has no pin "${pinName}". Available: [${target.pinNames.join(', ')}]`,
        { deviceId, pinName },
      );
    }
    return pin;
  };

  const xpsr = (): number => {
    const n = loadBool(target.flags.n) ? SIGN_BIT : 0;
    const z = loadBool(target.flags.z) ? 0x4000_0000 : 0;
    const c = loadBool(target.flags.c) ? 0x2000_0000 : 0;
    const v = loadBool(target.flags.v) ? 0x1000_0000 : 0;
    return (n | z | c | v | (loadStateU32(target.ipsr) & 0x1ff)) >>> 0;
  };

  const accessor: TeachingMCUAccessor = {
    deviceId,
    type: 'teaching-mcu-ir',
    pinNames: target.pinNames,
    stateNames: Object.freeze([
      ...target.registerNames,
      'pc',
      'sp',
      'lr',
      'xpsr',
      'cycles',
      'ipsr',
      'halted',
      'fault',
      'sleeping',
      'n',
      'z',
      'c',
      'v',
      ...target.config.ports.flatMap((port) => [`odr${port}`, `dir${port}`, `idr${port}`]),
    ]),
    registerNames: Object.freeze([
      ...target.registerNames,
      'pc',
      'sp',
      'lr',
      'xpsr',
      'cycles',
      'ipsr',
    ]),
    registerCount: target.registerCount,
    isa: target.isa,
    ports: target.config.ports,

    getPC(): number {
      active();
      return loadStateU32(target.pc);
    },
    setPC(value: number): void {
      active();
      storeStateU32(target.pc, value);
    },
    getSP(): number {
      active();
      return loadRegister(13);
    },
    setSP(value: number): void {
      active();
      storeRegister(13, value);
    },
    getLR(): number {
      active();
      return loadRegister(14);
    },
    setLR(value: number): void {
      active();
      storeRegister(14, value);
    },
    getCycles(): number {
      active();
      return loadStateU32(target.cycles);
    },
    getIPSR(): number {
      active();
      return loadStateU32(target.ipsr);
    },
    getFlags(): TeachingMCUFlags {
      active();
      return Object.freeze({
        n: loadBool(target.flags.n),
        z: loadBool(target.flags.z),
        c: loadBool(target.flags.c),
        v: loadBool(target.flags.v),
      });
    },
    setFlags(flags: Partial<TeachingMCUFlags>): void {
      active();
      if (flags.n !== undefined) storeBool(target.flags.n, flags.n);
      if (flags.z !== undefined) storeBool(target.flags.z, flags.z);
      if (flags.c !== undefined) storeBool(target.flags.c, flags.c);
      if (flags.v !== undefined) storeBool(target.flags.v, flags.v);
    },
    toXPSR(): number {
      active();
      return xpsr();
    },
    isHalted(): boolean {
      active();
      return loadBool(target.halted);
    },
    isFaulted(): boolean {
      active();
      return loadBool(target.fault);
    },
    isSleeping(): boolean {
      active();
      return loadBool(target.sleeping);
    },

    readRegister(name: string | number): bigint {
      active();
      const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (normalized === 'pc') return BigInt(loadStateU32(target.pc));
      if (normalized === 'xpsr') return BigInt(xpsr());
      if (normalized === 'cycles') return BigInt(loadStateU32(target.cycles));
      if (normalized === 'ipsr') return BigInt(loadStateU32(target.ipsr));
      return BigInt(loadRegister(registerIndex(name)));
    },
    writeRegister(name: string | number, value: bigint | number): void {
      active();
      const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
      const numeric = toU32(value, deviceId);
      if (normalized === 'pc') {
        storeStateU32(target.pc, numeric);
        return;
      }
      if (normalized === 'cycles') {
        storeStateU32(target.cycles, numeric);
        return;
      }
      if (normalized === 'ipsr') {
        storeStateU32(target.ipsr, numeric & 0x1ff);
        return;
      }
      if (normalized === 'xpsr') {
        storeBool(target.flags.n, (numeric & SIGN_BIT) !== 0);
        storeBool(target.flags.z, (numeric & 0x4000_0000) !== 0);
        storeBool(target.flags.c, (numeric & 0x2000_0000) !== 0);
        storeBool(target.flags.v, (numeric & 0x1000_0000) !== 0);
        storeStateU32(target.ipsr, numeric & 0x1ff);
        return;
      }
      storeRegister(registerIndex(name), numeric);
    },

    readMemory(address: number, width: 1 | 4 = 1): number {
      active();
      const offset = requireMemoryOffset(address);
      return width === 4 ? loadU32(offset) : loadU8(offset);
    },
    writeMemory(address: number, value: number, width: 1 | 4 = 1): void {
      active();
      const offset = requireMemoryOffset(address);
      if (offset < target.flashSize) {
        throw new TeachingMCUError(
          'flash-write',
          `Address 0x${address.toString(16)} is read-only instruction flash`,
          { deviceId, address },
        );
      }
      if (width === 4) storeU32(offset, value);
      else storeU8(offset, value);
      syncPortsInRange(offset, width);
      syncNvicStates(offset, width);
    },
    readMemoryBlock(address: number, length: number): Uint8Array {
      active();
      if (!Number.isInteger(length) || length < 0) {
        throw new TeachingMCUError(
          'invalid-value',
          `readMemoryBlock length must be a non-negative integer, received ${String(length)}`,
          { deviceId },
        );
      }
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = loadU8(requireMemoryOffset(address + index));
      }
      return bytes;
    },
    writeMemoryBlock(address: number, bytes: Uint8Array): void {
      active();
      if (!(bytes instanceof Uint8Array)) {
        throw new TeachingMCUError('invalid-value', 'writeMemoryBlock needs a Uint8Array', {
          deviceId,
        });
      }
      const startOffset = requireMemoryOffset(address);
      for (let index = 0; index < bytes.byteLength; index += 1) {
        const offset = requireMemoryOffset(address + index);
        if (offset < target.flashSize) {
          throw new TeachingMCUError(
            'flash-write',
            `Address 0x${(address + index).toString(16)} is read-only instruction flash`,
            { deviceId, address: address + index },
          );
        }
        storeU8(offset, bytes[index] as number);
      }
      syncPortsInRange(startOffset, bytes.byteLength);
      syncNvicStates(startOffset, bytes.byteLength);
    },
    patchFirmware(address: number, bytes: Uint8Array): void {
      active();
      if (!(bytes instanceof Uint8Array)) {
        throw new TeachingMCUError('invalid-value', 'patchFirmware needs a Uint8Array', {
          deviceId,
        });
      }
      if (
        !Number.isInteger(address) ||
        address < 0 ||
        address + bytes.byteLength > target.flashSize
      ) {
        throw new TeachingMCUError(
          'address-out-of-range',
          `patchFirmware range 0x${address.toString(16)}+${bytes.byteLength} is outside flash`,
          { deviceId, address },
        );
      }
      const update = storage.updateBytesFromBytes;
      if (update === undefined) {
        throw new TeachingMCUError(
          'update-unsupported',
          `Storage for teaching MCU "${deviceId}" does not support versioned firmware updates`,
          { deviceId },
        );
      }
      if (bytes.byteLength === 0) return;
      update.call(storage, target.flash, address, bytes);
      // Keep the writable unified image (flash copy + RAM + peripherals) in
      // sync so guest data loads see the patched instruction bytes too.
      for (let index = 0; index < bytes.byteLength; index += 1) {
        storeU8(address + index, bytes[index] as number);
      }
    },

    readGPIO(port: string | number): number {
      active();
      return loadU32(gpioOffset(portIndex(port), 0x00));
    },
    writeGPIO(port: string | number, value: number): void {
      active();
      const index = portIndex(port);
      storeU32(gpioOffset(index, 0x00), toU32(value, deviceId));
      syncPort(index);
    },
    readGPIOInput(port: string | number): number {
      active();
      return loadU32(gpioOffset(portIndex(port), 0x08));
    },
    readGPIODirection(port: string | number): number {
      active();
      return loadU32(gpioOffset(portIndex(port), 0x04));
    },
    writeGPIODirection(port: string | number, mask: number): void {
      active();
      const index = portIndex(port);
      storeU32(gpioOffset(index, 0x04), toU32(mask, deviceId));
      syncPort(index);
    },

    raiseInterrupt(irq: number): void {
      active();
      assertIrq(irq);
      const bit = (1 << irq) >>> 0;
      setNvic(target.nvic.pending, 0x04, loadStateU32(target.nvic.pending) | bit);
    },
    clearInterrupt(irq: number): void {
      active();
      assertIrq(irq);
      const bit = (1 << irq) >>> 0;
      setNvic(target.nvic.pending, 0x04, loadStateU32(target.nvic.pending) & ~bit);
    },
    enableInterrupt(irq: number): void {
      active();
      assertIrq(irq);
      const bit = (1 << irq) >>> 0;
      setNvic(target.nvic.enabled, 0x00, loadStateU32(target.nvic.enabled) | bit);
    },
    disableInterrupt(irq: number): void {
      active();
      assertIrq(irq);
      const bit = (1 << irq) >>> 0;
      setNvic(target.nvic.enabled, 0x00, loadStateU32(target.nvic.enabled) & ~bit);
    },
    isInterruptPending(irq: number): boolean {
      active();
      assertIrq(irq);
      return (loadStateU32(target.nvic.pending) & ((1 << irq) >>> 0)) !== 0;
    },
    isInterruptActive(irq: number): boolean {
      active();
      assertIrq(irq);
      return (loadStateU32(target.nvic.active) & ((1 << irq) >>> 0)) !== 0;
    },
    readInterruptRegisters(): TeachingMCUNvicSnapshot {
      active();
      return Object.freeze({
        enabled: loadStateU32(target.nvic.enabled),
        pending: loadStateU32(target.nvic.pending),
        active: loadStateU32(target.nvic.active),
        priority: loadStateU32(target.nvic.priority),
      });
    },

    step(count = 1): void {
      active();
      if (!Number.isInteger(count) || count < 0) {
        throw new TeachingMCUError(
          'invalid-value',
          `step(count) needs a non-negative integer, received ${String(count)}`,
          { deviceId },
        );
      }
      if (count === 0) return;
      if (count > 1 && options.runBatch !== undefined) {
        options.runBatch(count);
        return;
      }
      if (options.step === undefined) {
        throw new TeachingMCUError(
          'no-runner',
          `Teaching MCU "${deviceId}" was built without a runner; pass step/runBatch to buildAccessor`,
          { deviceId },
        );
      }
      for (let index = 0; index < count; index += 1) options.step();
    },
    run(count: number): void {
      accessor.step(count);
    },

    readPin(pinName: string): boolean {
      active();
      const pin = findPin(pinName);
      return storage.loadArray(target.pinMemory.output, pin.globalPinId) === true;
    },
    readPinInput(pinName: string): boolean {
      active();
      const pin = findPin(pinName);
      return storage.loadArray(target.pinMemory.input, pin.globalPinId) === true;
    },
    writePin(pinName: string, value: boolean): void {
      active();
      if (typeof value !== 'boolean') {
        throw new TeachingMCUError(
          'invalid-value',
          `Pin "${pinName}" needs a boolean level, received ${typeof value}`,
          { deviceId, pinName },
        );
      }
      const pin = findPin(pinName);
      storage.storeArray(target.pinMemory.output, pin.globalPinId, value);
    },

    getState(name: string): unknown {
      active();
      const normalized = name.trim().toLowerCase();
      if (normalized === 'pc') return loadStateU32(target.pc);
      if (normalized === 'cycles') return loadStateU32(target.cycles);
      if (normalized === 'ipsr') return loadStateU32(target.ipsr);
      if (normalized === 'xpsr') return xpsr();
      if (normalized === 'halted' || normalized === 'stopped') return loadBool(target.halted);
      if (normalized === 'fault' || normalized === 'guestfault') return loadBool(target.fault);
      if (normalized === 'sleeping') return loadBool(target.sleeping);
      if (normalized === 'n') return loadBool(target.flags.n);
      if (normalized === 'z') return loadBool(target.flags.z);
      if (normalized === 'c') return loadBool(target.flags.c);
      if (normalized === 'v') return loadBool(target.flags.v);
      const gpio = /^(odr|dir|idr)(.+)$/.exec(normalized);
      if (gpio !== null) {
        const register = gpio[1] === 'odr' ? 0x00 : gpio[1] === 'dir' ? 0x04 : 0x08;
        return loadU32(gpioOffset(portIndex(gpio[2] as string), register));
      }
      try {
        return loadRegister(registerIndex(name));
      } catch {
        throw new TeachingMCUError('unknown-state', `Device "${deviceId}" has no state "${name}"`, {
          deviceId,
          stateName: name,
        });
      }
    },
    setState(name: string, value: unknown): void {
      active();
      const normalized = name.trim().toLowerCase();
      if (normalized === 'halted' || normalized === 'stopped') {
        storeBool(target.halted, assertBoolean(name, value, deviceId));
        return;
      }
      if (normalized === 'fault' || normalized === 'guestfault') {
        storeBool(target.fault, assertBoolean(name, value, deviceId));
        return;
      }
      if (normalized === 'sleeping') {
        storeBool(target.sleeping, assertBoolean(name, value, deviceId));
        return;
      }
      if (normalized === 'n' || normalized === 'z' || normalized === 'c' || normalized === 'v') {
        const flag = target.flags[normalized];
        storeBool(flag, assertBoolean(name, value, deviceId));
        return;
      }
      const gpio = /^(odr|dir|idr)(.+)$/.exec(normalized);
      if (gpio !== null) {
        const register = gpio[1] === 'odr' ? 0x00 : gpio[1] === 'dir' ? 0x04 : 0x08;
        const index = portIndex(gpio[2] as string);
        storeU32(gpioOffset(index, register), assertNumber(name, value, deviceId));
        if (register !== 0x08) syncPort(index);
        return;
      }
      accessor.writeRegister(name, value as bigint | number);
    },

    snapshot(): TeachingMCUSnapshot {
      active();
      const gpio: Record<string, TeachingMCUGpioState> = {};
      for (const [index, port] of target.config.ports.entries()) {
        gpio[port] = Object.freeze({
          output: loadU32(gpioOffset(index, 0x00)),
          direction: loadU32(gpioOffset(index, 0x04)),
          input: loadU32(gpioOffset(index, 0x08)),
        });
      }
      return Object.freeze({
        pc: loadStateU32(target.pc),
        sp: loadRegister(13),
        lr: loadRegister(14),
        cycles: loadStateU32(target.cycles),
        ipsr: loadStateU32(target.ipsr),
        halted: loadBool(target.halted),
        faulted: loadBool(target.fault),
        sleeping: loadBool(target.sleeping),
        flags: accessor.getFlags(),
        registers: Object.freeze(
          Array.from({ length: target.registerCount }, (_, index) => loadRegister(index)),
        ),
        gpio: Object.freeze(gpio),
        nvic: Object.freeze({
          enabled: loadStateU32(target.nvic.enabled),
          pending: loadStateU32(target.nvic.pending),
          active: loadStateU32(target.nvic.active),
          priority: loadStateU32(target.nvic.priority),
        }),
      });
    },
  };

  return Object.freeze(accessor);
}

const SIGN_BIT = 0x8000_0000;

function toU32(value: bigint | number, deviceId: string): number {
  if (typeof value === 'bigint') {
    return Number(BigInt.asUintN(32, value));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TeachingMCUError(
      'invalid-value',
      `Register value must be a bigint or finite number, received ${String(value)}`,
      { deviceId },
    );
  }
  return value >>> 0;
}

function assertBoolean(name: string, value: unknown, deviceId: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TeachingMCUError(
      'invalid-value',
      `State "${name}" needs a boolean, received ${typeof value}`,
      { deviceId, stateName: name },
    );
  }
  return value;
}

function assertNumber(name: string, value: unknown, deviceId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TeachingMCUError(
      'invalid-value',
      `State "${name}" needs a finite number, received ${String(value)}`,
      { deviceId, stateName: name },
    );
  }
  return value >>> 0;
}
