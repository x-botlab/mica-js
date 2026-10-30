import type {
  ArrayRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  StateRef,
  Value,
} from '@mica-js/ir';
export interface ResistiveNetwork {
  readonly nodes: number;
  readonly resistors: readonly {
    readonly a: number;
    readonly b: number;
    readonly resistance: number;
    readonly enabled: boolean;
  }[];
  readonly sources: readonly {
    readonly node: number;
    readonly voltage: number;
    readonly enabled: boolean;
  }[];
  readonly contacts: readonly {
    readonly a: number;
    readonly b: number;
    readonly closed: boolean;
  }[];
}
export const RESISTIVE_FAULT = Object.freeze({
  none: 0,
  invalidParameter: 1,
  sourceConflict: 2,
  numericalFailure: 3,
} as const);
export const ELECTRICAL_VALUE_STATE = Object.freeze({
  determinate: 0,
  floating: 1,
  indeterminate: 2,
} as const);
/** Internal IR resources. Device and host APIs must commit through validated operations. */
export interface ResistiveSolver {
  readonly solve: FunctionRef<readonly [], readonly []>;
  readonly resistance: ArrayRef<'f64'>;
  readonly resistorEnabled: ArrayRef<'bool'>;
  readonly sourceVoltage: ArrayRef<'f64'>;
  readonly sourceEnabled: ArrayRef<'bool'>;
  readonly contactClosed: ArrayRef<'bool'>;
  readonly voltage: ArrayRef<'f64'>;
  readonly voltageState: ArrayRef<'u8'>;
  readonly current: ArrayRef<'f64'>;
  readonly currentState: ArrayRef<'u8'>;
  readonly sourceCurrent: ArrayRef<'f64'>;
  readonly sourceCurrentState: ArrayRef<'u8'>;
  readonly contactCurrent: ArrayRef<'f64'>;
  readonly contactCurrentState: ArrayRef<'u8'>;
  readonly fault: StateRef<'u8'>;
  readonly factorizations: StateRef<'u32'>;
  readonly topologyVersion: StateRef<'u32'>;
  readonly matrixVersion: StateRef<'u32'>;
  readonly rhsVersion: StateRef<'u32'>;
  readonly invalidate: Readonly<
    Record<'topology' | 'matrix' | 'rhs', FunctionRef<readonly [], readonly []>>
  >;
}
type Program = Generator<FlowStep, void, void>;
type FlowStep =
  | {
      readonly kind: 'when';
      readonly condition: Value<'bool'>;
      readonly emit: () => Program | void;
    }
  | {
      readonly kind: 'loop';
      readonly count: number;
      readonly emit: (index: Value<'u32'>) => Program | void;
    }
  | {
      readonly kind: 'guard';
      readonly valid: Value<'bool'>;
      readonly fault: StateRef<'u8'>;
      readonly code: number;
    };
// Generators suspend authoring at block boundaries, so every IR block is fully terminated.
// They run only at compilation, never during simulation.
class Flow {
  constructor(public b: FunctionBuilder<readonly []>) {}
  u(value: number): Value<'u32'> {
    return this.b.const('u32', value);
  }
  f(value: number): Value<'f64'> {
    return this.b.const('f64', value);
  }
  load<T extends 'u32' | 'u8' | 'f64' | 'bool'>(
    array: ArrayRef<T>,
    index: number | Value<'u32'>,
  ): Value<T> {
    return this.b.array.load(array, typeof index === 'number' ? this.u(index) : index);
  }
  store<T extends 'u32' | 'u8' | 'f64' | 'bool'>(
    array: ArrayRef<T>,
    index: number | Value<'u32'>,
    value: Value<T>,
  ): void {
    this.b.array.store(array, typeof index === 'number' ? this.u(index) : index, value);
  }
  abs(value: Value<'f64'>): Value<'f64'> {
    return this.b.select(
      this.b.float.cmp('lt', value, this.f(0)),
      this.b.float.sub(this.f(0), value),
      value,
    );
  }
  *when(condition: Value<'bool'>, emit: () => Program | void): Program {
    yield { kind: 'when', condition, emit };
  }
  *loop(count: number, emit: (index: Value<'u32'>) => Program | void): Program {
    yield { kind: 'loop', count, emit };
  }
  *guard(valid: Value<'bool'>, fault: StateRef<'u8'>, code: number): Program {
    yield { kind: 'guard', valid, fault, code };
  }
  run(program: () => Program): void {
    this.advance(program(), this.b, () => {});
  }
  private advance(
    program: Program | void,
    builder: FunctionBuilder<readonly []>,
    finish: (tail: FunctionBuilder<readonly []>) => void,
  ): undefined {
    this.b = builder;
    if (program === undefined) {
      finish(this.b);
      return;
    }
    const result = program.next();
    if (result.done) {
      finish(this.b);
      return;
    }
    const step = result.value;
    const owner = this.b;
    const done = owner.block([]);
    if (step.kind === 'guard') {
      const failed = owner.block([]);
      owner.branch(step.valid, { target: done, args: [] }, { target: failed, args: [] });
      owner.at(failed, (b) => {
        b.state.store(step.fault, b.const('u8', step.code));
        b.return([]);
      });
    } else if (step.kind === 'when') {
      const yes = owner.block([]);
      owner.branch(step.condition, { target: yes, args: [] }, { target: done, args: [] });
      owner.at(yes, (b) =>
        this.advance(step.emit(), b, (tail) => {
          tail.jump(done, []);
        }),
      );
    } else {
      const header = owner.block(['u32']);
      const body = owner.block(['u32']);
      owner.jump(header, [owner.const('u32', 0)]);
      owner.at(header, (b, [index]) => {
        b.branch(
          b.int.cmp('lt', index, b.const('u32', step.count)),
          { target: body, args: [index] },
          { target: done, args: [] },
        );
      });
      owner.at(body, (b, [index]) =>
        this.advance(step.emit(index), b, (tail) => {
          tail.jump(header, [tail.int.add(index, tail.const('u32', 1))]);
        }),
      );
    }
    owner.at(done, (b) => this.advance(program, b, finish));
  }
}
/** Generates a linear solve inside the caller's unified module; no host solver callbacks. */
export function generateResistiveSolver(
  module: IRModule,
  network: ResistiveNetwork,
  prefix: string,
  onPublish: readonly FunctionRef<readonly [], readonly []>[] = [],
): ResistiveSolver {
  validateNetwork(network);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error('Invalid resistive solver prefix');
  const n = network.nodes;
  const matrixSize = n * n;
  const array = <T extends 'u32' | 'u8' | 'f64' | 'bool'>(
    name: string,
    type: T,
    initial: readonly (T extends 'bool' ? boolean : number)[],
  ): ArrayRef<T> => module.array(`${prefix}_${name}`, type, initial);
  const floats = (name: string, length: number) =>
    array(name, 'f64', Array<number>(Math.max(1, length)).fill(0));
  const flags = (name: string, length: number) =>
    array(name, 'bool', Array<boolean>(Math.max(1, length)).fill(false));
  const resistance = array(
    'resistance',
    'f64',
    network.resistors.length ? network.resistors.map((r) => r.resistance) : [1],
  );
  const resistorEnabled = array(
    'resistor_enabled',
    'bool',
    network.resistors.length ? network.resistors.map((r) => r.enabled) : [false],
  );
  const sourceVoltage = array(
    'source_voltage',
    'f64',
    network.sources.length ? network.sources.map((s) => s.voltage) : [0],
  );
  const sourceEnabled = array(
    'source_enabled',
    'bool',
    network.sources.length ? network.sources.map((s) => s.enabled) : [false],
  );
  const contactClosed = array(
    'contact_closed',
    'bool',
    network.contacts.length ? network.contacts.map((c) => c.closed) : [false],
  );
  const voltage = floats('voltage', n);
  const voltageState = array('voltage_state', 'u8', Array<number>(n).fill(1));
  const current = floats('current', network.resistors.length);
  const currentState = array(
    'current_state',
    'u8',
    Array<number>(Math.max(1, network.resistors.length)).fill(2),
  );
  const sourceCurrent = floats('source_current', network.sources.length);
  const sourceCurrentState = array(
    'source_current_state',
    'u8',
    Array<number>(Math.max(1, network.sources.length)).fill(2),
  );
  const contactCurrent = floats('contact_current', network.contacts.length);
  const contactCurrentState = array(
    'contact_current_state',
    'u8',
    Array<number>(Math.max(1, network.contacts.length)).fill(2),
  );
  const candidateContactCurrent = floats('candidate_contact_current', network.contacts.length);
  const candidateContactState = array(
    'candidate_contact_state',
    'u8',
    Array<number>(Math.max(1, network.contacts.length)).fill(2),
  );
  const contactSide = flags('contact_side', n);
  const fault = module.state(`${prefix}_fault`, 'u8', 0);
  const factorizations = module.state(`${prefix}_factorizations`, 'u32', 0);
  const validFactors = module.state(`${prefix}_valid_factors`, 'bool', false);
  const topologyVersion = module.state(`${prefix}_topology_version`, 'u32', 0);
  const matrixVersion = module.state(`${prefix}_matrix_version`, 'u32', 0);
  const rhsVersion = module.state(`${prefix}_rhs_version`, 'u32', 0);
  const factoredTopology = module.state(`${prefix}_factored_topology`, 'u32', 0);
  const factoredMatrix = module.state(`${prefix}_factored_matrix`, 'u32', 0);
  const solvedRhs = module.state(`${prefix}_solved_rhs`, 'u32', 0);
  const hasSolution = module.state(`${prefix}_has_solution`, 'bool', false);
  const invalidator = (kind: 'topology' | 'matrix' | 'rhs', version: StateRef<'u32'>) => {
    const fn = module.func(`${prefix}_invalidate_${kind}`, { params: [], results: [] });
    fn.body((b) => {
      b.state.store(version, b.int.add(b.state.load(version), b.const('u32', 1)));
      b.state.store(hasSolution, b.const('bool', false));
      if (kind !== 'rhs') b.state.store(validFactors, b.const('bool', false));
      b.return([]);
    });
    return fn;
  };
  const invalidate = Object.freeze({
    topology: invalidator('topology', topologyVersion),
    matrix: invalidator('matrix', matrixVersion),
    rhs: invalidator('rhs', rhsVersion),
  });
  const label = array(
    'label',
    'u32',
    Array.from({ length: n }, (_, i) => i),
  );
  const permutation = array(
    'permutation',
    'u32',
    Array.from({ length: n }, (_, i) => i),
  );
  const known = flags('known', n);
  const reachable = flags('reachable', n);
  const anchor = floats('anchor', n);
  const assigned = flags('assigned', n);
  const conductance = floats('conductance', matrixSize);
  const system = floats('system', matrixSize);
  const factors = floats('factors', matrixSize);
  const scale = floats('scale', n);
  const rhs = floats('rhs', n);
  const work = floats('work', n);
  const candidate = floats('candidate', n);
  const candidateCurrent = floats('candidate_current', network.resistors.length);
  const candidateSourceCurrent = floats('candidate_source_current', network.sources.length);
  const candidateSourceState = array(
    'candidate_source_state',
    'u8',
    Array<number>(Math.max(1, network.sources.length)).fill(2),
  );
  const pivotRow = module.state(`${prefix}_pivot_row`, 'u32', 0);
  const pivotMagnitude = module.state(`${prefix}_pivot_magnitude`, 'f64', 0);
  const accumulator = module.state(`${prefix}_accumulator`, 'f64', 0);
  const magnitude = module.state(`${prefix}_magnitude`, 'f64', 0);
  const factor = module.func(`${prefix}_factor`, { params: [], results: [] });
  const solve = module.func(`${prefix}_solve`, { params: [], results: [] });
  const at = (q: Flow, row: Value<'u32'>, column: Value<'u32'>) =>
    q.b.int.add(q.b.int.mul(row, q.u(n)), column);
  const addAt = (q: Flow, row: Value<'u32'>, column: Value<'u32'>, delta: Value<'f64'>) => {
    const index = at(q, row, column);
    q.store(conductance, index, q.b.float.add(q.load(conductance, index), delta));
  };
  factor.body((builder) => {
    const q = new Flow(builder);
    q.run(function* () {
      q.b.state.store(validFactors, q.b.const('bool', false));
      yield* q.loop(n, function (i) {
        q.store(label, i, i);
        q.store(known, i, q.b.const('bool', false));
        q.store(reachable, i, q.b.const('bool', false));
      });
      // Fixed bounded label relaxation computes connected components of ideal contacts only.
      yield* q.loop(n, function* () {
        for (const [index, contact] of network.contacts.entries()) {
          yield* q.when(q.load(contactClosed, index), function () {
            const a = q.load(label, contact.a);
            const b = q.load(label, contact.b);
            const min = q.b.select(q.b.int.cmp('lt', a, b), a, b);
            q.store(label, contact.a, min);
            q.store(label, contact.b, min);
          });
        }
      });
      for (const [index, source] of network.sources.entries()) {
        yield* q.when(q.load(sourceEnabled, index), function () {
          const root = q.load(label, source.node);
          q.store(known, root, q.b.const('bool', true));
          q.store(reachable, root, q.b.const('bool', true));
        });
      }
      yield* q.loop(n, function* () {
        for (const [index, resistor] of network.resistors.entries()) {
          yield* q.when(q.load(resistorEnabled, index), function () {
            const a = q.load(label, resistor.a);
            const b = q.load(label, resistor.b);
            const connected = q.b.bool.or(q.load(reachable, a), q.load(reachable, b));
            q.store(reachable, a, connected);
            q.store(reachable, b, connected);
          });
        }
      });
      yield* q.loop(matrixSize, function (i) {
        q.store(conductance, i, q.f(0));
      });
      for (const [index, resistor] of network.resistors.entries()) {
        yield* q.when(q.load(resistorEnabled, index), function* () {
          const a = q.load(label, resistor.a);
          const b = q.load(label, resistor.b);
          const g = q.b.float.div(q.f(1), q.load(resistance, index));
          yield* q.guard(
            q.b.bool.and(q.b.float.isFinite(g), q.b.float.cmp('gt', g, q.f(0))),
            fault,
            RESISTIVE_FAULT.numericalFailure,
          );
          yield* q.when(q.b.int.cmp('ne', a, b), function () {
            const negative = q.b.float.sub(q.f(0), g);
            addAt(q, a, a, g);
            addAt(q, b, b, g);
            addAt(q, a, b, negative);
            addAt(q, b, a, negative);
          });
        });
      }
      yield* q.loop(n, function* (row) {
        const active = q.b.bool.and(q.load(reachable, row), q.b.bool.not(q.load(known, row)));
        const diagonal = q.load(conductance, at(q, row, row));
        const divisor = q.b.select(active, diagonal, q.f(1));
        yield* q.guard(
          q.b.bool.and(q.b.float.isFinite(divisor), q.b.float.cmp('gt', divisor, q.f(0))),
          fault,
          RESISTIVE_FAULT.numericalFailure,
        );
        q.store(scale, row, divisor);
        yield* q.loop(n, function* (column) {
          const included = q.b.bool.and(active, q.b.bool.not(q.load(known, column)));
          const identity = q.b.select(q.b.int.cmp('eq', row, column), q.f(1), q.f(0));
          const coefficient = q.b.select(
            included,
            q.b.float.div(q.load(conductance, at(q, row, column)), divisor),
            q.b.select(active, q.f(0), identity),
          );
          yield* q.guard(q.b.float.isFinite(coefficient), fault, RESISTIVE_FAULT.numericalFailure);
          q.store(system, at(q, row, column), coefficient);
          q.store(factors, at(q, row, column), coefficient);
        });
        q.store(permutation, row, row);
      });
      yield* q.loop(n, function* (k) {
        q.b.state.store(pivotRow, k);
        q.b.state.store(pivotMagnitude, q.f(0));
        yield* q.loop(n, function* (row) {
          yield* q.when(q.b.int.cmp('ge', row, k), function* () {
            const abs = q.abs(q.load(factors, at(q, row, k)));
            yield* q.when(q.b.float.cmp('gt', abs, q.b.state.load(pivotMagnitude)), function () {
              q.b.state.store(pivotMagnitude, abs);
              q.b.state.store(pivotRow, row);
            });
          });
        });
        yield* q.guard(
          q.b.float.cmp('gt', q.b.state.load(pivotMagnitude), q.f(1e-14)),
          fault,
          RESISTIVE_FAULT.numericalFailure,
        );
        const selected = q.b.state.load(pivotRow);
        const old = q.load(permutation, k);
        q.store(permutation, k, q.load(permutation, selected));
        q.store(permutation, selected, old);
        yield* q.loop(n, function (column) {
          const before = q.load(factors, at(q, k, column));
          q.store(factors, at(q, k, column), q.load(factors, at(q, selected, column)));
          q.store(factors, at(q, selected, column), before);
        });
        yield* q.loop(n, function* (row) {
          yield* q.when(q.b.int.cmp('gt', row, k), function* () {
            const multiplier = q.b.float.div(
              q.load(factors, at(q, row, k)),
              q.load(factors, at(q, k, k)),
            );
            yield* q.guard(q.b.float.isFinite(multiplier), fault, RESISTIVE_FAULT.numericalFailure);
            q.store(factors, at(q, row, k), multiplier);
            yield* q.loop(n, function* (column) {
              yield* q.when(q.b.int.cmp('gt', column, k), function* () {
                const value = q.b.float.sub(
                  q.load(factors, at(q, row, column)),
                  q.b.float.mul(multiplier, q.load(factors, at(q, k, column))),
                );
                yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
                q.store(factors, at(q, row, column), value);
              });
            });
          });
        });
      });
      q.b.state.store(factoredTopology, q.b.state.load(topologyVersion));
      q.b.state.store(factoredMatrix, q.b.state.load(matrixVersion));
      q.b.state.store(validFactors, q.b.const('bool', true));
      q.b.state.store(factorizations, q.b.int.add(q.b.state.load(factorizations), q.u(1)));
      q.b.return([]);
    });
  });
  solve.body((builder) => {
    const sameTopology = builder.int.cmp(
      'eq',
      builder.state.load(topologyVersion),
      builder.state.load(factoredTopology),
    );
    const sameMatrix = builder.int.cmp(
      'eq',
      builder.state.load(matrixVersion),
      builder.state.load(factoredMatrix),
    );
    const sameRhs = builder.int.cmp(
      'eq',
      builder.state.load(rhsVersion),
      builder.state.load(solvedRhs),
    );
    const sameFactors = builder.bool.and(
      builder.state.load(validFactors),
      builder.bool.and(sameTopology, sameMatrix),
    );
    const cached = builder.bool.and(
      builder.state.load(hasSolution),
      builder.bool.and(sameFactors, sameRhs),
    );
    const done = builder.block([]);
    const dirty = builder.block([]);
    builder.branch(cached, { target: done, args: [] }, { target: dirty, args: [] });
    builder.at(done, (b) => b.return([]));
    builder.at(dirty, (builder) => {
      const q = new Flow(builder);
      q.run(function* () {
        q.b.state.store(hasSolution, q.b.const('bool', false));
        q.b.state.store(fault, q.b.const('u8', 0));
        const changed = q.b.bool.not(sameFactors);
        for (const [i] of network.resistors.entries()) {
          const r = q.load(resistance, i);
          yield* q.guard(
            q.b.bool.and(q.b.float.isFinite(r), q.b.float.cmp('gt', r, q.f(0))),
            fault,
            RESISTIVE_FAULT.invalidParameter,
          );
        }
        for (const [i] of network.sources.entries()) {
          yield* q.guard(
            q.b.float.isFinite(q.load(sourceVoltage, i)),
            fault,
            RESISTIVE_FAULT.invalidParameter,
          );
        }
        yield* q.when(changed, function () {
          q.b.call(factor, []);
        });
        yield* q.guard(
          q.b.int.cmp('eq', q.b.state.load(fault), q.b.const('u8', 0)),
          fault,
          RESISTIVE_FAULT.numericalFailure,
        );
        yield* q.loop(n, function (i) {
          q.store(anchor, i, q.f(0));
          q.store(assigned, i, q.b.const('bool', false));
        });
        for (const [i, source] of network.sources.entries()) {
          yield* q.when(q.load(sourceEnabled, i), function* () {
            const root = q.load(label, source.node);
            const value = q.load(sourceVoltage, i);
            const compatible = q.b.bool.or(
              q.b.bool.not(q.load(assigned, root)),
              q.b.float.cmp('eq', q.load(anchor, root), value),
            );
            yield* q.guard(compatible, fault, RESISTIVE_FAULT.sourceConflict);
            q.store(anchor, root, value);
            q.store(assigned, root, q.b.const('bool', true));
          });
        }
        yield* q.loop(n, function* (row) {
          q.b.state.store(accumulator, q.f(0));
          yield* q.loop(n, function (column) {
            const sourceTerm = q.b.select(
              q.load(known, column),
              q.b.float.mul(
                q.b.float.div(q.load(conductance, at(q, row, column)), q.load(scale, row)),
                q.load(anchor, column),
              ),
              q.f(0),
            );
            q.b.state.store(accumulator, q.b.float.sub(q.b.state.load(accumulator), sourceTerm));
          });
          const active = q.b.bool.and(q.load(reachable, row), q.b.bool.not(q.load(known, row)));
          const value = q.b.select(
            q.load(known, row),
            q.load(anchor, row),
            q.b.select(active, q.b.state.load(accumulator), q.f(0)),
          );
          yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
          q.store(rhs, row, value);
        });
        yield* q.loop(n, function* (row) {
          q.b.state.store(accumulator, q.load(rhs, q.load(permutation, row)));
          yield* q.loop(n, function* (column) {
            yield* q.when(q.b.int.cmp('lt', column, row), function () {
              q.b.state.store(
                accumulator,
                q.b.float.sub(
                  q.b.state.load(accumulator),
                  q.b.float.mul(q.load(factors, at(q, row, column)), q.load(work, column)),
                ),
              );
            });
          });
          q.store(work, row, q.b.state.load(accumulator));
        });
        yield* q.loop(n, function* (reverse) {
          const row = q.b.int.sub(q.u(n - 1), reverse);
          q.b.state.store(accumulator, q.load(work, row));
          yield* q.loop(n, function* (column) {
            yield* q.when(q.b.int.cmp('gt', column, row), function () {
              q.b.state.store(
                accumulator,
                q.b.float.sub(
                  q.b.state.load(accumulator),
                  q.b.float.mul(q.load(factors, at(q, row, column)), q.load(candidate, column)),
                ),
              );
            });
          });
          const value = q.b.float.div(
            q.b.state.load(accumulator),
            q.load(factors, at(q, row, row)),
          );
          yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
          q.store(candidate, row, value);
        });
        yield* q.loop(n, function* (row) {
          q.b.state.store(accumulator, q.f(0));
          q.b.state.store(magnitude, q.b.float.mul(q.f(1e-10), q.abs(q.load(rhs, row))));
          yield* q.loop(n, function (column) {
            const term = q.b.float.mul(
              q.load(system, at(q, row, column)),
              q.load(candidate, column),
            );
            q.b.state.store(accumulator, q.b.float.add(q.b.state.load(accumulator), term));
            q.b.state.store(
              magnitude,
              q.b.float.add(q.b.state.load(magnitude), q.b.float.mul(q.f(1e-10), q.abs(term))),
            );
          });
          const error = q.abs(q.b.float.sub(q.b.state.load(accumulator), q.load(rhs, row)));
          const tolerance = q.b.float.add(q.f(1e-22), q.b.state.load(magnitude));
          yield* q.guard(
            q.b.bool.and(q.b.float.isFinite(error), q.b.float.cmp('le', error, tolerance)),
            fault,
            RESISTIVE_FAULT.numericalFailure,
          );
        });
        // Currents and voltages are staged until the entire candidate snapshot is finite.
        for (const [i, resistor] of network.resistors.entries()) {
          const delta = q.b.float.sub(
            q.load(candidate, q.load(label, resistor.a)),
            q.load(candidate, q.load(label, resistor.b)),
          );
          const value = q.b.select(
            q.load(resistorEnabled, i),
            q.b.float.div(delta, q.load(resistance, i)),
            q.f(0),
          );
          yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
          q.store(candidateCurrent, i, value);
        }
        for (const [i, source] of network.sources.entries()) {
          const root = q.load(label, source.node);
          let unique = q.b.const('bool', true);
          for (const [j, other] of network.sources.entries()) {
            if (i === j) continue;
            unique = q.b.bool.and(
              unique,
              q.b.bool.not(
                q.b.bool.and(
                  q.load(sourceEnabled, j),
                  q.b.int.cmp('eq', root, q.load(label, other.node)),
                ),
              ),
            );
          }
          q.b.state.store(accumulator, q.f(0));
          for (const [j, resistor] of network.resistors.entries()) {
            const a = q.load(label, resistor.a);
            const b = q.load(label, resistor.b);
            const outward = q.b.select(
              q.b.int.cmp('eq', root, a),
              q.load(candidateCurrent, j),
              q.f(0),
            );
            const inward = q.b.select(
              q.b.int.cmp('eq', root, b),
              q.load(candidateCurrent, j),
              q.f(0),
            );
            q.b.state.store(
              accumulator,
              q.b.float.add(q.b.state.load(accumulator), q.b.float.sub(outward, inward)),
            );
          }
          const enabled = q.load(sourceEnabled, i);
          const value = q.b.select(
            q.b.bool.and(enabled, unique),
            q.b.state.load(accumulator),
            q.f(0),
          );
          yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
          q.store(candidateSourceCurrent, i, value);
          q.store(
            candidateSourceState,
            i,
            q.b.select(
              q.b.bool.or(q.b.bool.not(enabled), unique),
              q.b.const('u8', 0),
              q.b.const('u8', 2),
            ),
          );
        }
        // Removing a closed contact identifies its cut. KCL determines a bridge current only
        // when at least one side contains no ideal source; cycles retain a free loop current.
        for (const [i, contact] of network.contacts.entries()) {
          q.store(candidateContactCurrent, i, q.f(0));
          q.store(candidateContactState, i, q.b.const('u8', 0));
          yield* q.when(q.load(contactClosed, i), function* () {
            yield* q.loop(n, function (node) {
              q.store(contactSide, node, q.b.int.cmp('eq', node, q.u(contact.a)));
            });
            yield* q.loop(n, function* () {
              for (const [j, edge] of network.contacts.entries()) {
                if (i === j) continue;
                yield* q.when(q.load(contactClosed, j), function () {
                  const connected = q.b.bool.or(
                    q.load(contactSide, edge.a),
                    q.load(contactSide, edge.b),
                  );
                  q.store(contactSide, edge.a, connected);
                  q.store(contactSide, edge.b, connected);
                });
              }
            });
            const root = q.load(label, contact.a);
            let leftSource = q.b.const('bool', false);
            let rightSource = q.b.const('bool', false);
            for (const [j, source] of network.sources.entries()) {
              const same = q.b.bool.and(
                q.load(sourceEnabled, j),
                q.b.int.cmp('eq', root, q.load(label, source.node)),
              );
              leftSource = q.b.bool.or(
                leftSource,
                q.b.bool.and(same, q.load(contactSide, source.node)),
              );
              rightSource = q.b.bool.or(
                rightSource,
                q.b.bool.and(same, q.b.bool.not(q.load(contactSide, source.node))),
              );
            }
            let leftOut = q.f(0);
            let rightOut = q.f(0);
            const right = (node: number) =>
              q.b.bool.and(
                q.b.int.cmp('eq', root, q.load(label, node)),
                q.b.bool.not(q.load(contactSide, node)),
              );
            for (const [j, resistor] of network.resistors.entries()) {
              const value = q.load(candidateCurrent, j);
              const netOut = (a: Value<'bool'>, b: Value<'bool'>) =>
                q.b.float.sub(q.b.select(a, value, q.f(0)), q.b.select(b, value, q.f(0)));
              leftOut = q.b.float.add(
                leftOut,
                netOut(q.load(contactSide, resistor.a), q.load(contactSide, resistor.b)),
              );
              rightOut = q.b.float.add(rightOut, netOut(right(resistor.a), right(resistor.b)));
            }
            const unique = q.b.bool.and(
              q.b.bool.not(q.load(contactSide, contact.b)),
              q.b.bool.not(q.b.bool.and(leftSource, rightSource)),
            );
            const value = q.b.select(leftSource, rightOut, q.b.float.sub(q.f(0), leftOut));
            yield* q.guard(q.b.float.isFinite(value), fault, RESISTIVE_FAULT.numericalFailure);
            q.store(candidateContactCurrent, i, q.b.select(unique, value, q.f(0)));
            q.store(
              candidateContactState,
              i,
              q.b.select(unique, q.b.const('u8', 0), q.b.const('u8', 2)),
            );
          });
        }
        yield* q.loop(n, function (node) {
          const root = q.load(label, node);
          q.store(voltage, node, q.load(candidate, root));
          q.store(
            voltageState,
            node,
            q.b.select(q.load(reachable, root), q.b.const('u8', 0), q.b.const('u8', 1)),
          );
        });
        for (const [i] of network.resistors.entries()) {
          q.store(current, i, q.load(candidateCurrent, i));
          // A source-free passive component has an unknown common-mode voltage but zero
          // finite-branch current. Floating node voltages do not make that current ambiguous.
          q.store(currentState, i, q.b.const('u8', 0));
        }
        for (const [i] of network.sources.entries()) {
          q.store(sourceCurrent, i, q.load(candidateSourceCurrent, i));
          q.store(sourceCurrentState, i, q.load(candidateSourceState, i));
        }
        for (const [i] of network.contacts.entries()) {
          q.store(contactCurrent, i, q.load(candidateContactCurrent, i));
          q.store(contactCurrentState, i, q.load(candidateContactState, i));
        }
        q.b.state.store(solvedRhs, q.b.state.load(rhsVersion));
        q.b.state.store(hasSolution, q.b.const('bool', true));
        for (const observer of onPublish) q.b.call(observer, []);
        q.b.return([]);
      });
    });
  });
  return Object.freeze({
    solve,
    resistance,
    resistorEnabled,
    sourceVoltage,
    sourceEnabled,
    contactClosed,
    voltage,
    voltageState,
    current,
    currentState,
    sourceCurrent,
    sourceCurrentState,
    contactCurrent,
    contactCurrentState,
    fault,
    factorizations,
    topologyVersion,
    matrixVersion,
    rhsVersion,
    invalidate,
  });
}
function validateNetwork(network: ResistiveNetwork): void {
  if (!Number.isSafeInteger(network.nodes) || network.nodes < 1)
    throw new Error('A resistive network needs a positive node count');
  const node = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= network.nodes)
      throw new Error(`Invalid node ${index}`);
  };
  for (const resistor of network.resistors) {
    node(resistor.a);
    node(resistor.b);
    if (
      !Number.isFinite(resistor.resistance) ||
      resistor.resistance <= 0 ||
      typeof resistor.enabled !== 'boolean'
    )
      throw new Error('Invalid initial resistor state');
  }
  for (const source of network.sources) {
    node(source.node);
    if (!Number.isFinite(source.voltage) || typeof source.enabled !== 'boolean')
      throw new Error('Invalid initial source state');
  }
  for (const contact of network.contacts) {
    node(contact.a);
    node(contact.b);
    if (typeof contact.closed !== 'boolean') throw new Error('Invalid initial contact state');
  }
}
