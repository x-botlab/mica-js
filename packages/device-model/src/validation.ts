import { BuildError, fail, snapshot } from './errors.js';
import { blockSchema, builtins, deviceSchema, loads, numeric, stores } from './schema.js';
import type {
  BlockIR,
  ComputationIR,
  ConstantIR,
  DeclarationIR,
  DeviceIR,
  Diagnostic,
  DiagnosticPhase,
  InputPath,
  Located,
  MatchPatternIR,
  MemoryRefIR,
  OperationIR,
  ParameterIR,
  PinRefIR,
  RegionIR,
  ResultIR,
  ValueRegionIR,
  ValueTypeIR,
} from './ir.js';

type FunctionDeclaration = Extract<DeclarationIR, { kind: 'function' }>;
type ReactionDeclaration = Extract<DeclarationIR, { kind: 'reaction' }>;
type RecordDeclaration = Extract<DeclarationIR, { kind: 'record' }>;

type VType = ValueTypeIR;
type Facts = Map<string, boolean>;
interface Info {
  type: VType;
  key: string;
  yes?: Facts;
  no?: Facts;
  none?: boolean;
}
interface Slot {
  type: VType;
  value: Info;
}
interface State {
  facts: Facts;
  locals: Map<number, Slot>;
}
interface Flow {
  normal?: State;
  breaks: State[];
  continues: State[];
  yielded: Info[];
  yieldStates: State[];
}
type Mode = 'creation' | 'initial' | 'pure' | 'sync' | 'process' | 'reaction' | 'jit';
interface Context {
  mode: Mode;
  params: readonly ParameterIR[];
  returns?: VType;
  valueRegion?: VType;
  loop: number;
  results: Map<number, Info>;
  resultIds: Set<number>;
  localIds: Set<number>;
  reaction?: ReactionDeclaration;
  tail: boolean;
  finalInstruction: boolean;
  computation: boolean;
}
const numberType: VType = { kind: 'number' },
  boolType: VType = { kind: 'bool' },
  stringType: VType = { kind: 'string' };
const bytesType: VType = { kind: 'bytes' },
  intentType: VType = { kind: 'intent' },
  sampleType: VType = { kind: 'sample' };
const reserved = new Set([
  'device',
  'default',
  'const',
  'let',
  'enum',
  'record',
  'state',
  'derived',
  'pin',
  'memory',
  'fn',
  'pure',
  'process',
  'on',
  'reaction',
  'as',
  'capture',
  'if',
  'else',
  'match',
  'while',
  'loop',
  'break',
  'continue',
  'return',
  'await',
  'assert',
  'redirect',
  'true',
  'false',
  'none',
  'start',
  'number',
  'bool',
  'string',
  'bytes',
  'sample',
  'intent',
  'NaN',
  'Infinity',
  ...Object.keys(builtins),
  ...numeric,
  ...loads,
  ...stores,
  'resistor',
  'copyBytes',
  'now',
  'random',
  'ticks',
]);
export function sameType(a: unknown, b: unknown): boolean {
  const left = a as Record<string, unknown> | null | undefined;
  const right = b as Record<string, unknown> | null | undefined;
  return (
    left?.kind === right?.kind &&
    (left?.kind === 'optional'
      ? sameType(left.inner, right?.inner)
      : left?.kind === 'enum' || left?.kind === 'record'
        ? left.name === right?.name
        : true)
  );
}
function inner(t: VType): Exclude<VType, { kind: 'optional' }> {
  return t.kind === 'optional' ? t.inner : t;
}
function comparable(t: VType): boolean {
  return inner(t).kind !== 'intent';
}
function copy(s: State): State {
  return { facts: new Map(s.facts), locals: new Map(s.locals) };
}
function intersect(maps: Facts[]): Facts {
  const out = new Map(maps[0]);
  for (const [k, v] of out) if (maps.some((map) => map.get(k) !== v)) out.delete(k);
  return out;
}
function lexical(flow: Flow, visible: Map<number, Slot>): Flow {
  for (const state of [flow.normal, ...flow.breaks, ...flow.continues, ...flow.yieldStates]) {
    if (state) for (const id of state.locals.keys()) if (!visible.has(id)) state.locals.delete(id);
  }
  return flow;
}
function merge(states: State[]): State | undefined {
  if (!states.length) return undefined;
  const out = copy(states[0]!);
  out.facts = intersect(states.map((s) => s.facts));
  for (const [id, slot] of out.locals) {
    const candidates = states.map((s) => s.locals.get(id));
    if (candidates.some((c) => !c)) {
      out.locals.delete(id);
      continue;
    }
    if (candidates.some((c) => c!.value.key !== slot.value.key)) {
      const info: Info = {
        type: slot.type,
        key: `join:${id}:${candidates.map((c) => c!.value.key).join('|')}`,
      };
      const facts = candidates.map((c, i) => states[i]!.facts.get(c!.value.key));
      if (facts.every((f) => f === true)) out.facts.set(info.key, true);
      if (facts.every((f) => f === false)) out.facts.set(info.key, false);
      out.locals.set(id, { type: slot.type, value: info });
    }
  }
  return out;
}
function walk(
  region: RegionIR,
  visit: (op: OperationIR, p: InputPath) => void,
  path: InputPath = [],
): void {
  region.operations.forEach((op, i) => {
    const p = [...path, 'operations', i];
    visit(op, p);
    for (const key of ['yes', 'no', 'otherwise', 'body'] as const) {
      const nested =
        key in op ? (op as Partial<Record<typeof key, RegionIR | ValueRegionIR>>)[key] : undefined;
      if (nested) {
        const valueRegion = 'body' in nested;
        walk(valueRegion ? nested.body : nested, visit, [
          ...p,
          key,
          ...(valueRegion ? ['body'] : []),
        ]);
      }
    }
    if (op.kind === 'while') walk(op.test.body, visit, [...p, 'test', 'body']);
    if (op.kind === 'assert' && op.message) walk(op.message.body, visit, [...p, 'message', 'body']);
    if (op.kind === 'and' || op.kind === 'or') walk(op.right.body, visit, [...p, 'right', 'body']);
    if (op.kind === 'match')
      op.arms.forEach((a, j) => walk(a.body, visit, [...p, 'arms', j, 'body']));
  });
}
class Validator {
  readonly declarations = new Map<string, DeclarationIR>();
  readonly paths = new Map<string, InputPath>();
  readonly enums = new Map<string, readonly string[]>(Object.entries(builtins));
  readonly records = new Map<string, RecordDeclaration['fields']>();
  readonly functions = new Map<string, FunctionDeclaration>();
  readonly effectChecked = new Set<string>();
  readonly receiveOwners = new Map<string, string>();
  constructor(readonly device?: DeviceIR) {
    if (!device) return;
    this.name(device.name, ['name']);
    let starts = 0;
    device.declarations.forEach((d, i) => {
      const p = ['declarations', i];
      if (d.kind === 'start') {
        if (++starts > 1) this.error('IR_REFERENCE', 'Only one start process is allowed.', p);
        return;
      }
      if (d.kind === 'assert') return;
      this.name(d.name, [...p, 'name']);
      if (this.declarations.has(d.name))
        this.error('IR_REFERENCE', `Duplicate declaration ${d.name}.`, p);
      this.declarations.set(d.name, d);
      this.paths.set(d.name, p);
      if (d.kind === 'enum') {
        this.uniqueNames(d.members, [...p, 'members']);
        if (!d.members.length) this.error('IR_TYPE', 'An enum must have at least one member.', p);
        this.enums.set(d.name, d.members);
      }
      if (d.kind === 'record') {
        this.uniqueNames(
          d.fields.map((f) => f.name),
          [...p, 'fields'],
        );
        this.records.set(d.name, d.fields);
      }
      if (d.kind === 'function') this.functions.set(d.name, d);
    });
  }
  error(code: Parameters<typeof fail>[0], message: string, path: InputPath, node?: object): never {
    return fail(code, message, path, 'finalize', (node as Located | undefined)?.source);
  }
  name(name: string, p: InputPath): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name))
      this.error('IR_REFERENCE', `Invalid or reserved identifier ${name}.`, p);
  }
  uniqueNames(names: readonly string[], p: InputPath, members = false): void {
    const seen = new Set<string>();
    names.forEach((name, i) => {
      if (members) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          this.error('IR_REFERENCE', 'Invalid member name.', [...p, i]);
      } else this.name(name, [...p, i]);
      if (seen.has(name)) this.error('IR_REFERENCE', `Duplicate name ${name}.`, [...p, i]);
      seen.add(name);
    });
  }
  type(t: VType, p: InputPath): void {
    const v = inner(t);
    if (v.kind === 'enum' && !this.enums.has(v.name) && this.device)
      this.error('IR_REFERENCE', `Unknown enum ${v.name}.`, p);
    if (v.kind === 'record' && !this.records.has(v.name) && this.device)
      this.error('IR_REFERENCE', `Unknown record ${v.name}.`, p);
  }
  expect(actual: unknown, expected: unknown, p: InputPath, node?: object): void {
    if (!sameType(actual, expected))
      this.error(
        'IR_TYPE',
        `Expected ${this.describe(expected)}, received ${this.describe(actual)}.`,
        p,
        node,
      );
  }
  describe(t: unknown): string {
    const type = t as Record<string, unknown> | null | undefined;
    return !type
      ? 'no value'
      : type.kind === 'optional'
        ? `${this.describe(type.inner)}?`
        : String(type.name ?? type.kind);
  }
  declaration<K extends DeclarationIR['kind']>(
    name: string,
    kind: K,
    p: InputPath,
  ): Extract<DeclarationIR, { kind: K }> | undefined {
    if (!this.device) return undefined;
    const d = this.declarations.get(name);
    if (!d || d.kind !== kind)
      this.error('IR_REFERENCE', `Expected ${kind} declaration ${name}.`, p);
    return d as Extract<DeclarationIR, { kind: K }>;
  }
  ref(ref: PinRefIR | MemoryRefIR, category: string | undefined, c: Context, p: InputPath): string {
    const kind = ref.kind === 'parameter' ? ref.resource : ref.kind;
    if (category && kind !== category)
      this.error('IR_REFERENCE', 'Resource category does not match.', p);
    if (ref.kind === 'parameter') {
      const param = c.params[ref.index];
      if (!param) this.error('IR_SCOPE', 'Resource parameter is outside the current function.', p);
      if (param.type.kind !== kind)
        this.error('IR_REFERENCE', 'Resource parameter category does not match.', p);
    } else this.declaration(ref.name, kind, p);
    return kind;
  }
  field(t: VType, field: string, p: InputPath): VType {
    if (t.kind === 'sample') {
      const fields: Record<string, VType> = {
        voltage: { kind: 'optional', inner: numberType as { kind: 'number' } },
        level: { kind: 'enum', name: 'Logic' },
        status: { kind: 'enum', name: 'SampleStatus' },
      };
      if (!fields[field]) this.error('IR_REFERENCE', `Unknown sample field ${field}.`, p);
      return fields[field]!;
    }
    if (t.kind !== 'record') this.error('IR_TYPE', 'Field access requires a record or sample.', p);
    const fields = this.records.get(t.name);
    if (!fields && !this.device) return numberType;
    const f = fields?.find((f) => f.name === field);
    if (!f) this.error('IR_REFERENCE', `Unknown record field ${field}.`, p);
    return { kind: f.type };
  }
  constant(k: ConstantIR | MatchPatternIR, t: VType, p: InputPath): void {
    if (k.kind === 'none') {
      if (t.kind !== 'optional') this.error('IR_TYPE', 'none requires an optional result type.', p);
      return;
    }
    if (t.kind === 'optional')
      this.error(
        'IR_TYPE',
        'Non-null constants require a nonoptional type and explicit optional lift.',
        p,
      );
    if (
      k.kind !== t.kind ||
      ((k.kind === 'enum' || k.kind === 'record') && k.name !== ('name' in t ? t.name : undefined))
    )
      this.error('IR_TYPE', 'Constant and result types do not match.', p);
    if (k.kind === 'enum') {
      const members = this.enums.get(k.name);
      if (members && !members.includes(k.member))
        this.error('IR_REFERENCE', `Unknown enum member ${k.member}.`, p);
    }
    if (k.kind === 'record')
      this.recordFields(k.fields, t, p, (f) => ({
        kind: typeof f.value === 'boolean' ? 'bool' : 'number',
      }));
  }
  recordFields<T extends { readonly name: string }>(
    fields: readonly T[],
    t: VType,
    p: InputPath,
    get: (f: T) => VType,
  ): void {
    if (t.kind !== 'record')
      this.error('IR_TYPE', 'Record construction requires a named record type.', p);
    const expected = this.records.get(t.name);
    const seen = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      if (seen.has(f.name))
        this.error('IR_REFERENCE', 'Duplicate record field.', [...p, 'fields', i]);
      seen.add(f.name);
      if (expected) {
        const declaration = expected.find((e) => e.name === f.name);
        if (!declaration)
          this.error('IR_REFERENCE', `Unknown record field ${f.name}.`, [...p, 'fields', i]);
        this.expect(get(f), { kind: declaration.type }, [...p, 'fields', i]);
      } else get(f);
    }
    if (expected && expected.length !== fields.length)
      this.error('IR_TYPE', 'Record fields are incomplete.', p);
  }
  context(mode: Mode, returns?: VType): Context {
    return {
      mode,
      params: [],
      ...(returns ? { returns } : {}),
      loop: 0,
      results: new Map(),
      resultIds: new Set(),
      localIds: new Set(),
      tail: true,
      finalInstruction: true,
      computation: false,
    };
  }
  body(body: RegionIR, c: Context, p: InputPath): void {
    const out = this.region(body, c, { facts: new Map(), locals: new Map() }, p);
    if (c.returns && out.normal)
      this.error(
        'IR_CONTROL_FLOW',
        'A value-returning body has a normal path without returnValue.',
        p,
        body,
      );
    this.effects(body, c.mode, p);
  }
  computation(value: ComputationIR, expected: VType, mode: Mode, p: InputPath): void {
    this.type(value.type, [...p, 'type']);
    this.expect(value.type, expected, [...p, 'type']);
    const c = this.context(mode, expected);
    c.computation = true;
    this.body(value.body, c, [...p, 'body']);
  }
  conditioned(s: State, info: Info, truth: boolean): State {
    const out = copy(s),
      facts = truth ? info.yes : info.no;
    if (facts) for (const [key, value] of facts) out.facts.set(key, value);
    return out;
  }
  region(body: RegionIR, c: Context, initial: State, p: InputPath): Flow {
    let state: State | undefined = copy(initial);
    const flow: Flow = { breaks: [], continues: [], yielded: [], yieldStates: [] };
    const results = new Map(c.results);
    c = { ...c, results };
    for (let i = 0; i < body.operations.length; i++) {
      const op = body.operations[i]!,
        q = [...p, 'operations', i];
      if (!state)
        this.error('IR_CONTROL_FLOW', 'Operation follows an unconditional path terminator.', q, op);
      const s: State = state;
      const get = (id: number, expected?: VType): Info => {
        const info = results.get(id);
        if (!info)
          this.error(
            'IR_SCOPE',
            `Result ${id} is not visible or is used before its definition.`,
            q,
            op,
          );
        if (expected) this.expect(info.type, expected, q, op);
        return info;
      };
      const result = (t: VType, details: Partial<Info> = {}): Info => {
        const output = op as OperationIR & ResultIR;
        this.expect(output.type, t, [...q, 'type'], op);
        const value: Info = { type: output.type, key: `v:${output.result}`, ...details };
        results.set(output.result, value);
        return value;
      };
      if ('result' in op) {
        this.type(op.type, [...q, 'type']);
        if (c.resultIds.has(op.result))
          this.error('IR_SCOPE', `Duplicate result ${op.result}.`, [...q, 'result'], op);
        c.resultIds.add(op.result);
      }
      const slot = (id: number): Slot => {
        const v = s.locals.get(id);
        if (!v)
          this.error('IR_SCOPE', 'Local is not visible or not initialized.', [...q, 'local'], op);
        return v;
      };
      const child = (
        region: RegionIR,
        branch: State,
        key: string,
        overrides: Partial<Context> = {},
      ): Flow =>
        lexical(
          this.region(
            region,
            { ...c, tail: c.tail && i === body.operations.length - 1, ...overrides },
            branch,
            [...q, key],
          ),
          branch.locals,
        );
      const accumulate = (f: Flow): void => {
        flow.breaks.push(...f.breaks);
        flow.continues.push(...f.continues);
        flow.yielded.push(...f.yielded);
        flow.yieldStates.push(...f.yieldStates);
      };
      const valueRegion = (
        value: ValueRegionIR,
        expected: VType,
        branch: State,
        key: string,
      ): { flow: Flow; value?: Info } => {
        this.type(value.type, [...q, key, 'type']);
        this.expect(value.type, expected, [...q, key, 'type']);
        const f = lexical(
          this.region(value.body, { ...c, valueRegion: expected, loop: 0, tail: false }, branch, [
            ...q,
            key,
            'body',
          ]),
          branch.locals,
        );
        if (f.normal)
          this.error(
            'IR_CONTROL_FLOW',
            'A value region has a normal path without yield.',
            [...q, key],
            value,
          );
        return {
          flow: f,
          ...(f.yielded.length
            ? {
                value: {
                  type: expected,
                  key: `region:${'result' in op ? op.result : undefined}:${key}`,
                  yes: intersect(f.yielded.map((v) => v.yes ?? new Map())),
                  no: intersect(f.yielded.map((v) => v.no ?? new Map())),
                },
              }
            : {}),
        };
      };
      switch (op.kind) {
        case 'constant': {
          this.constant(op.constant, op.type, [...q, 'constant']);
          const info = result(op.type, { none: op.constant.kind === 'none' });
          if (op.constant.kind === 'none') s.facts.set(info.key, false);
          break;
        }
        case 'read': {
          const d = this.declaration(op.name, op.resource, q);
          result(d?.type ?? op.type);
          break;
        }
        case 'parameter': {
          const param = c.params[op.index];
          if (!param)
            this.error('IR_SCOPE', 'Parameter index is outside the current function.', q, op);
          if (param.type.kind === 'pin' || param.type.kind === 'memory')
            this.error('IR_TYPE', 'Resource parameters cannot be read as values.', q, op);
          result(param.type as VType, { key: `parameter:${op.index}` });
          break;
        }
        case 'reactionValue':
          if (!c.reaction)
            this.error(
              'IR_SCOPE',
              'Reaction bindings are only visible inside their response body.',
              q,
              op,
            );
          result(c.reaction.sourceType, { key: `reaction:${op.binding}` });
          break;
        case 'reactionCapture':
          if (!c.reaction)
            this.error(
              'IR_SCOPE',
              'Reaction captures are only visible inside their response body.',
              q,
              op,
            );
          if (!c.reaction.captures[op.index])
            this.error('IR_SCOPE', 'Reaction capture index is out of range.', q, op);
          result(c.reaction.captures[op.index]!.value.type, { key: `capture:${op.index}` });
          break;
        case 'unary': {
          const info = get(op.value, op.operator === 'not' ? boolType : numberType);
          result(
            op.operator === 'not' ? boolType : numberType,
            op.operator === 'not' ? { yes: info.no ?? new Map(), no: info.yes ?? new Map() } : {},
          );
          break;
        }
        case 'binary': {
          const left = get(op.left),
            right = get(op.right);
          if (['equal', 'notEqual'].includes(op.operator)) {
            this.expect(left.type, right.type, q, op);
            if (
              !comparable(left.type) &&
              !(left.type.kind === 'optional' && (left.none || right.none))
            )
              this.error('IR_TYPE', 'Intent values do not support content equality.', q, op);
            const tested = left.none ? right : right.none ? left : undefined;
            const equal = op.operator === 'equal';
            result(
              boolType,
              tested
                ? { yes: new Map([[tested.key, !equal]]), no: new Map([[tested.key, equal]]) }
                : {},
            );
          } else if (op.operator === 'concat') {
            get(op.left, stringType);
            get(op.right, stringType);
            result(stringType);
          } else {
            get(op.left, numberType);
            get(op.right, numberType);
            result(
              ['lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual'].includes(
                op.operator,
              )
                ? boolType
                : numberType,
            );
          }
          break;
        }
        case 'numeric':
          if (op.args.length !== (['min', 'max', 'pow'].includes(op.builtin) ? 2 : 1))
            this.error('IR_TYPE', 'Numeric builtin argument count does not match.', q, op);
          op.args.forEach((arg: number) => get(arg, numberType));
          result(op.builtin.startsWith('is') ? boolType : numberType);
          break;
        case 'record':
          this.recordFields(op.fields, op.type, q, (f) => get(f.value).type);
          result(op.type);
          break;
        case 'field': {
          const value = get(op.value),
            t = value.type;
          const fieldType =
            t.kind === 'record' && !this.device ? op.type : this.field(t, op.field, q);
          result(fieldType, { key: `field:${value.key}:${op.field}` });
          break;
        }
        case 'bytes':
          op.elements.forEach((id: number) => get(id, numberType));
          result(bytesType);
          break;
        case 'length': {
          const t = get(op.value).type;
          if (!['string', 'bytes'].includes(t.kind))
            this.error('IR_TYPE', 'length requires string or bytes.', q, op);
          result(numberType);
          break;
        }
        case 'index': {
          const t = get(op.value).type;
          if (!['string', 'bytes'].includes(t.kind))
            this.error('IR_TYPE', 'index requires string or bytes.', q, op);
          get(op.index, numberType);
          result(t.kind === 'string' ? stringType : numberType);
          break;
        }
        case 'optional': {
          const t = get(op.value).type;
          if (t.kind === 'optional')
            this.error('IR_TYPE', 'Optional types cannot be nested.', q, op);
          const v = result({ kind: 'optional', inner: t });
          s.facts.set(v.key, true);
          break;
        }
        case 'isNone': {
          const v = get(op.value);
          if (v.type.kind !== 'optional')
            this.error('IR_TYPE', 'isNone requires an optional value.', q, op);
          result(boolType, { yes: new Map([[v.key, false]]), no: new Map([[v.key, true]]) });
          break;
        }
        case 'nonNull': {
          const v = get(op.value);
          if (v.type.kind !== 'optional' || s.facts.get(v.key) !== true)
            this.error('IR_TYPE', 'nonNull requires a dominating non-null proof.', q, op);
          result(v.type.inner);
          break;
        }
        case 'local': {
          if (c.localIds.has(op.local))
            this.error('IR_SCOPE', 'Duplicate local identifier.', q, op);
          c.localIds.add(op.local);
          this.type(op.type, [...q, 'type']);
          const info = get(op.initial, op.type);
          s.locals.set(op.local, { type: op.type, value: info });
          break;
        }
        case 'localRead': {
          const local = slot(op.local);
          result(local.type, { ...local.value });
          break;
        }
        case 'localWrite': {
          const local = slot(op.local);
          const info = get(op.value, local.type);
          s.locals.set(op.local, { type: local.type, value: info });
          break;
        }
        case 'write': {
          const d = this.declaration(op.name, 'state', q);
          get(op.value, d?.type);
          break;
        }
        case 'memoryLength':
          this.ref(op.memory, 'memory', c, q);
          result(numberType);
          break;
        case 'load8':
        case 'load16le':
        case 'load16be':
        case 'load32le':
        case 'load32be':
          this.ref(op.memory, 'memory', c, q);
          get(op.offset, numberType);
          result(numberType);
          break;
        case 'store8':
        case 'store16le':
        case 'store16be':
        case 'store32le':
        case 'store32be':
          this.ref(op.memory, 'memory', c, q);
          get(op.offset, numberType);
          get(op.value, numberType);
          break;
        case 'copyBytes':
          this.ref(op.memory, 'memory', c, q);
          get(op.offset, numberType);
          get(op.length, numberType);
          result(bytesType);
          break;
        case 'readSample':
          this.ref(op.pin, 'pin', c, q);
          result(sampleType);
          break;
        case 'resistor':
          this.ref(op.to, 'pin', c, q);
          get(op.resistance, numberType);
          result(intentType);
          break;
        case 'combineIntents':
          op.values.forEach((id: number) => get(id, intentType));
          result(intentType);
          break;
        case 'refEqual':
          this.expect(
            { kind: this.ref(op.left, undefined, c, q) },
            { kind: this.ref(op.right, undefined, c, q) },
            q,
          );
          result(boolType);
          break;
        case 'writeIntent':
          this.ref(op.pin, 'pin', c, q);
          get(op.value, intentType);
          break;
        case 'call':
        case 'callValue': {
          const target = this.declaration(op.name, 'function', q);
          if (target && op.pure && !target.pure)
            this.error('IR_EFFECT', 'A pure call must target an explicitly pure function.', q, op);
          if (target && op.args.length !== target.params.length)
            this.error('IR_TYPE', 'Call argument count does not match.', q, op);
          op.args.forEach((arg, index) => {
            const param = target?.params[index];
            if (arg.kind === 'value') {
              if (param && (param.type.kind === 'pin' || param.type.kind === 'memory'))
                this.error('IR_TYPE', 'Resource argument required.', q, op);
              get(arg.value, param?.type as VType | undefined);
            } else {
              if (param && !(param.type.kind === 'pin' || param.type.kind === 'memory'))
                this.error('IR_TYPE', 'Value argument required.', q, op);
              this.ref(arg, param?.type.kind, c, q);
            }
          });
          if (op.kind === 'callValue') {
            if (target && !target.returns)
              this.error('IR_TYPE', 'callValue requires a value-returning function.', q, op);
            result(target?.returns ?? op.type);
          } else if (target?.returns)
            this.error(
              'IR_TYPE',
              'call cannot discard the return type of a value-returning function.',
              q,
              op,
            );
          break;
        }
        case 'send': {
          const channel = this.declaration(op.channel, 'channel', q);
          if (channel?.direction === 'input')
            this.error('IR_REFERENCE', 'send requires an output channel.', q, op);
          get(op.value, channel?.type);
          break;
        }
        case 'notify': {
          const d = this.declaration(op.notification, 'notification', q);
          if (d?.direction === 'input')
            this.error('IR_REFERENCE', 'notify requires an output notification.', q, op);
          break;
        }
        case 'receive': {
          const channel = this.declaration(op.channel, 'channel', q);
          if (channel?.direction === 'output')
            this.error('IR_REFERENCE', 'receive requires an input channel.', q, op);
          result(channel?.type ?? op.type);
          break;
        }
        case 'now':
        case 'random':
          result(numberType);
          break;
        case 'if': {
          const condition = get(op.condition, boolType);
          const yes = child(op.yes, this.conditioned(s, condition, true), 'yes');
          const no = op.no
            ? child(op.no, this.conditioned(s, condition, false), 'no')
            : {
                normal: this.conditioned(s, condition, false),
                breaks: [],
                continues: [],
                yielded: [],
                yieldStates: [],
              };
          accumulate(yes);
          accumulate(no);
          state = merge([yes.normal, no.normal].filter((v): v is State => !!v));
          break;
        }
        case 'match': {
          const value = get(op.value),
            base = inner(value.type);
          const seen = new Set<string>();
          const branches: State[] = [];
          for (let j = 0; j < op.arms.length; j++) {
            const arm = op.arms[j]!,
              pattern = arm.pattern;
            this.constant(pattern, pattern.kind === 'none' ? value.type : base, [
              ...q,
              'arms',
              j,
              'pattern',
            ]);
            const key =
              pattern.kind === 'enum'
                ? `${pattern.name}.${pattern.member}`
                : `${pattern.kind}:${String('value' in pattern ? pattern.value : undefined)}`;
            if (seen.has(key))
              this.error('IR_CONTROL_FLOW', 'Duplicate match pattern.', [...q, 'arms', j]);
            seen.add(key);
            const branch = copy(s);
            if (value.type.kind === 'optional')
              branch.facts.set(value.key, pattern.kind !== 'none');
            const f = lexical(
              this.region(
                arm.body,
                { ...c, tail: c.tail && i === body.operations.length - 1 },
                branch,
                [...q, 'arms', j, 'body'],
              ),
              branch.locals,
            );
            accumulate(f);
            if (f.normal) branches.push(f.normal);
          }
          const exhaustive =
            base.kind === 'bool'
              ? seen.has('bool:true') && seen.has('bool:false')
              : base.kind === 'enum'
                ? this.enums.get(base.name)?.every((m) => seen.has(`${base.name}.${m}`))
                : false;
          const complete =
            exhaustive && (value.type.kind !== 'optional' || seen.has('none:undefined'));
          if (op.otherwise) {
            const branch = copy(s);
            if (value.type.kind === 'optional' && seen.has('none:undefined'))
              branch.facts.set(value.key, true);
            const f = child(op.otherwise, branch, 'otherwise');
            accumulate(f);
            if (f.normal) branches.push(f.normal);
          } else if (!complete)
            this.error(
              'IR_CONTROL_FLOW',
              'Match requires exhaustive patterns or a default region.',
              q,
              op,
            );
          state = merge(branches);
          break;
        }
        case 'while':
        case 'loop': {
          const written = new Set<number>();
          walk(op.body, (nested) => {
            if (nested.kind === 'localWrite' && s.locals.has(nested.local))
              written.add(nested.local);
          });
          if (op.kind === 'while')
            walk(op.test.body, (nested) => {
              if (nested.kind === 'localWrite' && s.locals.has(nested.local))
                written.add(nested.local);
            });
          // Loop-carried slots get independent phi identities. Body result IDs denote
          // fresh snapshots on each iteration and must never carry proofs backwards.
          const header = (backedges: State[]): State => {
            const next = copy(s),
              incoming = [s, ...backedges];
            for (const id of written) {
              const slot = s.locals.get(id)!;
              const value: Info = { type: slot.type, key: `loop:${q.join('.')}:${id}` };
              next.locals.set(id, { type: slot.type, value });
              const facts = incoming.map((state) => {
                const v = state.locals.get(id)?.value;
                return v ? state.facts.get(v.key) : undefined;
              });
              if (facts.every((fact) => fact === true)) next.facts.set(value.key, true);
              else if (facts.every((fact) => fact === false)) next.facts.set(value.key, false);
            }
            return next;
          };
          let loopState = header([]);
          const resultIds = new Set(c.resultIds),
            localIds = new Set(c.localIds);
          let test: ReturnType<typeof valueRegion> | undefined;
          let f: Flow;
          for (;;) {
            c.resultIds.clear();
            for (const id of resultIds) c.resultIds.add(id);
            c.localIds.clear();
            for (const id of localIds) c.localIds.add(id);
            test =
              op.kind === 'while' ? valueRegion(op.test, boolType, loopState, 'test') : undefined;
            const afterTest = test ? (merge(test.flow.yieldStates) ?? loopState) : loopState;
            const entry = test?.value ? this.conditioned(afterTest, test.value, true) : afterTest;
            f = child(op.body, entry, 'body', { loop: c.loop + 1, tail: false });
            const backedges = [f.normal, ...f.continues].filter((value): value is State => !!value);
            const next = header(backedges);
            const stable = [...written].every((id) => {
              const key = next.locals.get(id)!.value.key;
              return next.facts.get(key) === loopState.facts.get(key);
            });
            if (stable) break;
            loopState = next;
          }
          flow.yielded.push(...f.yielded);
          flow.yieldStates.push(...f.yieldStates);
          const exits = [...f.breaks];
          if (op.kind === 'while' && test?.value) {
            const afterTest = merge(test.flow.yieldStates) ?? loopState;
            exits.push(this.conditioned(afterTest, test.value, false));
          }
          state = merge(exits);
          break;
        }
        case 'and':
        case 'or': {
          const left = get(op.left, boolType),
            isAnd = op.kind === 'and';
          const right = valueRegion(op.right, boolType, this.conditioned(s, left, isAnd), 'right');
          const rightInfo = right.value;
          const combine = (a?: Facts, b?: Facts): Facts => new Map([...(a ?? []), ...(b ?? [])]);
          const yes = isAnd
            ? combine(left.yes, rightInfo?.yes)
            : intersect([left.yes ?? new Map(), combine(left.no, rightInfo?.yes)]);
          const no = isAnd
            ? intersect([left.no ?? new Map(), combine(left.yes, rightInfo?.no)])
            : combine(left.no, rightInfo?.no);
          result(boolType, { yes, no });
          state = merge([this.conditioned(s, left, !isAnd), ...right.flow.yieldStates]);
          break;
        }
        case 'select': {
          const condition = get(op.condition, boolType);
          const yes = valueRegion(op.yes, op.type, this.conditioned(s, condition, true), 'yes');
          const no = valueRegion(op.no, op.type, this.conditioned(s, condition, false), 'no');
          result(op.type);
          state = merge([...yes.flow.yieldStates, ...no.flow.yieldStates]);
          break;
        }
        case 'assert': {
          const condition = get(op.condition, boolType);
          if (op.message)
            valueRegion(op.message, stringType, this.conditioned(s, condition, false), 'message');
          state = this.conditioned(s, condition, true);
          break;
        }
        case 'wait':
          if (c.valueRegion || c.mode !== 'process')
            this.error('IR_EFFECT', 'wait is only allowed in a process statement region.', q, op);
          get(op.duration, numberType);
          break;
        case 'elapse':
          if (c.valueRegion || c.mode !== 'jit')
            this.error('IR_EFFECT', 'elapse is only allowed in a JIT statement region.', q, op);
          get(op.duration, numberType);
          break;
        case 'waitUntil':
          if (c.mode !== 'jit')
            this.error('IR_EFFECT', 'waitUntil requires a JIT instruction.', q, op);
          if (
            c.valueRegion ||
            c.loop ||
            !c.tail ||
            i !== body.operations.length - 1 ||
            !c.finalInstruction
          )
            this.error(
              'IR_JIT_BOUNDARY',
              'waitUntil must be on the final instruction tail path.',
              q,
              op,
            );
          {
            const fn = this.declaration(op.predicate, 'function', q);
            if (fn && (!fn.pure || fn.params.length || !sameType(fn.returns, boolType)))
              this.error(
                'IR_TYPE',
                'waitUntil requires a zero-parameter pure bool function.',
                q,
                op,
              );
          }
          state = undefined;
          break;
        case 'redirect':
          if (!['jit', 'sync'].includes(c.mode))
            this.error('IR_EFFECT', 'redirect is not permitted in this context.', q, op);
          get(op.target, numberType);
          get(op.delay, numberType);
          state = undefined;
          break;
        case 'stop':
          if (c.mode !== 'jit' || c.valueRegion)
            this.error('IR_EFFECT', 'stop requires a JIT statement region.', q, op);
          state = undefined;
          break;
        case 'return':
          if (
            c.valueRegion ||
            c.returns ||
            c.mode === 'jit' ||
            c.computation ||
            c.mode === 'creation' ||
            c.mode === 'initial'
          )
            this.error('IR_CONTROL_FLOW', 'Void return is not valid in this body.', q, op);
          state = undefined;
          break;
        case 'returnValue':
          if (c.valueRegion || !c.returns)
            this.error('IR_CONTROL_FLOW', 'returnValue is not valid in this body.', q, op);
          get(op.value, c.returns);
          state = undefined;
          break;
        case 'yield':
          if (!c.valueRegion)
            this.error('IR_CONTROL_FLOW', 'yield requires a value region.', q, op);
          {
            const value = get(op.value, c.valueRegion);
            flow.yielded.push(value);
            flow.yieldStates.push(s);
          }
          state = undefined;
          break;
        case 'break':
        case 'continue':
          if (!c.loop)
            this.error(
              'IR_CONTROL_FLOW',
              `${op.kind} requires an enclosing loop in this region.`,
              q,
              op,
            );
          (op.kind === 'break' ? flow.breaks : flow.continues).push(s);
          state = undefined;
          break;
      }
    }
    if (state) flow.normal = state;
    return flow;
  }
  effects(body: RegionIR, mode: Mode, path: InputPath): void {
    walk(
      body,
      (op, p) => {
        const pure = ['creation', 'initial', 'pure'].includes(mode),
          creation = ['creation', 'initial'].includes(mode);
        const effect = [
          'write',
          'writeIntent',
          'send',
          'notify',
          'now',
          'random',
          'wait',
          'receive',
          'elapse',
          'waitUntil',
          'stop',
          'redirect',
          ...stores,
        ].includes(op.kind);
        if (pure && effect)
          this.error('IR_EFFECT', `${op.kind} is not allowed in ${mode} code.`, p, op);
        if (
          creation &&
          ((op.kind === 'read' && !['property', 'const'].includes(op.resource)) ||
            ['readSample', 'memoryLength', 'copyBytes', ...loads].includes(op.kind))
        )
          this.error('IR_EFFECT', 'Creation computations cannot read runtime resources.', p, op);
        if (
          mode === 'creation' &&
          (['resistor', 'combineIntents', 'refEqual'].includes(op.kind) ||
            ((op.kind === 'call' || op.kind === 'callValue') &&
              op.args.some((a) => a.kind !== 'value')))
        )
          this.error(
            'IR_EFFECT',
            'Ordinary creation computations cannot use resource references or intents.',
            p,
            op,
          );
        if (['reaction', 'process'].includes(mode) && op.kind === 'redirect')
          this.error('IR_EFFECT', 'Control redirection requires a bound JIT entry.', p, op);
        if (
          ['sync', 'reaction', 'pure'].includes(mode) &&
          ['wait', 'receive', 'elapse', 'waitUntil', 'stop'].includes(op.kind)
        )
          this.error('IR_EFFECT', 'Synchronous code cannot suspend or use JIT control.', p, op);
        if (mode === 'process' && ['elapse', 'waitUntil', 'stop'].includes(op.kind))
          this.error('IR_EFFECT', 'Process code cannot use JIT control.', p, op);
        if (mode === 'jit' && ['wait', 'receive'].includes(op.kind))
          this.error('IR_EFFECT', 'JIT code cannot use process suspension.', p, op);
        if (op.kind === 'call' || op.kind === 'callValue' || op.kind === 'waitUntil') {
          const name = op.kind === 'waitUntil' ? op.predicate : op.name;
          const fn = this.functions.get(name);
          if (fn && pure && !fn.pure)
            this.error(
              'IR_EFFECT',
              'Pure contexts can only call explicitly pure functions.',
              p,
              op,
            );
          if (fn) {
            const key = `${mode}:${name}`;
            if (!this.effectChecked.has(key)) {
              this.effectChecked.add(key);
              this.effects(fn.body, mode, [...(this.paths.get(name) ?? []), 'body']);
            }
          }
        }
      },
      path,
    );
  }
  source(path: readonly string[], p: InputPath, notification: boolean): VType | undefined {
    if (!path.length) this.error('IR_SCHEMA', 'An observation source path cannot be empty.', p);
    const declaration = this.declarations.get(path[0]!);
    if (!declaration) this.error('IR_REFERENCE', 'Observation source does not exist.', p);
    let type: VType;
    let start = 1;
    if (declaration.kind === 'notification' && notification) {
      if (declaration.direction !== 'input' || path.length !== 1)
        this.error('IR_REFERENCE', 'Only input notifications can trigger a process.', p);
      return undefined;
    }
    if (declaration.kind === 'pin') {
      if (path[1] !== 'sample')
        this.error('IR_REFERENCE', 'Pin observation must select sample.', p);
      type = sampleType;
      start = 2;
    } else if (declaration.kind === 'state' || declaration.kind === 'derived')
      type = declaration.type;
    else
      this.error(
        'IR_REFERENCE',
        'An observation source must be state, derived, pin.sample or an input notification.',
        p,
      );
    for (let i = start; i < path.length; i++) type = this.field(type, path[i]!, [...p, i]);
    if (!comparable(type)) this.error('IR_TYPE', 'Observation sources must be comparable.', p);
    return type;
  }
  cycle(graph: Map<string, Set<string>>, label: string): void {
    const active = new Set<string>(),
      done = new Set<string>();
    const visit = (name: string): void => {
      if (active.has(name))
        this.error(
          'IR_DEPENDENCY',
          `${label} dependency cycle includes ${name}.`,
          this.paths.get(name) ?? [],
        );
      if (done.has(name)) return;
      active.add(name);
      for (const next of graph.get(name) ?? []) if (graph.has(next)) visit(next);
      active.delete(name);
      done.add(name);
    };
    for (const key of graph.keys()) visit(key);
  }
  dependencies(
    body: RegionIR,
    resources: readonly string[],
    seen = new Set<string>(),
  ): Set<string> {
    const deps = new Set<string>();
    walk(body, (op) => {
      if (op.kind === 'read' && resources.includes(op.resource)) deps.add(op.name);
      if ((op.kind === 'call' || op.kind === 'callValue') && !seen.has(op.name)) {
        seen.add(op.name);
        const fn = this.functions.get(op.name);
        if (fn) for (const name of this.dependencies(fn.body, resources, seen)) deps.add(name);
      }
    });
    return deps;
  }
  validateDevice(): void {
    const graph = new Map<string, Set<string>>();
    for (const [name, fn] of this.functions) {
      const targets = new Set<string>();
      walk(fn.body, (op) => {
        if (op.kind === 'call' || op.kind === 'callValue') targets.add(op.name);
      });
      graph.set(name, targets);
    }
    this.cycle(graph, 'Synchronous call');
    const creationGraph = new Map<string, Set<string>>(),
      derivedGraph = new Map<string, Set<string>>();
    this.device!.declarations.forEach((d, i) => {
      const p: InputPath = ['declarations', i];
      if ('type' in d && d.type) this.type(d.type, [...p, 'type']);
      if (d.kind === 'property' || d.kind === 'const' || d.kind === 'state') {
        const base = inner(d.type);
        if (
          ['sample', 'intent'].includes(base.kind) ||
          (d.kind === 'property' && base.kind === 'record')
        )
          this.error(
            'IR_TYPE',
            'Type is not valid at this declaration position.',
            [...p, 'type'],
            d,
          );
        const key = d.kind === 'property' ? 'default' : d.kind === 'const' ? 'value' : 'initial';
        const initialization =
          d.kind === 'property' ? d.default : d.kind === 'const' ? d.value : d.initial;
        if (initialization) {
          this.computation(initialization, d.type, 'creation', [...p, key]);
          creationGraph.set(d.name, this.dependencies(initialization.body, ['property', 'const']));
        }
      } else if (d.kind === 'derived') {
        this.computation(d.value, d.type, 'pure', [...p, 'value']);
        derivedGraph.set(d.name, this.dependencies(d.value.body, ['derived']));
      } else if (d.kind === 'pin') {
        for (const key of ['low', 'high'] as const)
          if (d[key]) this.computation(d[key], numberType, 'creation', [...p, key]);
        if (d.initial) this.computation(d.initial, intentType, 'initial', [...p, 'initial']);
      } else if (d.kind === 'memory')
        this.computation(d.length, numberType, 'creation', [...p, 'length']);
      else if (d.kind === 'channel') {
        if (!['number', 'bool', 'record', 'bytes'].includes(d.type.kind))
          this.error('IR_TYPE', 'Invalid channel payload type.', [...p, 'type'], d);
        if ((d.type.kind === 'bytes') !== !!d.maxLength)
          this.error('IR_TYPE', 'Only bytes channels require maxLength.', p, d);
        this.computation(d.capacity, numberType, 'creation', [...p, 'capacity']);
        if (d.maxLength) this.computation(d.maxLength, numberType, 'creation', [...p, 'maxLength']);
        if (d.overflow)
          this.computation(d.overflow, { kind: 'enum', name: 'Overflow' }, 'creation', [
            ...p,
            'overflow',
          ]);
      } else if (d.kind === 'function') {
        this.uniqueNames(
          d.params.map((param) => param.name),
          [...p, 'params'],
        );
        d.params.forEach((param, j) => {
          if (this.declarations.has(param.name))
            this.error('IR_REFERENCE', 'A parameter cannot shadow a device member.', [
              ...p,
              'params',
              j,
            ]);
          if (!(param.type.kind === 'pin' || param.type.kind === 'memory'))
            this.type(param.type as VType, [...p, 'params', j, 'type']);
        });
        if (d.returns) this.type(d.returns, [...p, 'returns']);
        const c = this.context(d.pure ? 'pure' : 'sync', d.returns);
        c.params = d.params;
        this.body(d.body, c, [...p, 'body']);
      } else if (d.kind === 'start' || d.kind === 'on') {
        if (d.kind === 'on') this.source(d.sourcePath, [...p, 'sourcePath'], true);
        this.body(d.body, this.context('process'), [...p, 'body']);
        walk(d.body, (op) => {
          if (op.kind === 'receive') {
            const owner = `${i}`;
            const old = this.receiveOwners.get(op.channel);
            if (old && old !== owner) {
              const error = new BuildError([
                {
                  code: 'IR_REFERENCE',
                  message: 'An input channel cannot have multiple consumer processes.',
                  phase: 'finalize',
                  path: p,
                  related: [],
                },
              ]);
              Object.defineProperty(error, 'code', { value: 'CHANNEL_CONSUMER_CONFLICT' });
              throw error;
            }
            this.receiveOwners.set(op.channel, owner);
          }
        });
      } else if (d.kind === 'reaction') {
        const source = this.source(d.sourcePath, [...p, 'sourcePath'], false);
        this.expect(d.sourceType, source, [...p, 'sourceType']);
        this.type(d.sourceType, [...p, 'sourceType']);
        const names = [d.previous, d.current, ...d.captures.map((capture) => capture.name)];
        d.captures.forEach((capture, j) => {
          if (!comparable(capture.value.type))
            this.error('IR_TYPE', 'Capture results must be comparable.', [...p, 'captures', j]);
          this.computation(capture.value, capture.value.type, 'pure', [
            ...p,
            'captures',
            j,
            'value',
          ]);
        });
        const c = this.context('reaction');
        c.reaction = d;
        this.body(d.body, c, [...p, 'body']);
        this.uniqueNames(names, p);
        for (const name of names)
          if (this.declarations.has(name))
            this.error('IR_REFERENCE', 'Reaction bindings cannot shadow device members.', p);
      } else if (d.kind === 'assert') this.body(d.body, this.context('creation'), [...p, 'body']);
    });
    this.cycle(creationGraph, 'Creation');
    this.cycle(derivedGraph, 'Derived');
  }
  validateBlock(block: BlockIR): void {
    block.instructions.forEach((instruction, i) => {
      const c = this.context('jit');
      c.finalInstruction = i === block.instructions.length - 1;
      this.body(instruction.body, c, ['instructions', i, 'body']);
    });
  }
}
function locateError(error: unknown, input: unknown): never {
  if (!(error instanceof BuildError)) throw error;
  const diagnostics = error.diagnostics.map((diagnostic) => {
    if (diagnostic.source) return diagnostic;
    let node: unknown = input,
      source;
    const consider = (): void => {
      const candidate = (node as Located | null | undefined)?.source;
      if (
        candidate &&
        typeof candidate === 'object' &&
        ((typeof candidate.label === 'string' &&
          candidate.uri === undefined &&
          candidate.range === undefined) ||
          (typeof candidate.uri === 'string' &&
            candidate.range?.start?.line >= 1 &&
            candidate.range?.start?.column >= 1 &&
            candidate.range?.end?.line >= 1 &&
            candidate.range?.end?.column >= 1))
      )
        source = candidate;
    };
    consider();
    for (const part of diagnostic.path) {
      node = (node as Record<string | number, unknown> | null | undefined)?.[part];
      consider();
    }
    return source ? { ...diagnostic, source } : diagnostic;
  });
  const located = new BuildError(diagnostics as [Diagnostic, ...Diagnostic[]]);
  const runtimeCode = Object.getOwnPropertyDescriptor(error, 'code');
  if (runtimeCode?.value === 'CHANNEL_CONSUMER_CONFLICT')
    Object.defineProperty(located, 'code', runtimeCode);
  throw located;
}
const validatedDevices = new WeakSet<DeviceIR>();
const validatedBlocks = new WeakSet<BlockIR>();
const boundBlocks = new WeakMap<BlockIR, WeakSet<DeviceIR>>();

export function validateDeviceIR(input: unknown): DeviceIR {
  if (typeof input === 'object' && input !== null && validatedDevices.has(input as DeviceIR))
    return input as DeviceIR;
  const captured = snapshot(input);
  try {
    deviceSchema(captured);
    new Validator(captured).validateDevice();
    const result = captured as unknown as DeviceIR;
    validatedDevices.add(result);
    return result;
  } catch (error) {
    return locateError(error, captured);
  }
}
export function validateBlockIR(input: unknown): BlockIR {
  if (typeof input === 'object' && input !== null && validatedBlocks.has(input as BlockIR))
    return input as BlockIR;
  const captured = snapshot(input);
  try {
    blockSchema(captured);
    new Validator().validateBlock(captured);
    const result = captured as unknown as BlockIR;
    validatedBlocks.add(result);
    return result;
  } catch (error) {
    return locateError(error, captured);
  }
}
/** Adds instance-definition reference and function-signature checks to a structurally valid block. */
export function validateBoundBlockIR(input: unknown, device: DeviceIR): BlockIR {
  try {
    const captured = validateBlockIR(input);
    const definition = validateDeviceIR(device);
    if (boundBlocks.get(captured)?.has(definition)) return captured;
    new Validator(definition).validateBlock(captured);
    let definitions = boundBlocks.get(captured);
    if (!definitions) {
      definitions = new WeakSet<DeviceIR>();
      boundBlocks.set(captured, definitions);
    }
    definitions.add(definition);
    return captured;
  } catch (error) {
    if (error instanceof BuildError) {
      const bound = new BuildError(
        error.diagnostics.map((d) => ({ ...d, phase: 'bind' as DiagnosticPhase })) as [
          Diagnostic,
          ...Diagnostic[],
        ],
      );
      const runtimeCode = Object.getOwnPropertyDescriptor(error, 'code');
      if (runtimeCode?.value === 'CHANNEL_CONSUMER_CONFLICT')
        Object.defineProperty(bound, 'code', runtimeCode);
      throw bound;
    }
    throw error;
  }
}
