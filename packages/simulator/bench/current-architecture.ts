/**
 * Baseline harness: the "current architecture" the unified prototype replaces.
 *
 * One `@mica-js/ir` module per device, mounted on the core scheduler, with the
 * electrical net resolved in JavaScript between the two device entries:
 *
 * ```text
 * tick():
 *   schedule driver.tick   @ t   -> flips PA0, sets the pin mode
 *   schedule net.solve  @ t   -> JS: read driver registers, write sink.anode
 *   schedule sink.update @ t   -> samples anode, writes the lamp state
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
import { PIN_MODE } from '../src/unified-ir/pin-space';
import { createModuleValidation } from '../src/unified-ir/validation';

export interface CurrentArchitecture {
  /** Advances the driver, the net, and the sink by one simulated tick. */
  tick(): void;
  /** Completed ticks, i.e. the virtual time in picoseconds. */
  readonly ticks: number;
  /** Lamp state as written by the sink module. */
  readLamp(): boolean;
}

/** Builds the two-module + scheduler baseline of the driver + sink circuit. */
export function createCurrentArchitecture(): CurrentArchitecture {
  // driver module: PA0 output value and mode.
  const driverModule = createIRModule();
  const driverOutput = driverModule.state('pa0_output', 'bool', false);
  const driverMode = driverModule.state('pa0_mode', 'u8', PIN_MODE.highZ);
  const driverTick = driverModule.entry('tick', []);
  driverTick.body((b) => {
    b.state.store(driverOutput, b.bool.not(b.state.load(driverOutput)));
    b.state.store(driverMode, b.const('u8', PIN_MODE.pushPull));
    b.return([]);
  });

  // sink module: the anode level the host publishes, plus the lamp state.
  const sinkModule = createIRModule();
  const sinkAnode = sinkModule.state('anode', 'bool', false);
  const sinkLamp = sinkModule.state('lamp', 'bool', false);
  const sinkUpdate = sinkModule.entry('update', []);
  sinkUpdate.body((b) => {
    // The cathode sits on ground, so the lamp follows the anode alone.
    b.state.store(sinkLamp, b.state.load(sinkAnode));
    b.return([]);
  });

  const scheduler = createScheduler({
    maxStepsPerEntry: 1_000_000,
    maxEntriesPerTime: 1_000_000,
  });
  const driver = createIRSchedulerInstance(scheduler, {
    instanceId: 'driver',
    module: driverModule,
    validation: createModuleValidation(driverModule),
  });
  const sink = createIRSchedulerInstance(scheduler, {
    instanceId: 'sink',
    module: sinkModule,
    validation: createModuleValidation(sinkModule),
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
        const mode = driver.storage.loadState(driverMode);
        const output = driver.storage.loadState(driverOutput);
        sink.storage.storeState(sinkAnode, mode === PIN_MODE.pushPull && output === true);
      },
    },
  });

  let time = 0;
  return Object.freeze({
    tick(): void {
      driver.at(driverTick, time, []);
      net.at(solveTarget, time, []);
      sink.at(sinkUpdate, time, []);
      scheduler.start({ until: time });
      time += 1;
    },
    get ticks(): number {
      return time;
    },
    readLamp: (): boolean => sink.storage.loadState(sinkLamp) === true,
  });
}
