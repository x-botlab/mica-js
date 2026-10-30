import type { ArrayRef, FunctionBuilder, FunctionRef, IRModule, Value } from '@mica-js/ir';
import { PIN_MODE } from '../pin-space';
import { createFloatingInput } from './floating-input';
import type { AllocatedElectricalNetwork, AllocatedElectricalPin } from './electrical-network';
import { generateResistiveSolver, RESISTIVE_FAULT } from './resistive-solver';
import type { ResistiveSolver } from './resistive-solver';
import { UnifiedIRCompilerError } from './types';
import type { DeviceBehaviorApi, DevicePinHandle, DeviceResistorHandle } from './types';

type Builder = FunctionBuilder<readonly []>;
type DeviceBindings = Pick<
  DeviceBehaviorApi,
  | 'pins'
  | 'outputs'
  | 'pin'
  | 'resistor'
  | 'writeDigitalGroup'
  | 'applyResistors'
  | 'applyConnections'
>;

export interface ElectricalOperations {
  readonly solver: ResistiveSolver;
  readonly ensure: FunctionRef<readonly [], readonly []>;
  readonly clock: ArrayRef<'u32'>;
  readonly timeStep: ArrayRef<'u32'>;
  readonly advanceTime: FunctionRef<readonly [], readonly []>;
  finalize(): void;
  readonly digitalSample: ArrayRef<'bool'>;
  readonly digitalIntent: ArrayRef<'bool'>;
  readonly pinIndices: ReadonlyMap<string, number>;
  bindDevice(
    deviceId: string,
    builder: Builder,
    globalIds?: ReadonlyMap<string, number>,
  ): DeviceBindings;
}

/** Compiler-owned lowering helpers; none of their private storage is given to devices. */
export function createElectricalOperations(
  module: IRModule,
  allocation: AllocatedElectricalNetwork,
  interpretation: 'two-state' | 'retain-in-band',
  prefix: string,
  floatingSeed = 0,
): ElectricalOperations {
  if (!Number.isInteger(floatingSeed) || floatingSeed < 0 || floatingSeed > 0xffff_ffff)
    throw new Error('floatingSeed must be a u32');
  if (interpretation !== 'two-state' && interpretation !== 'retain-in-band')
    throw new Error('Invalid electrical interpretation');
  const inputs = module.func(`${prefix}_interpret_inputs`, { params: [], results: [] });
  const solver = generateResistiveSolver(module, allocation.network, prefix, [inputs]);
  const allPins = [...allocation.pins].flatMap(([deviceId, pins]) =>
    [...pins].map(([name, pin]) => ({ deviceId, name, pin })),
  );
  const size = Math.max(1, allPins.length);
  const mode = module.array(`${prefix}_mode`, 'u8', Array<number>(size).fill(PIN_MODE.highZ));
  const enabled = module.array(
    `${prefix}_output_enabled`,
    'bool',
    Array<boolean>(size).fill(false),
  );
  const digital = module.array(
    `${prefix}_digital_intent`,
    'bool',
    Array<boolean>(size).fill(false),
  );
  const digitalReady = module.array(
    `${prefix}_digital_ready`,
    'bool',
    Array<boolean>(size).fill(false),
  );
  const voltageReady = module.array(
    `${prefix}_voltage_ready`,
    'bool',
    Array<boolean>(size).fill(false),
  );
  const memory = module.array(`${prefix}_input_memory`, 'bool', Array<boolean>(size).fill(false));
  const sampled = module.array(
    `${prefix}_digital_sample`,
    'bool',
    Array<boolean>(size).fill(false),
  );
  const index = (b: Builder, i: number) => b.const('u32', i);
  const badResource = (message: string): never => {
    throw new UnifiedIRCompilerError('invalid-input', message);
  };
  const running = (b: Builder, emit: (b: Builder) => undefined): undefined => {
    const body = b.block([]);
    const done = b.block([]);
    b.branch(
      b.int.cmp('eq', b.state.load(solver.fault), b.const('u8', 0)),
      { target: body, args: [] },
      { target: done, args: [] },
    );
    b.at(body, emit);
    b.at(done, (b) => b.return([]));
  };
  const checked = (
    b: Builder,
    valid: Value<'bool'>,
    commit: (b: Builder) => undefined,
  ): undefined => {
    const yes = b.block([]);
    const no = b.block([]);
    b.branch(valid, { target: yes, args: [] }, { target: no, args: [] });
    b.at(yes, commit);
    b.at(no, (b) => {
      b.state.store(solver.fault, b.const('u8', RESISTIVE_FAULT.invalidParameter));
      b.return([]);
    });
  };
  const complete = (
    b: Builder,
    changed: Value<'bool'>,
    kind: 'matrix' | 'topology' | 'rhs',
    otherwise: (b: Builder) => undefined = (b) => b.return([]),
  ): undefined => {
    const yes = b.block([]);
    const no = b.block([]);
    b.branch(changed, { target: yes, args: [] }, { target: no, args: [] });
    b.at(yes, (b) => {
      b.call(solver.invalidate[kind], []);
      b.return([]);
    });
    b.at(no, otherwise);
  };
  const loop = (
    b: Builder,
    count: Value<'u32'>,
    emit: (b: Builder, i: Value<'u32'>) => void,
    done: (b: Builder) => undefined,
  ): undefined => {
    const header = b.block(['u32']);
    const body = b.block(['u32']);
    const exit = b.block([]);
    b.jump(header, [b.const('u32', 0)]);
    b.at(header, (b, [i]) =>
      b.branch(b.int.cmp('lt', i, count), { target: body, args: [i] }, { target: exit, args: [] }),
    );
    b.at(body, (b, [i]) => {
      emit(b, i);
      b.jump(header, [b.int.add(i, b.const('u32', 1))]);
    });
    b.at(exit, done);
  };
  const ensure = module.func(`${prefix}_ensure`, { params: [], results: [] });
  ensure.body((b) =>
    running(b, (b) => {
      b.call(solver.solve, []);
      b.return([]);
    }),
  );

  const clock = module.array(`${prefix}_time`, 'u32', [0, 0]);
  const timeStep = module.array(`${prefix}_time_step`, 'u32', [1, 0]);
  const advanceTime = module.func(`${prefix}_advance_time`, { params: [], results: [] });
  const analogInputs = new Map<number, ReturnType<typeof createFloatingInput>>();
  const analogRequests = new Map<number, FunctionRef<readonly [], readonly ['f64']>>();
  // Device bodies request samplers; helper bodies must be built outside any active IR body.
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    for (const [id, sample] of analogRequests) {
      const { deviceId, name, pin } = allPins[id]!;
      analogInputs.set(
        id,
        createFloatingInput(
          module,
          solver,
          clock,
          `${prefix}_analog_${id}`,
          floatingSeed,
          deviceId,
          name,
          pin.node,
          pin.input!.reference,
          sample,
        ),
      );
    }
    advanceTime.body((b) => {
      if (analogInputs.size === 0) {
        b.return([]);
        return;
      }
      const previous = b.array.load(clock, index(b, 0));
      const low = b.int.add(previous, b.array.load(timeStep, index(b, 0)));
      const carry = b.select(b.int.cmp('lt', low, previous), index(b, 1), index(b, 0));
      const high = b.int.add(
        b.int.add(b.array.load(clock, index(b, 1)), b.array.load(timeStep, index(b, 1))),
        carry,
      );
      b.array.store(clock, index(b, 0), low);
      b.array.store(clock, index(b, 1), b.int.and(high, index(b, 0x1fffff)));
      b.return([]);
    });
    inputs.body((b) => {
      allPins.forEach(({ pin }, id) => {
        const analog = analogInputs.get(id);
        if (analog !== undefined) b.call(analog.update, []);
        if (pin.input === undefined) return;
        const ref = pin.input.reference;
        const supply = b.array.load(solver.sourceVoltage, index(b, ref));
        const value = b.array.load(solver.voltage, index(b, pin.node));
        const low = b.float.cmp('le', value, b.float.mul(supply, b.const('f64', pin.input.low)));
        const high = b.float.cmp('ge', value, b.float.mul(supply, b.const('f64', pin.input.high)));
        const ready = b.bool.and(
          b.array.load(solver.sourceEnabled, index(b, ref)),
          b.bool.and(
            b.float.cmp('gt', supply, b.const('f64', 0)),
            b.int.cmp(
              'eq',
              b.array.load(solver.voltageState, index(b, pin.node)),
              b.const('u8', 0),
            ),
          ),
        );
        const remembered = b.array.load(memory, index(b, id));
        const next = b.select(
          low,
          b.const('bool', false),
          b.select(high, b.const('bool', true), remembered),
        );
        b.array.store(memory, index(b, id), b.select(ready, next, remembered));
        b.array.store(
          sampled,
          index(b, id),
          b.bool.and(ready, interpretation === 'two-state' ? high : next),
        );
      });
      b.return([]);
    });
  };

  const refresh = new Map<number, FunctionRef<readonly [], readonly ['bool']>>();
  const pinFunctions = new Map<
    number,
    {
      readonly setMode: FunctionRef<readonly ['u8'], readonly []>;
      readonly setEnabled: FunctionRef<readonly ['bool'], readonly []>;
      readonly writeDigital: FunctionRef<readonly ['bool'], readonly []>;
      readonly writeVoltage: FunctionRef<readonly ['f64'], readonly []>;
    }
  >();
  allPins.forEach(({ pin }, id) => {
    if (pin.drive === undefined) return;
    const drive = pin.drive;
    const recompute = module.func(`${prefix}_pin_${id}_refresh`, { params: [], results: ['bool'] });
    refresh.set(id, recompute);
    recompute.body((b) => {
      const at = b.const('u32', id);
      const active = b.array.load(enabled, at);
      const selection = b.array.load(mode, at);
      const is = (which: number) => b.int.cmp('eq', selection, b.const('u8', which));
      const pushPull = is(PIN_MODE.pushPull);
      const digitalActive = b.bool.and(active, b.array.load(digitalReady, at));
      const level = b.array.load(digital, at);
      const high = b.bool.and(digitalActive, b.bool.and(pushPull, level));
      const low = b.bool.and(
        digitalActive,
        b.bool.and(b.bool.or(pushPull, is(PIN_MODE.openDrain)), b.bool.not(level)),
      );
      let changed = b.const('bool', false);
      const update = (branch: number, value: Value<'bool'>) => {
        changed = b.bool.or(
          changed,
          b.bool.xor(b.array.load(solver.resistorEnabled, b.const('u32', branch)), value),
        );
        b.array.store(solver.resistorEnabled, b.const('u32', branch), value);
      };
      update(drive.high, high);
      update(drive.low, low);
      if (drive.analog !== undefined)
        update(
          drive.analog.resistor,
          b.bool.and(active, b.bool.and(is(PIN_MODE.analog), b.array.load(voltageReady, at))),
        );
      b.return([changed]);
    });
    const setMode = module.func(`${prefix}_pin_${id}_mode`, { params: ['u8'], results: [] });
    setMode.body((b, [value]) =>
      running(b, (b) => {
        b.array.store(mode, index(b, id), value);
        const [changed] = b.call(recompute, []);
        return complete(b, changed, 'matrix');
      }),
    );
    const setEnabled = module.func(`${prefix}_pin_${id}_enable`, { params: ['bool'], results: [] });
    setEnabled.body((b, [value]) =>
      running(b, (b) => {
        b.array.store(enabled, index(b, id), value);
        const [changed] = b.call(recompute, []);
        return complete(b, changed, 'matrix');
      }),
    );
    const writeDigital = module.func(`${prefix}_pin_${id}_digital`, {
      params: ['bool'],
      results: [],
    });
    writeDigital.body((b, [value]) =>
      running(b, (b) => {
        b.array.store(digital, index(b, id), value);
        b.array.store(digitalReady, index(b, id), b.const('bool', true));
        const [changed] = b.call(recompute, []);
        return complete(b, changed, 'matrix');
      }),
    );
    const writeVoltage = module.func(`${prefix}_pin_${id}_voltage`, {
      params: ['f64'],
      results: [],
    });
    writeVoltage.body((b, [value]) =>
      running(b, (b) =>
        checked(b, b.float.isFinite(value), (b) => {
          if (drive.analog === undefined) {
            b.return([]);
            return;
          }
          const at = index(b, drive.analog.source);
          const changedRhs = b.float.cmp('ne', b.array.load(solver.sourceVoltage, at), value);
          b.array.store(solver.sourceVoltage, at, value);
          b.array.store(voltageReady, index(b, id), b.const('bool', true));
          const [changedMatrix] = b.call(recompute, []);
          return complete(b, changedMatrix, 'matrix', (b) => complete(b, changedRhs, 'rhs'));
        }),
      ),
    );
    pinFunctions.set(id, { setMode, setEnabled, writeDigital, writeVoltage });
  });
  const pinIds = new Map<string, Map<string, number>>();
  allPins.forEach(({ deviceId, name }, id) => {
    let pins = pinIds.get(deviceId);
    if (pins === undefined) {
      pins = new Map();
      pinIds.set(deviceId, pins);
    }
    pins.set(name, id);
  });
  for (const deviceId of allocation.pins.keys())
    if (!pinIds.has(deviceId)) pinIds.set(deviceId, new Map());

  const deviceBinders = new Map<
    string,
    (b: Builder, globalIds?: ReadonlyMap<string, number>) => DeviceBindings
  >();
  for (const [deviceId, ids] of pinIds) {
    const ordinaryResistors = allocation.resistors.get(deviceId)!;
    const contacts = allocation.contacts.get(deviceId)!;
    const queueSize = Math.max(1, ids.size, ordinaryResistors.size, contacts.size);
    const deviceNumber = deviceBinders.size;
    const tag = `${prefix}_device_${deviceNumber}`;
    const queueId = module.array(`${tag}_ids`, 'u32', Array<number>(queueSize).fill(0));
    const queueNumber = module.array(`${tag}_numbers`, 'f64', Array<number>(queueSize).fill(1));
    const queueBool = module.array(`${tag}_flags`, 'bool', Array<boolean>(queueSize).fill(false));
    const valid = module.state(`${tag}_valid`, 'bool', true);
    const changed = module.state(`${tag}_changed`, 'bool', false);
    const positive = (b: Builder, value: Value<'f64'>) =>
      b.bool.and(b.float.isFinite(value), b.float.cmp('gt', value, b.const('f64', 0)));
    const applyResistors = module.func(`${tag}_resistances`, { params: ['u32'], results: [] });
    applyResistors.body((b, [count]) =>
      running(b, (b) => {
        b.state.store(valid, b.const('bool', true));
        return loop(
          b,
          count,
          (b, i) => {
            b.state.store(
              valid,
              b.bool.and(b.state.load(valid), positive(b, b.array.load(queueNumber, i))),
            );
          },
          (b) =>
            checked(b, b.state.load(valid), (b) => {
              b.state.store(changed, b.const('bool', false));
              return loop(
                b,
                count,
                (b, i) => {
                  const target = b.array.load(queueId, i);
                  const value = b.array.load(queueNumber, i);
                  b.state.store(
                    changed,
                    b.bool.or(
                      b.state.load(changed),
                      b.float.cmp('ne', b.array.load(solver.resistance, target), value),
                    ),
                  );
                  b.array.store(solver.resistance, target, value);
                },
                (b) => complete(b, b.state.load(changed), 'matrix'),
              );
            }),
        );
      }),
    );
    const applyConnections = module.func(`${tag}_contacts`, { params: ['u32'], results: [] });
    applyConnections.body((b, [count]) =>
      running(b, (b) => {
        b.state.store(changed, b.const('bool', false));
        return loop(
          b,
          count,
          (b, i) => {
            const target = b.array.load(queueId, i);
            const value = b.array.load(queueBool, i);
            b.state.store(
              changed,
              b.bool.or(
                b.state.load(changed),
                b.bool.xor(b.array.load(solver.contactClosed, target), value),
              ),
            );
            b.array.store(solver.contactClosed, target, value);
          },
          (b) => complete(b, b.state.load(changed), 'topology'),
        );
      }),
    );
    const writeDigitalGroup = module.func(`${tag}_digital_group`, { params: ['u32'], results: [] });
    writeDigitalGroup.body((b, [count]) =>
      running(b, (b) =>
        loop(
          b,
          count,
          (b, i) => {
            const target = b.array.load(queueId, i);
            b.array.store(digital, target, b.array.load(queueBool, i));
            b.array.store(digitalReady, target, b.const('bool', true));
          },
          (b) => {
            let changed = b.const('bool', false);
            for (const id of ids.values()) {
              const recompute = refresh.get(id);
              if (recompute === undefined) continue;
              const [value] = b.call(recompute, []);
              changed = b.bool.or(changed, value);
            }
            return complete(b, changed, 'matrix');
          },
        ),
      ),
    );
    const setResistorEnabled = module.func(`${tag}_resistor_enable`, {
      params: ['u32', 'bool'],
      results: [],
    });
    setResistorEnabled.body((b, [target, value]) =>
      running(b, (b) => {
        const changed = b.bool.xor(b.array.load(solver.resistorEnabled, target), value);
        b.array.store(solver.resistorEnabled, target, value);
        return complete(b, changed, 'matrix');
      }),
    );
    const setPull = new Map<number, FunctionRef<readonly ['u8'], readonly []>>();
    for (const id of ids.values()) {
      const bias = allPins[id]!.pin.bias;
      if (bias === undefined) continue;
      const fn = module.func(`${prefix}_pin_${id}_pull`, { params: ['u8'], results: [] });
      fn.body((b, [value]) =>
        running(b, (b) => {
          const up = b.int.cmp('eq', value, b.const('u8', 1));
          const down = b.int.cmp('eq', value, b.const('u8', 2));
          const changed = b.bool.or(
            b.bool.xor(b.array.load(solver.resistorEnabled, index(b, bias.up)), up),
            b.bool.xor(b.array.load(solver.resistorEnabled, index(b, bias.down)), down),
          );
          b.array.store(solver.resistorEnabled, index(b, bias.up), up);
          b.array.store(solver.resistorEnabled, index(b, bias.down), down);
          return complete(b, changed, 'matrix');
        }),
      );
      setPull.set(id, fn);
    }
    deviceBinders.set(deviceId, (b, globalIds) => {
      const lookup = (
        names: readonly string[],
        values: readonly unknown[],
        resources: ReadonlyMap<string, number>,
      ): number[] => {
        if (
          names.length === 0 ||
          names.length !== values.length ||
          new Set(names).size !== names.length
        )
          badResource(`Invalid atomic patch for "${deviceId}"`);
        return names.map(
          (name) =>
            resources.get(name) ?? badResource(`Unknown electrical resource "${deviceId}.${name}"`),
        );
      };
      const patch = (
        targets: readonly number[],
        values: readonly Value<'f64'>[] | readonly Value<'bool'>[],
        numeric: boolean,
        fn: FunctionRef<readonly ['u32'], readonly []>,
      ): void => {
        targets.forEach((target, i) => {
          b.array.store(queueId, index(b, i), index(b, target));
          if (numeric) b.array.store(queueNumber, index(b, i), values[i] as Value<'f64'>);
          else b.array.store(queueBool, index(b, i), values[i] as Value<'bool'>);
        });
        b.call(fn, [index(b, targets.length)]);
      };
      const handles = new Map<string, DevicePinHandle>();
      for (const [name, id] of ids) {
        const description: AllocatedElectricalPin = allPins[id]!.pin;
        const functions = () =>
          pinFunctions.get(id) ?? badResource(`Pin "${deviceId}.${name}" has no drive capability`);
        const handle: DevicePinHandle = Object.freeze({
          name,
          globalId: globalIds?.get(name) ?? id,
          configure(selection: number): void {
            if (!Object.values(PIN_MODE).includes(selection as 0 | 1 | 2 | 3))
              badResource(`Invalid pin mode ${selection}`);
            if (selection === PIN_MODE.analog && description.drive?.analog === undefined)
              badResource(`Pin "${deviceId}.${name}" has no analog drive capability`);
            if (selection === PIN_MODE.highZ && description.drive === undefined) return;
            b.call(functions().setMode, [b.const('u8', selection)]);
          },
          setOutputEnabled(value: Value<'bool'>): void {
            b.call(functions().setEnabled, [value]);
          },
          setPull(selection: 'none' | 'up' | 'down'): void {
            if (!['none', 'up', 'down'].includes(selection))
              badResource(`Invalid pull ${selection}`);
            const fn =
              setPull.get(id) ??
              (selection === 'none'
                ? undefined
                : badResource(`Pin "${deviceId}.${name}" has no bias capability`));
            if (fn === undefined) return;
            b.call(fn, [b.const('u8', selection === 'none' ? 0 : selection === 'up' ? 1 : 2)]);
          },
          writeDigital(value: Value<'bool'>): void {
            b.call(functions().writeDigital, [value]);
          },
          writeVoltage(value: Value<'f64'>): void {
            if (description.drive?.analog === undefined)
              badResource(`Pin "${deviceId}.${name}" has no analog drive capability`);
            b.call(functions().writeVoltage, [value]);
          },
          sampleDigital(): Value<'bool'> {
            if (description.input === undefined)
              badResource(`Pin "${deviceId}.${name}" has no input capability`);
            b.call(ensure, []);
            return b.array.load(sampled, index(b, id));
          },
          sampleVoltage(): Value<'f64'> {
            if (description.input === undefined)
              badResource(`Pin "${deviceId}.${name}" has no input capability`);
            let sample = analogRequests.get(id);
            if (sample === undefined) {
              if (finalized)
                badResource('Analog sampling must be declared before electrical finalization');
              sample = module.func(`${prefix}_analog_${id}_sample`, {
                params: [],
                results: ['f64'],
              });
              analogRequests.set(id, sample);
            }
            b.call(ensure, []);
            return b.call(sample, [])[0];
          },
          readDrivenDigital(): Value<'bool'> {
            functions();
            return b.array.load(digital, index(b, id));
          },
        });
        handles.set(name, handle);
      }
      return Object.freeze({
        pins: Object.freeze([...handles.values()]),
        outputs: Object.freeze(
          [...handles]
            .filter(([name]) => allPins[ids.get(name)!]!.pin.drive !== undefined)
            .map(([, handle]) => handle),
        ),
        pin(name: string): DevicePinHandle {
          return handles.get(name) ?? badResource(`Unknown pin "${deviceId}.${name}"`);
        },
        resistor(name: string): DeviceResistorHandle {
          const target =
            ordinaryResistors.get(name) ?? badResource(`Unknown resistor "${deviceId}.${name}"`);
          return Object.freeze({
            setResistance(value: Value<'f64'>): void {
              patch([target], [value], true, applyResistors);
            },
            setEnabled(value: Value<'bool'>): void {
              b.call(setResistorEnabled, [index(b, target), value]);
            },
            sampleCurrent(): Value<'f64'> {
              b.call(ensure, []);
              return b.array.load(solver.current, index(b, target));
            },
          });
        },
        writeDigitalGroup(names: readonly string[], values: readonly Value<'bool'>[]): void {
          const targets = lookup(names, values, ids);
          for (const id of targets)
            if (!pinFunctions.has(id))
              badResource(`Pin "${allPins[id]!.name}" has no drive capability`);
          patch(targets, values, false, writeDigitalGroup);
        },
        applyResistors(names: readonly string[], values: readonly Value<'f64'>[]): void {
          patch(lookup(names, values, ordinaryResistors), values, true, applyResistors);
        },
        applyConnections(names: readonly string[], values: readonly Value<'bool'>[]): void {
          patch(lookup(names, values, contacts), values, false, applyConnections);
        },
      });
    });
  }
  return Object.freeze({
    solver,
    ensure,
    clock,
    timeStep,
    advanceTime,
    finalize,
    digitalSample: sampled,
    digitalIntent: digital,
    pinIndices: new Map(allPins.map(({ deviceId, name }, index) => [`${deviceId}.${name}`, index])),
    bindDevice(
      deviceId: string,
      builder: Builder,
      globalIds?: ReadonlyMap<string, number>,
    ): DeviceBindings {
      const bind =
        deviceBinders.get(deviceId) ?? badResource(`Unknown electrical device "${deviceId}"`);
      return bind(builder, globalIds);
    },
  });
}
