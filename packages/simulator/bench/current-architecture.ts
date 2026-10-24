/**
 * Baseline harness: the "current architecture" the unified prototype replaces.
 *
 * One `@mica-js/ir` module per device, mounted on the core scheduler, with the
 * electrical net resolved in JavaScript between the two device entries:
 *
 * ```text
 * tick():
 *   schedule mcu.tick   @ t   -> flips PA0, sets the pin mode
 *   schedule net.solve  @ t   -> JS: read mcu registers, write led.anode
 *   schedule led.update @ t   -> samples anode, writes the lamp state
 *   scheduler.start({ until: t })
 * ```
 *
 * That is three host entries per simulated tick — one per device plus the net
 * bridge — each paying the scheduler's event bookkeeping and the engine's
 * per-execution entry fee. The prototype's claim is precisely that these
 * boundaries can be removed, so this harness deliberately keeps them.
 */
import { createIRSchedulerInstance, createScheduler } from '@mica-js/core';
import { createIRModule } from '@mica-js/ir';
import { PIN_MODE, createModuleValidation } from '../src/index';

export interface CurrentArchitecture {
  /** Advances the MCU, the net, and the LED by one simulated tick. */
  tick(): void;
  /** Completed ticks, i.e. the virtual time in picoseconds. */
  readonly ticks: number;
  /** Lamp state as written by the LED module. */
  readLed(): boolean;
}

/** Builds the two-module + scheduler baseline of the MCU + LED circuit. */
export function createCurrentArchitecture(): CurrentArchitecture {
  // MCU module: PA0 output value and mode.
  const mcuModule = createIRModule();
  const mcuOutput = mcuModule.state('pa0_output', 'bool', false);
  const mcuMode = mcuModule.state('pa0_mode', 'u8', PIN_MODE.highZ);
  const mcuTick = mcuModule.entry('tick', []);
  mcuTick.body((b) => {
    b.state.store(mcuOutput, b.bool.not(b.state.load(mcuOutput)));
    b.state.store(mcuMode, b.const('u8', PIN_MODE.pushPull));
    b.return([]);
  });

  // LED module: the anode level the host publishes, plus the lamp state.
  const ledModule = createIRModule();
  const ledAnode = ledModule.state('anode', 'bool', false);
  const ledLamp = ledModule.state('led_on', 'bool', false);
  const ledUpdate = ledModule.entry('update', []);
  ledUpdate.body((b) => {
    // The cathode sits on ground, so the lamp follows the anode alone.
    b.state.store(ledLamp, b.state.load(ledAnode));
    b.return([]);
  });

  const scheduler = createScheduler({
    maxStepsPerEntry: 1_000_000,
    maxEntriesPerTime: 1_000_000,
  });
  const mcu = createIRSchedulerInstance(scheduler, {
    instanceId: 'mcu',
    module: mcuModule,
    validation: createModuleValidation(mcuModule),
  });
  const led = createIRSchedulerInstance(scheduler, {
    instanceId: 'led',
    module: ledModule,
    validation: createModuleValidation(ledModule),
  });
  const solveTarget = Object.freeze({
    name: 'solve',
    kind: 'event' as const,
    params: Object.freeze([] as const),
  });
  const net = scheduler.addInstance({
    instanceId: 'net',
    targets: [solveTarget],
    executor: {
      execute(): void {
        // The host boundary: cross-module register reads and a cross-module store.
        const mode = mcu.storage.loadState(mcuMode);
        const output = mcu.storage.loadState(mcuOutput);
        led.storage.storeState(ledAnode, mode === PIN_MODE.pushPull && output === true);
      },
    },
  });

  let time = 0;
  return Object.freeze({
    tick(): void {
      mcu.at(mcuTick, time, []);
      net.at(solveTarget, time, []);
      led.at(ledUpdate, time, []);
      scheduler.start({ until: time });
      time += 1;
    },
    get ticks(): number {
      return time;
    },
    readLed: (): boolean => led.storage.loadState(ledLamp) === true,
  });
}
