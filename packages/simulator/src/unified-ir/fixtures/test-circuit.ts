import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type {
  IRExecutionContext,
  IRInterpreter,
  IRValidationOptions,
  RuntimeScalar,
} from '@mica-js/ir';
import { generateUnifiedIR } from '../codegen';
import {
  UNIFIED_PIN_CAPACITY,
  UnifiedCircuitError,
  devicePinId,
  type PinMode,
  type UnifiedCircuit,
  type UnifiedCircuitConfig,
  type UnifiedCircuitOptions,
} from '../types';

/** The generated entries take no arguments, so one frozen array is reused. */
const NO_ARGS: readonly RuntimeScalar[] = Object.freeze([]);

/**
 * Compiles a unified circuit.
 *
 * Every device, every net, and the main loop live in one `@mica-js/ir` module,
 * so one `tick()` is one engine call:
 *
 * ```ts
 * const circuit = createUnifiedCircuit(createMcuLedCircuit().config);
 * circuit.tick();                                   // mcu tick + net solve + led update
 * expect(circuit.ledOn('led')).toBe(true);
 * ```
 *
 * @throws {UnifiedCircuitError} when the config is invalid.
 */
export function createUnifiedCircuit(
  config: UnifiedCircuitConfig,
  options: UnifiedCircuitOptions = {},
): UnifiedCircuit {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new UnifiedCircuitError('unified-invalid-config', 'Expected circuit options');
  }
  const engine = options.engine ?? 'jit';
  if (engine !== 'jit' && engine !== 'reference') {
    throw new UnifiedCircuitError(
      'unified-invalid-config',
      `engine=${String(engine)} must be "jit" or "reference"`,
    );
  }
  const tierUpThreshold = options.tierUpThreshold ?? 0;
  if (!Number.isSafeInteger(tierUpThreshold) || tierUpThreshold < 0) {
    throw new UnifiedCircuitError(
      'unified-invalid-config',
      `tierUpThreshold=${String(tierUpThreshold)} must be a non-negative safe integer`,
    );
  }

  const program = generateUnifiedIR(config);
  const validation: IRValidationOptions = options.validation?.(program) ?? program.validation;
  if (validation === null || typeof validation !== 'object') {
    throw new UnifiedCircuitError('unified-invalid-config', 'validation must return a grant');
  }
  const context: IRExecutionContext = Object.freeze({
    instanceId: options.instanceId ?? 'unified-circuit',
    virtualTime: 0,
  });
  const runtime: IRInterpreter =
    engine === 'reference'
      ? createIRInterpreter(program.module, {
          validation,
          maxSteps: Number.MAX_SAFE_INTEGER,
        })
      : createIRJIT(program.module, {
          validation,
          maxSteps: Number.MAX_SAFE_INTEGER,
          jit: { tierUpThreshold },
        });

  const leds = new Map(program.leds.map((led) => [led.config.deviceId, led]));
  const devices = new Map(program.devices.map((device) => [device.deviceId, device]));
  let ticks = 0;

  const tick = (): void => {
    runtime.execute(program.step, NO_ARGS, context);
    ticks += 1;
  };

  const pin = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= UNIFIED_PIN_CAPACITY) {
      throw new UnifiedCircuitError(
        'unified-invalid-pin',
        `Pin ${String(value)} is outside the global pin space [0, ${UNIFIED_PIN_CAPACITY})`,
        { pinId: value },
      );
    }
    return value;
  };

  return Object.freeze({
    program,
    runtime,
    validation,
    get ticks(): number {
      return ticks;
    },
    tick,
    run(count: number): void {
      if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff) {
        throw new UnifiedCircuitError(
          'unified-invalid-config',
          `run(${String(count)}) needs a u32 tick count`,
        );
      }
      if (count === 0) return;
      // One engine call for the whole batch: the loop lives in the generated IR.
      runtime.execute(program.tick, [count], context);
      ticks += count;
    },
    readPinMode(value: number): PinMode {
      return Number(runtime.storage.loadArray(program.memory.mode, pin(value))) as PinMode;
    },
    readPinOutput(value: number): boolean {
      return runtime.storage.loadArray(program.memory.output, pin(value)) === true;
    },
    readPinInput(value: number): boolean {
      return runtime.storage.loadArray(program.memory.input, pin(value)) === true;
    },
    writePinMode(value: number, mode: PinMode): void {
      runtime.storage.storeArray(program.memory.mode, pin(value), mode);
    },
    writePinInput(value: number, level: boolean): void {
      runtime.storage.storeArray(program.memory.input, pin(value), level);
    },
    ledOn(deviceId: string): boolean {
      const led = leds.get(deviceId);
      if (led === undefined) {
        throw new UnifiedCircuitError(
          'unified-unknown-device',
          `Circuit has no LED named "${deviceId}"`,
          { deviceId },
        );
      }
      return runtime.storage.loadArray(program.memory.ledState, led.stateIndex) === true;
    },
    pinOf(deviceId: string, pinName: string): number {
      const device = devices.get(deviceId);
      if (device === undefined) {
        throw new UnifiedCircuitError(
          'unified-unknown-device',
          `Circuit has no device named "${deviceId}"`,
          { deviceId },
        );
      }
      return devicePinId(device, pinName);
    },
  });
}
