import { describe, expect, it } from 'vitest';
import {
  ElectricalConflictError,
  resolveElectricalNetwork,
  type ElectricalNetworkInput,
  type ElectricalPinInput,
} from '../index';

function pin(overrides: Partial<ElectricalPinInput> = {}): ElectricalPinInput {
  return {
    instanceId: 'device',
    pinName: 'P',
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: {
      kind: 'ideal-voltage',
      minVoltage: -5,
      maxVoltage: 5,
      lowVoltage: 0,
      highVoltage: 3.3,
    },
    ...overrides,
  };
}

function network(pins: readonly unknown[], networkId = 'net'): ElectricalNetworkInput {
  return { networkId, pins: pins as readonly ElectricalPinInput[] };
}

const output = { outputEnabled: true, mode: 'push-pull' } as const;
const analog = { outputEnabled: true, mode: 'analog' } as const;
const openDrain = { outputEnabled: true, mode: 'open-drain' } as const;

describe('electrical contributions', () => {
  it.each<{
    name: string;
    config: Partial<ElectricalPinInput>;
    voltage?: number;
    strength?: 'strong' | 'weak';
    count: number;
  }>([
    { name: 'initial high-z, both intents waiting', config: {}, count: 0 },
    {
      name: 'high-z ignores ready intents',
      config: { digitalIntent: true, voltageIntent: 2 },
      count: 0,
    },
    {
      name: 'disabled retains ready digital intent',
      config: { mode: 'push-pull', digitalIntent: true },
      count: 0,
    },
    { name: 'push-pull waits for digital intent', config: output, count: 0 },
    {
      name: 'push-pull does not select voltage intent',
      config: { ...output, voltageIntent: 2 },
      count: 0,
    },
    {
      name: 'push-pull low',
      config: { ...output, digitalIntent: false },
      voltage: 0,
      strength: 'strong',
      count: 1,
    },
    {
      name: 'push-pull high',
      config: { ...output, digitalIntent: true },
      voltage: 3.3,
      strength: 'strong',
      count: 1,
    },
    {
      name: 'open-drain low',
      config: { ...openDrain, digitalIntent: false },
      voltage: 0,
      strength: 'strong',
      count: 1,
    },
    { name: 'open-drain one releases', config: { ...openDrain, digitalIntent: true }, count: 0 },
    { name: 'open-drain waits for intent', config: openDrain, count: 0 },
    {
      name: 'analog waits for voltage intent',
      config: { ...analog, digitalIntent: true },
      count: 0,
    },
    {
      name: 'analog zero is ready',
      config: { ...analog, voltageIntent: 0 },
      voltage: 0,
      strength: 'strong',
      count: 1,
    },
    {
      name: 'analog nonzero',
      config: { ...analog, voltageIntent: 1.7 },
      voltage: 1.7,
      strength: 'strong',
      count: 1,
    },
    {
      name: 'analog negative boundary',
      config: { ...analog, voltageIntent: -5 },
      voltage: -5,
      strength: 'strong',
      count: 1,
    },
    {
      name: 'analog positive boundary',
      config: { ...analog, voltageIntent: 5 },
      voltage: 5,
      strength: 'strong',
      count: 1,
    },
    { name: 'high-z pull-up', config: { pull: 'up' }, voltage: 3.3, strength: 'weak', count: 1 },
    { name: 'high-z pull-down', config: { pull: 'down' }, voltage: 0, strength: 'weak', count: 1 },
    {
      name: 'waiting intent retains pull-up',
      config: { ...output, pull: 'up' },
      voltage: 3.3,
      strength: 'weak',
      count: 1,
    },
    {
      name: 'disabled drive retains pull-down',
      config: { mode: 'push-pull', digitalIntent: true, pull: 'down' },
      voltage: 0,
      strength: 'weak',
      count: 1,
    },
    {
      name: 'open-drain one and pull-up',
      config: { ...openDrain, digitalIntent: true, pull: 'up' },
      voltage: 3.3,
      strength: 'weak',
      count: 1,
    },
    {
      name: 'open-drain zero beats its pull-up',
      config: { ...openDrain, digitalIntent: false, pull: 'up' },
      voltage: 0,
      strength: 'strong',
      count: 2,
    },
    {
      name: 'push-pull high beats its pull-down',
      config: { ...output, digitalIntent: true, pull: 'down' },
      voltage: 3.3,
      strength: 'strong',
      count: 2,
    },
    {
      name: 'power gate releases drive and bias',
      config: { ...output, digitalIntent: true, pull: 'up', powerReady: false },
      count: 0,
    },
    {
      name: 'power gate releases analog and bias',
      config: { ...analog, voltageIntent: 2, pull: 'down', powerReady: false },
      count: 0,
    },
  ])('$name', ({ config, voltage, strength, count }) => {
    const input = pin(config);
    const result = resolveElectricalNetwork(network([input]));
    expect(result.contributions).toHaveLength(count);
    if (voltage === undefined) {
      expect(result).toEqual({ state: 'floating', digitalFallback: false, contributions: [] });
      expect(result).not.toHaveProperty('voltage');
    } else {
      expect(result).toMatchObject({ state: 'driven', voltage, strength });
    }
    expect(input).toEqual(pin(config));
  });

  it('keeps saved intents independent across mode, enable and power changes', () => {
    const saved = pin({ ...output, digitalIntent: true, voltageIntent: 1.2, pull: 'down' });
    const evaluate = (changes: Partial<ElectricalPinInput>) =>
      resolveElectricalNetwork(network([{ ...saved, ...changes }]));
    expect(evaluate({})).toMatchObject({ voltage: 3.3 });
    expect(evaluate({ mode: 'analog' })).toMatchObject({ voltage: 1.2 });
    expect(evaluate({ outputEnabled: false })).toMatchObject({ voltage: 0, strength: 'weak' });
    expect(evaluate({ mode: 'open-drain' })).toMatchObject({ voltage: 0, strength: 'weak' });
    expect(evaluate({ powerReady: false })).toMatchObject({ state: 'floating' });
    expect(evaluate({})).toMatchObject({ voltage: 3.3 });
    expect(saved).toMatchObject({ digitalIntent: true, voltageIntent: 1.2, pull: 'down' });
  });

  it.each(['high-z', 'push-pull', 'open-drain', 'analog'] as const)(
    'keeps bias independent of enabled/readiness in %s mode',
    (mode) => {
      for (const outputEnabled of [false, true]) {
        const ready = mode === 'analog' ? { voltageIntent: 2 } : { digitalIntent: true };
        for (const intent of [{}, ready]) {
          const result = resolveElectricalNetwork(
            network([pin({ mode, outputEnabled, pull: 'up', ...intent })]),
          );
          expect(result.contributions.some((contribution) => contribution.kind === 'pull')).toBe(
            true,
          );
          expect(
            resolveElectricalNetwork(
              network([pin({ mode, outputEnabled, pull: 'up', powerReady: false, ...intent })]),
            ),
          ).toMatchObject({ state: 'floating' });
        }
      }
    },
  );

  it('none releases only the selected pin bias; disconnected pins are omitted', () => {
    const a = pin({ pinName: 'A', pull: 'up' });
    const b = pin({ pinName: 'B', pull: 'up' });
    expect(resolveElectricalNetwork(network([{ ...a, pull: 'none' }, b]))).toMatchObject({
      voltage: 3.3,
    });
    expect(resolveElectricalNetwork(network([]))).toMatchObject({ state: 'floating' });
  });
});

const combinations = [
  { name: 'push-pull low', config: { ...output, digitalIntent: false } },
  { name: 'push-pull high', config: { ...output, digitalIntent: true } },
  { name: 'open-drain low', config: { ...openDrain, digitalIntent: false } },
  { name: 'open-drain released', config: { ...openDrain, digitalIntent: true } },
  { name: 'high-z', config: {} },
  { name: 'pull-down', config: { pull: 'down' as const } },
  { name: 'pull-up', config: { pull: 'up' as const } },
  { name: 'analog low', config: { ...analog, voltageIntent: 0 } },
  { name: 'analog high', config: { ...analog, voltageIntent: 3.3 } },
];

// F=floating, C=conflict; lowercase are weak, uppercase are strong results.
const matrix = [
  'LCLLLLLLC',
  'CHCHHHHCH',
  'LCLLLLLLC',
  'LHLFFduLH',
  'LHLFFduLH',
  'LHLdddCLH',
  'LHLuuCuLH',
  'LCLLLLLLC',
  'CHCHHHHCH',
];

const pairCases = combinations.flatMap((left, row) =>
  combinations.map((right, column) => ({
    name: `${left.name} + ${right.name}`,
    left: left.config,
    right: right.config,
    expected: matrix[row]![column]!,
  })),
);

describe('public model combination matrix', () => {
  it.each(pairCases)('$name', ({ left, right, expected }) => {
    const input = network([pin({ ...left, pinName: 'A' }), pin({ ...right, pinName: 'B' })]);
    if (expected === 'C') {
      expect(() => resolveElectricalNetwork(input)).toThrow(ElectricalConflictError);
    } else if (expected === 'F') {
      expect(resolveElectricalNetwork(input)).toMatchObject({
        state: 'floating',
        digitalFallback: false,
      });
    } else {
      expect(['L', 'H', 'd', 'u']).toContain(expected);
      expect(resolveElectricalNetwork(input)).toMatchObject({
        state: 'driven',
        voltage: expected === 'L' || expected === 'd' ? 0 : 3.3,
        strength: expected === 'd' || expected === 'u' ? 'weak' : 'strong',
      });
    }
  });
});

describe('compatibility, diagnostics and isolation', () => {
  function voltages(values: readonly number[], weak = false): ElectricalPinInput[] {
    return values.map((voltage, index) =>
      pin({
        pinName: String(index),
        ...analog,
        voltageIntent: voltage,
        ...(weak
          ? { outputEnabled: false, pull: 'up', model: { ...pin().model, highVoltage: voltage } }
          : {}),
      }),
    );
  }

  it.each([false, true])('uses exact f64 compatibility and minimum voltage (weak=%s)', (weak) => {
    expect(resolveElectricalNetwork(network(voltages([0.001, 0, 0.0005], weak)))).toMatchObject({
      voltage: 0,
    });
    expect(() =>
      resolveElectricalNetwork(network(voltages([0, 0.001 + Number.EPSILON], weak))),
    ).toThrow(ElectricalConflictError);
    expect(resolveElectricalNetwork(network(voltages([1, 1.001], weak)))).toMatchObject({
      voltage: 1,
    });
    expect(3.301 - 3.3).toBeGreaterThan(0.001);
    expect(() => resolveElectricalNetwork(network(voltages([3.3, 3.301], weak)))).toThrow(
      ElectricalConflictError,
    );
  });

  it('uses the entire highest-priority set, not only neighboring differences', () => {
    expect(() => resolveElectricalNetwork(network(voltages([0, 0.0008, 0.0016])))).toThrow(
      ElectricalConflictError,
    );
  });

  it('allows matching nonzero analog, push-pull and open-drain strong voltages', () => {
    const inputs = [
      pin({ ...analog, pinName: 'A', voltageIntent: 1.8 }),
      pin({
        ...output,
        pinName: 'B',
        digitalIntent: true,
        model: { ...pin().model, highVoltage: 1.8 },
      }),
      pin({
        ...openDrain,
        pinName: 'C',
        digitalIntent: false,
        model: { ...pin().model, lowVoltage: 1.8 },
      }),
    ];
    expect(resolveElectricalNetwork(network(inputs))).toMatchObject({
      voltage: 1.8,
      strength: 'strong',
    });
  });

  it('ignores conflicting weak voltages only when a strong contribution exists', () => {
    const inputs = [pin({ pinName: 'U', pull: 'up' }), pin({ pinName: 'D', pull: 'down' })];
    expect(() => resolveElectricalNetwork(network(inputs))).toThrow(ElectricalConflictError);
    const result = resolveElectricalNetwork(
      network([...inputs, pin({ ...analog, voltageIntent: 1.2 })]),
    );
    expect(result).toMatchObject({ voltage: 1.2, strength: 'strong' });
    expect(result.contributions).toHaveLength(3);
  });

  it('keeps deterministic, complete, immutable fault snapshots without altering callers', () => {
    const model = { ...pin().model };
    const a = pin({ ...output, pinName: 'A', digitalIntent: true, pull: 'down', model });
    const b = pin({ ...openDrain, pinName: 'B', digitalIntent: false });
    const pins = [b, a, pin({ pinName: 'C' })];
    const input = network(pins, 'fault-net');
    let failure: ElectricalConflictError | undefined;
    try {
      resolveElectricalNetwork(input);
    } catch (error) {
      expect(error).toBeInstanceOf(ElectricalConflictError);
      failure = error as ElectricalConflictError;
    }
    expect(failure).toBeDefined();
    expect(failure!.network.networkId).toBe('fault-net');
    expect(failure!.network.pins.map((p) => p.pinName)).toEqual(['A', 'B', 'C']);
    expect(failure!.contributions.map((c) => [c.pinName, c.kind, c.voltage])).toEqual([
      ['A', 'drive', 3.3],
      ['A', 'pull', 0],
      ['B', 'drive', 0],
    ]);
    expect(failure!.network).not.toBe(input);
    expect(Object.isFrozen(failure!.network)).toBe(true);
    expect(Object.isFrozen(failure!.network.pins)).toBe(true);
    expect(Object.isFrozen(failure!.network.pins[0])).toBe(true);
    expect(Object.isFrozen(failure!.network.pins[0]!.model)).toBe(true);
    expect(Object.isFrozen(failure!.contributions)).toBe(true);
    expect(failure!.contributions.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    model.highVoltage = 1;
    pins.length = 0;
    expect(failure!.network.pins).toHaveLength(3);
    expect(failure!.network.pins[0]!.model.highVoltage).toBe(3.3);
    expect(failure!.contributions[0]!.voltage).toBe(3.3);
  });

  it('orders by raw UTF-16 source identity, independently of network and input order', () => {
    const inputs = ['z', 'a', 'A', '\ud800\udc00', '\ue000'].map((instanceId) =>
      pin({ instanceId, ...output, digitalIntent: true, pull: 'down' }),
    );
    const expected = resolveElectricalNetwork(network(inputs));
    for (let index = 0; index < inputs.length; index += 1) {
      const reordered = [...inputs.slice(index), ...inputs.slice(0, index)].reverse();
      expect(resolveElectricalNetwork(network(reordered, `other-${index}`))).toEqual(expected);
    }
    expect(expected.contributions.map((c) => `${c.instanceId}:${c.kind}`)).toEqual(
      ['A', 'a', 'z', '\ud800\udc00', '\ue000'].flatMap((id) => [`${id}:drive`, `${id}:pull`]),
    );
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.contributions)).toBe(true);
    expect(expected.contributions.every(Object.isFrozen)).toBe(true);
  });

  it('keeps fault snapshots invariant under input permutations', () => {
    const pins = [
      pin({ ...output, instanceId: 'z', digitalIntent: true, pull: 'down' }),
      pin({ ...analog, instanceId: 'a', voltageIntent: 1 }),
      pin({ instanceId: 'A', pull: 'up' }),
    ];
    const failures: ElectricalConflictError[] = [];
    for (const order of [pins, [...pins].reverse(), [pins[1]!, pins[0]!, pins[2]!]]) {
      try {
        resolveElectricalNetwork(network(order));
      } catch (error) {
        expect(error).toBeInstanceOf(ElectricalConflictError);
        failures.push(error as ElectricalConflictError);
      }
    }
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.network).toEqual(failures[0]!.network);
      expect(failure.contributions).toEqual(failures[0]!.contributions);
      expect(failure.message).toBe(failures[0]!.message);
    }
  });

  it('repeats deterministic failures and isolates unrelated networks and results', () => {
    const stable = network([pin({ ...analog, voltageIntent: 0.4 })], 'stable');
    const expected = resolveElectricalNetwork(stable);
    const conflict = network(
      [
        pin({ ...output, digitalIntent: true }),
        pin({ ...output, digitalIntent: false, pinName: 'B' }),
      ],
      'bad',
    );
    let previous: ElectricalConflictError | undefined;
    for (let index = 0; index < 3; index += 1) {
      try {
        resolveElectricalNetwork(conflict);
      } catch (error) {
        expect(error).toBeInstanceOf(ElectricalConflictError);
        const failure = error as ElectricalConflictError;
        if (previous) {
          expect(failure.network).toEqual(previous.network);
          expect(failure.contributions).toEqual(previous.contributions);
        }
        previous = failure;
      }
      expect(resolveElectricalNetwork(network([]))).toMatchObject({ state: 'floating' });
      expect(resolveElectricalNetwork(stable)).toEqual(expected);
    }
    expect(previous).toBeDefined();
    expect(expected).toMatchObject({ voltage: 0.4 });
  });

  it('preserves direct f64 signed-zero minimum and handles finite extreme spreads', () => {
    const result = resolveElectricalNetwork(network(voltages([0, -0])));
    expect(result.state === 'driven' && Object.is(result.voltage, -0)).toBe(true);
    const extreme = [-Number.MAX_VALUE, Number.MAX_VALUE].map((voltage, i) =>
      pin({
        ...analog,
        pinName: String(i),
        voltageIntent: voltage,
        model: { ...pin().model, minVoltage: -Number.MAX_VALUE, maxVoltage: Number.MAX_VALUE },
      }),
    );
    expect(() => resolveElectricalNetwork(network(extreme))).toThrow(ElectricalConflictError);
  });
});

describe('runtime contract validation', () => {
  const unsafeResolve = (value: unknown) =>
    resolveElectricalNetwork(value as ElectricalNetworkInput);

  it.each([
    ['missing network', undefined],
    ['null network', null],
    ['empty network identity', network([], '')],
    ['non-array pins', { networkId: 'n', pins: {} }],
    ['sparse pins', { networkId: 'n', pins: Array(1) }],
    ['unknown network field', { ...network([]), resistance: 2 }],
    ['unknown pin field', network([{ ...pin(), impedance: 3 }])],
    ['null model', network([{ ...pin(), model: null }])],
    ['unknown model', network([{ ...pin(), model: { ...pin().model, kind: 'resistor' } }])],
    [
      'unsupported model parameter',
      network([{ ...pin(), model: { ...pin().model, resistance: 10 } }]),
    ],
    ['unknown symbol field', network([{ ...pin(), [Symbol('unknown')]: 1 }])],
    ['invalid mode', network([{ ...pin(), mode: 'quasi-bidirectional' }])],
    ['invalid pull', network([{ ...pin(), pull: 'both' }])],
    ['invalid powerReady', network([{ ...pin(), powerReady: 1 }])],
    ['invalid outputEnabled', network([{ ...pin(), outputEnabled: 'yes' }])],
    ['invalid digital intent', network([{ ...pin(), digitalIntent: 1 }])],
    ['explicit undefined digital intent', network([{ ...pin(), digitalIntent: undefined }])],
    ['explicit undefined voltage intent', network([{ ...pin(), voltageIntent: undefined }])],
    ['empty instance identity', network([pin({ instanceId: '' })])],
    ['empty pin identity', network([pin({ pinName: '' })])],
    ['duplicate source', network([pin(), pin()])],
  ])('rejects %s', (_name, value) => {
    expect(() => unsafeResolve(value)).toThrow(TypeError);
  });

  it.each(['minVoltage', 'maxVoltage', 'lowVoltage', 'highVoltage', 'voltageIntent'] as const)(
    'rejects non-finite/non-numeric %s even when released',
    (field) => {
      for (const value of [NaN, Infinity, -Infinity, '1']) {
        const base = pin({ powerReady: false });
        const input =
          field === 'voltageIntent'
            ? { ...base, voltageIntent: value }
            : { ...base, model: { ...base.model, [field]: value } };
        expect(() => unsafeResolve(network([input] as ElectricalPinInput[]))).toThrow(TypeError);
        expect(() => unsafeResolve(network([input] as ElectricalPinInput[]))).toThrow(field);
      }
    },
  );

  it.each([
    ['minVoltage', { minVoltage: 6 }],
    ['lowVoltage', { lowVoltage: 4 }],
    ['lowVoltage', { lowVoltage: -6 }],
    ['highVoltage', { highVoltage: 6 }],
  ])('rejects model range %s', (field, changes) => {
    const input = network([pin({ model: { ...pin().model, ...changes } })]);
    expect(() => resolveElectricalNetwork(input)).toThrow(RangeError);
    expect(() => resolveElectricalNetwork(input)).toThrow(field);
  });

  it.each([-5 - Number.EPSILON * 8, 5 + Number.EPSILON * 8])(
    'rejects out-of-range saved intent %s before gating',
    (voltageIntent) => {
      const input = network([pin({ voltageIntent, powerReady: false })]);
      expect(() => resolveElectricalNetwork(input)).toThrow(RangeError);
      expect(() => resolveElectricalNetwork(input)).toThrow(`voltageIntent: ${voltageIntent}`);
    },
  );

  it('validates the entire network before reporting a drive conflict', () => {
    const input = network([
      pin({ ...output, digitalIntent: false }),
      pin({ ...output, digitalIntent: true, pinName: 'B' }),
      pin({ pinName: 'C', voltageIntent: NaN }),
    ]);
    expect(() => resolveElectricalNetwork(input)).toThrow(TypeError);
    expect(() => resolveElectricalNetwork(input)).toThrow('network.pins[2].voltageIntent: NaN');
  });

  it('keeps field diagnostics when an invalid value has no string conversion', () => {
    const invalid = { networkId: 'net', pins: Object.create(null) };
    expect(() => unsafeResolve(invalid)).toThrow(TypeError);
    expect(() => unsafeResolve(invalid)).toThrow('network.pins: <unprintable> must be an array');
  });

  it('preserves raw identities without delimiter collisions or normalization', () => {
    const pins = [
      pin({ instanceId: 'a:b', pinName: 'c', pull: 'up' }),
      pin({ instanceId: 'a', pinName: 'b:c', pull: 'up' }),
      pin({ instanceId: ' a', pinName: 'b:c', pull: 'up' }),
      pin({ instanceId: '\u00e9', pull: 'up' }),
      pin({ instanceId: 'e\u0301', pull: 'up' }),
    ];
    expect(resolveElectricalNetwork(network(pins)).contributions).toHaveLength(5);
  });
});

class GetterModel {
  get kind(): 'ideal-voltage' {
    return 'ideal-voltage';
  }
  get minVoltage(): number {
    return 0;
  }
  get maxVoltage(): number {
    return 5;
  }
  get lowVoltage(): number {
    return 0;
  }
  get highVoltage(): number {
    return 3.3;
  }
}

function ownGetterModel(): ElectricalPinInput['model'] {
  const values = {
    kind: 'ideal-voltage',
    minVoltage: 0,
    maxVoltage: 5,
    lowVoltage: 0,
    highVoltage: 3.3,
  };
  return Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { get: () => value, enumerable: false }]),
    ),
  ) as ElectricalPinInput['model'];
}

function getterPin(): ElectricalPinInput {
  const values = pin({ ...output, digitalIntent: true, pull: 'down' });
  const accessors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(accessors, key, { get: () => value, enumerable: false });
  }
  return accessors as unknown as ElectricalPinInput;
}

const modelSources = [
  ['own non-enumerable getters', ownGetterModel],
  ['class prototype getters', () => new GetterModel()],
] as const;

describe('snapshot field capture', () => {
  it.each(modelSources)('detects real drive conflicts for %s models', (_name, createModel) => {
    const input = network([
      pin({ ...output, pinName: 'A', digitalIntent: true, model: createModel() }),
      pin({ ...output, pinName: 'B', digitalIntent: false, model: createModel() }),
    ]);
    let failure: ElectricalConflictError | undefined;
    try {
      resolveElectricalNetwork(input);
    } catch (error) {
      expect(error).toBeInstanceOf(ElectricalConflictError);
      failure = error as ElectricalConflictError;
    }
    expect(failure).toBeDefined();
    expect(failure!.contributions.map((contribution) => contribution.voltage)).toEqual([3.3, 0]);
    expect(failure!.network.pins[0]!.model).toEqual({
      kind: 'ideal-voltage',
      minVoltage: 0,
      maxVoltage: 5,
      lowVoltage: 0,
      highVoltage: 3.3,
    });
    expect(Object.isFrozen(failure!.network.pins[0]!.model)).toBe(true);
  });

  it.each(modelSources)(
    'keeps finite strong voltage and pull bias for %s models',
    (_name, createModel) => {
      const result = resolveElectricalNetwork(
        network([pin({ ...output, digitalIntent: true, pull: 'up', model: createModel() })]),
      );
      expect(result).toEqual({
        state: 'driven',
        voltage: 3.3,
        strength: 'strong',
        contributions: [
          { instanceId: 'device', pinName: 'P', kind: 'drive', strength: 'strong', voltage: 3.3 },
          { instanceId: 'device', pinName: 'P', kind: 'pull', strength: 'weak', voltage: 3.3 },
        ],
      });
    },
  );

  it('reads pin-level getter fields once and snapshots them as data', () => {
    const source = getterPin();
    const result = resolveElectricalNetwork(network([source]));
    expect(result).toMatchObject({ state: 'driven', voltage: 3.3, strength: 'strong' });
    expect(result.contributions).toHaveLength(2);
    const failure = new ElectricalConflictError(network([getterPin()]), [
      Object.create({
        get instanceId() {
          return 'device';
        },
        get pinName() {
          return 'P';
        },
        get kind() {
          return 'drive';
        },
        get strength() {
          return 'strong';
        },
        get voltage() {
          return 0;
        },
      }) as unknown as ElectricalConflictError['contributions'][number],
    ]);
    expect(failure.contributions).toEqual([
      { instanceId: 'device', pinName: 'P', kind: 'drive', strength: 'strong', voltage: 0 },
    ]);
    expect(Object.keys(failure.contributions[0]!).sort()).toEqual([
      'instanceId',
      'kind',
      'pinName',
      'strength',
      'voltage',
    ]);
    expect(Object.isFrozen(failure.contributions[0])).toBe(true);
  });

  it.each(modelSources)('rejects unsupported fields from %s models', (_name, createModel) => {
    const model = Object.create(createModel());
    Object.defineProperty(model, 'resistance', { value: 10, enumerable: false });
    expect(() => resolveElectricalNetwork(network([pin({ model })]))).toThrow(TypeError);
    expect(() => resolveElectricalNetwork(network([pin({ model })]))).toThrow('resistance');
  });
});
