import type {
  DeviceBuilder,
  JitBlockBuilder,
  NamedOptions,
  InstructionBoundary,
  Parameter,
  ReactionCapture,
  TypeFactory,
} from './builder-types.js';
import type {
  ComputationIR,
  ConstantIR,
  DeclarationIR,
  Diagnostic,
  InstructionIR,
  MemoryRefIR,
  OperationIR,
  ParameterIR,
  PinRefIR,
  RegionIR,
  DeviceIR,
  DiagnosticCode,
  InputPath,
  SourceInfo,
  ValueTypeIR,
} from './ir.js';
import { BuildError, fail, snapshot } from './errors.js';
import { builtins, binary, loads, numeric, operation, stores, unary } from './schema.js';
import type { Node } from './schema.js';
import { sameType, validateBlockIR, validateBoundBlockIR, validateDeviceIR } from './validation.js';

type Mode = 'creation' | 'initial' | 'pure' | 'sync' | 'process' | 'reaction' | 'jit';
type BodyView = Record<string, (...args: unknown[]) => unknown> & {
  returnValue(value: unknown): void;
};
type BodyEmitter = (body: BodyView) => unknown;
interface RuntimeOptions extends NamedOptions {
  readonly [key: string]: unknown;
  readonly type: object;
  readonly fields: Readonly<Record<string, object>>;
  readonly members: readonly string[];
  readonly params: readonly Parameter[];
  readonly captures: readonly ReactionCapture[];
  readonly returns: object;
  readonly sourceType: object;
  readonly sourcePath: readonly string[];
}
interface PendingNode extends Record<string, unknown> {
  kind: string;
  result: number;
  type: ValueTypeIR;
  constant?: ConstantIR;
  value?: number;
  source?: SourceInfo;
}
interface RuntimeReactionBindings {
  previous: object;
  current: object;
  captures: Record<string, object>;
}
interface TypeData {
  type: ValueTypeIR;
  owner?: Root;
  fields?: Readonly<Record<string, object>>;
  members?: readonly string[];
}
interface Scope {
  parent?: Scope;
}
interface Space {
  result: number;
  local: number;
}
interface Handle {
  root: Root;
  scope: Scope;
  space: Space;
  type: ValueTypeIR;
  id: number;
  yes?: Map<Handle, boolean>;
  no?: Map<Handle, boolean>;
  none?: boolean;
  alias?: Handle | undefined;
  fields?: Map<string, Handle>;
}
interface LocalHandle {
  root: Root;
  scope: Scope;
  space: Space;
  type: ValueTypeIR;
  id: number;
}
interface RefHandle {
  root: Root;
  scope: Scope;
  space: Space;
  ref: PinRefIR | MemoryRefIR;
}
const typeData = new WeakMap<object, TypeData>();
const values = new WeakMap<object, Handle>();
const locals = new WeakMap<object, LocalHandle>();
const refs = new WeakMap<object, RefHandle>();
const enumValues = new WeakMap<object, { name: string; member: string; owner?: Root }>();
const primitive = (kind: string): object => {
  const descriptor = Object.freeze({});
  typeData.set(descriptor, { type: { kind } as ValueTypeIR });
  return descriptor;
};
function enumType(name: string, members: readonly string[], owner?: Root): object {
  const membersObject: Record<string, object> = {};
  for (const member of members) {
    const token = Object.freeze({});
    enumValues.set(token, { name, member, ...(owner ? { owner } : {}) });
    Object.defineProperty(membersObject, member, { value: token, enumerable: true });
  }
  const descriptor = Object.freeze({ name, members: Object.freeze(membersObject) });
  typeData.set(descriptor, {
    type: { kind: 'enum', name },
    members: Object.freeze([...members]),
    ...(owner ? { owner } : {}),
  });
  return descriptor;
}
function recordType(name: string, fields: Readonly<Record<string, object>>, owner?: Root): object {
  const descriptor = Object.freeze({ name, fields: Object.freeze({ ...fields }) });
  typeData.set(descriptor, {
    type: { kind: 'record', name },
    fields: descriptor.fields,
    ...(owner ? { owner } : {}),
  });
  return descriptor;
}
const factory = {
  number: primitive('number'),
  bool: primitive('bool'),
  string: primitive('string'),
  bytes: primitive('bytes'),
  intent: primitive('intent'),
  sample: primitive('sample'),
  pin: Object.freeze({ kind: 'pin' }),
  memory: Object.freeze({ kind: 'memory' }),
  logic: enumType('Logic', builtins.Logic!),
  sampleStatus: enumType('SampleStatus', builtins.SampleStatus!),
  overflow: enumType('Overflow', builtins.Overflow!),
  optional(descriptor: object): object {
    const info = typeData.get(descriptor as object);
    if (!info || info.type.kind === 'optional')
      fail('IR_TYPE', 'optional requires a nonoptional value type.', [], 'construct');
    const result = Object.freeze({});
    typeData.set(result, { ...info, type: { kind: 'optional', inner: info.type } });
    return result;
  },
  namedEnum(name: string, members: readonly string[]): object {
    if (
      typeof name !== 'string' ||
      !Array.isArray(members) ||
      !members.length ||
      members.some((m) => typeof m !== 'string') ||
      new Set(members).size !== members.length
    )
      fail('IR_TYPE', 'Invalid named enum description.', [], 'construct');
    return enumType(name, members);
  },
  namedRecord(name: string, fields: Readonly<Record<string, object>>): object {
    if (typeof name !== 'string' || !fields || typeof fields !== 'object' || Array.isArray(fields))
      fail('IR_TYPE', 'Invalid named record description.', [], 'construct');
    for (const field of Object.values(fields))
      if (!['number', 'bool'].includes(typeData.get(field)?.type.kind ?? ''))
        fail('IR_TYPE', 'Record fields must be number or bool types.', [], 'construct');
    return recordType(name, fields);
  },
};
export const types: TypeFactory = Object.freeze(factory) as unknown as TypeFactory;
const n: ValueTypeIR = { kind: 'number' },
  b: ValueTypeIR = { kind: 'bool' },
  str: ValueTypeIR = { kind: 'string' },
  bytes: ValueTypeIR = { kind: 'bytes' },
  intent: ValueTypeIR = { kind: 'intent' },
  sample: ValueTypeIR = { kind: 'sample' };
function descendant(scope: Scope, parent: Scope): boolean {
  for (let s: Scope | undefined = scope; s; s = s.parent) if (s === parent) return true;
  return false;
}
function infoOf(value: unknown): Handle | undefined {
  return typeof value === 'object' && value !== null ? values.get(value) : undefined;
}
function enumOf(value: unknown): { name: string; member: string; owner?: Root } | undefined {
  return typeof value === 'object' && value !== null ? enumValues.get(value) : undefined;
}
function referenceOf(value: unknown): RefHandle | undefined {
  return typeof value === 'object' && value !== null ? refs.get(value) : undefined;
}
function fresh<T extends object>(map: WeakMap<object, T>, info: T): object {
  const handle = Object.freeze({});
  map.set(handle, info);
  return handle;
}
function alias(value: Handle): Handle {
  return value.alias ? alias(value.alias) : value;
}
function joinFacts(branches: Map<Handle, boolean>[]): Map<Handle, boolean> {
  const result = new Map(branches[0]);
  for (const [k, v] of result) if (branches.some((f) => f.get(k) !== v)) result.delete(k);
  return result;
}
interface Pending {
  node: PendingNode;
  call: string;
  index: number;
  value: unknown;
  body: Body;
  requiresSignature: boolean;
}
const definitionOwners = new WeakMap<DeviceIR, Root>();
class Root {
  closed = false;
  active: Body | undefined;
  source: SourceInfo | undefined;
  readonly declarations: DeclarationIR[] = [];
  readonly names = new Map<string, DeclarationIR>();
  readonly expectedTypes = new Set<TypeData>();
  readonly pending: Pending[] = [];
  readonly instructions: InstructionIR[] = [];
  constructor(
    readonly options: NamedOptions,
    readonly device?: DeviceIR,
    readonly jit = false,
  ) {
    if (options.source !== undefined) this.source = snapshot(options.source);
  }
  error(code: DiagnosticCode, message: string, path: InputPath = []): never {
    this.closed = true;
    return fail(code, message, path, 'construct', this.active?.source ?? this.source);
  }
  check(): void {
    if (this.closed) this.error('IR_LIFECYCLE', 'This Builder is closed.');
  }
  guard<T>(action: () => T): T {
    this.check();
    try {
      return action();
    } catch (error) {
      this.closed = true;
      if (error instanceof BuildError && error.diagnostics.some((d) => d.phase !== 'construct'))
        throw new BuildError(
          error.diagnostics.map((d) => ({ ...d, phase: 'construct' as const })) as [
            Diagnostic,
            ...Diagnostic[],
          ],
        );
      throw error;
    }
  }
  type(descriptor: unknown): ValueTypeIR {
    const info = typeData.get(descriptor as object);
    if (!info) this.error('IR_TYPE', 'Expected a Builder type descriptor.');
    if (
      info.owner &&
      info.owner !== this &&
      (!this.device || definitionOwners.get(this.device) !== info.owner)
    )
      this.error('IR_SCOPE', 'Named type belongs to another device definition.');
    this.expectedTypes.add(info);
    if (info.fields) for (const f of Object.values(info.fields)) this.type(f);
    return info.type;
  }
  sourceFor(options?: { readonly source?: SourceInfo }): { source?: SourceInfo } {
    const source = options?.source ?? this.source;
    return source === undefined ? {} : { source: snapshot(source) };
  }
  body(
    mode: Mode,
    emit: unknown,
    returns?: ValueTypeIR,
    source?: SourceInfo,
    setup?: (body: Body) => unknown,
  ): RegionIR {
    const body = new Body(this, mode, { result: 0, local: 0 }, {}, undefined, returns);
    body.source = source === undefined ? this.source : snapshot(source);
    const previous = this.active;
    this.active = body;
    try {
      setup?.(body);
      (emit as BodyEmitter)(body.view());
    } finally {
      body.closed = true;
      this.active = previous;
    }
    this.check();
    return {
      operations: body.operations,
      ...(body.source ? { source: snapshot(body.source) } : {}),
    };
  }
  creation(
    type: ValueTypeIR,
    input: unknown,
    mode: Mode = 'creation',
    source?: SourceInfo,
  ): ComputationIR {
    const body = this.body(
      mode,
      (view: BodyView) => {
        if (typeof input === 'function') input(view);
        else view.returnValue(input);
      },
      type,
      source,
    );
    return { type, body };
  }
  declarationType(name: unknown): ValueTypeIR | undefined {
    const declaration = this.names.get(name as string);
    return declaration && 'type' in declaration ? declaration.type : undefined;
  }
  add(declaration: Node): void {
    if (declaration.name !== undefined) {
      if (this.names.has(declaration.name as string))
        this.error('IR_REFERENCE', `Duplicate declaration ${declaration.name}.`);
      this.names.set(declaration.name as string, declaration as unknown as DeclarationIR);
    }
    if (declaration.kind === 'start' && this.declarations.some((d) => d.kind === 'start'))
      this.error('IR_REFERENCE', 'Only one start process is allowed.');
    this.declarations.push(declaration as unknown as DeclarationIR);
  }
  resolve(): void {
    for (const pending of this.pending) {
      const fn = this.names.get(pending.call);
      if (!fn || fn.kind !== 'function') {
        if (this.jit && pending.requiresSignature)
          fail(
            'IR_TYPE',
            'A null or record call argument requires a bound function signature or an explicitly typed Value.',
          );
        continue;
      }
      const parameter = fn.params[pending.index];
      if (!parameter || parameter.type.kind === 'pin' || parameter.type.kind === 'memory')
        this.error('IR_TYPE', 'A value argument requires a value parameter.');
      const optionalLift = parameter.type.kind === 'optional' && pending.value !== null;
      if (optionalLift) {
        const data = pending.body.constantData(parameter.type.inner, pending.value);
        const id = pending.body.space.result++;
        const constant = {
          kind: 'constant',
          result: id,
          type: parameter.type.inner,
          constant: data,
          ...(pending.node.source ? { source: pending.node.source } : {}),
        };
        const insert = (value: unknown): boolean => {
          if (Array.isArray(value)) {
            const index = value.indexOf(pending.node);
            if (index >= 0) {
              value.splice(index, 0, constant);
              return true;
            }
            return value.some(insert);
          }
          return value !== null && typeof value === 'object' && Object.values(value).some(insert);
        };
        if (!insert(this.jit ? this.instructions : this.declarations))
          fail('IR_SCHEMA', 'Pending call argument is not part of this definition.');
        delete pending.node.constant;
        Object.assign(pending.node, { kind: 'optional', type: parameter.type, value: id });
      } else {
        const data = pending.body.constantData(parameter.type as ValueTypeIR, pending.value);
        Object.assign(pending.node, { type: parameter.type, constant: data });
      }
    }
    for (const description of this.expectedTypes) {
      const type = description.type.kind === 'optional' ? description.type.inner : description.type;
      if (!['enum', 'record'].includes(type.kind)) continue;
      const name = (type as { name: string }).name;
      const declaration = this.names.get(name);
      if (builtins[name] && type.kind === 'enum') {
        if (
          description.members &&
          (description.members.length !== builtins[name]!.length ||
            description.members.some((m, i) => m !== builtins[name]![i]))
        )
          fail('IR_TYPE', 'Builtin enum description does not match its members.');
        continue;
      }
      if (!declaration) continue;
      if (declaration.kind !== type.kind)
        fail('IR_REFERENCE', 'Named type category does not match its declaration.');
      if (
        description.members &&
        (description.members.length !==
          (declaration as Extract<DeclarationIR, { kind: 'enum' }>).members.length ||
          description.members.some(
            (m, i) => m !== (declaration as Extract<DeclarationIR, { kind: 'enum' }>).members[i],
          ))
      )
        fail('IR_TYPE', 'Forward enum description does not match its declaration.');
      if (description.fields) {
        const expected = Object.entries(description.fields);
        if (
          expected.length !==
            (declaration as Extract<DeclarationIR, { kind: 'record' }>).fields.length ||
          expected.some(
            ([name, t]) =>
              !(declaration as Extract<DeclarationIR, { kind: 'record' }>).fields.some(
                (field) => field.name === name && field.type === typeData.get(t)?.type.kind,
              ),
          )
        )
          fail('IR_TYPE', 'Forward record description does not match its declaration.');
      }
    }
  }
}
class Body {
  closed = false;
  ended = false;
  endedByWaitUntil = false;
  source: SourceInfo | undefined;
  readonly operations: OperationIR[] = [];
  facts = new Map<Handle, boolean>();
  localValues = new Map<LocalHandle, Handle>();
  loop = 0;
  calculate = false;
  yielded = false;
  constructor(
    readonly root: Root,
    readonly mode: Mode,
    readonly space: Space,
    readonly scope: Scope,
    readonly parent?: Body,
    readonly returns?: ValueTypeIR,
  ) {}
  view(): BodyView {
    return new Proxy(Object.create(null), {
      get: (_target, key) =>
        typeof key === 'string'
          ? (...args: unknown[]) =>
              this.root.guard(() => {
                if (this.closed) this.root.error('IR_LIFECYCLE', 'This body Builder is closed.');
                if (this.root.active !== this)
                  this.root.error(
                    'IR_SCOPE',
                    'A captured outer Builder cannot emit into a nested callback.',
                  );
                if (this.ended)
                  this.root.error(
                    this.endedByWaitUntil ? 'IR_JIT_BOUNDARY' : 'IR_CONTROL_FLOW',
                    'Cannot append an operation after a path terminator.',
                  );
                return this.invoke(key, args);
              })
          : undefined,
    });
  }
  node(node: Node): void {
    const withSource = {
      ...node,
      ...(node.source === undefined && this.source !== undefined
        ? { source: snapshot(this.source) }
        : {}),
    };
    operation(withSource, []);
    this.operations.push(withSource);
  }
  result(type: ValueTypeIR, node: Node, extra: Partial<Handle> = {}): object {
    const id = this.space.result++;
    this.node({ ...node, result: id, type });
    return fresh(values, {
      root: this.root,
      scope: this.scope,
      space: this.space,
      type,
      id,
      ...extra,
    });
  }
  handle(value: unknown, expected?: ValueTypeIR): Handle {
    const info = infoOf(value);
    if (
      !info ||
      info.root !== this.root ||
      info.space !== this.space ||
      !descendant(this.scope, info.scope)
    )
      this.root.error('IR_SCOPE', 'Value is not visible in the current execution body or scope.');
    if (expected && !sameType(info.type, expected))
      this.root.error('IR_TYPE', 'Operand type does not match the expected type.');
    return info;
  }
  localHandle(value: unknown): LocalHandle {
    const info = locals.get(value as object);
    if (
      !info ||
      info.root !== this.root ||
      info.space !== this.space ||
      !descendant(this.scope, info.scope)
    )
      this.root.error('IR_SCOPE', 'Local is not visible in this execution body or scope.');
    return info;
  }
  infer(value: unknown): ValueTypeIR {
    const info = infoOf(value);
    if (info) return this.handle(value).type;
    const member = enumOf(value);
    if (member) {
      if (
        member.owner &&
        member.owner !== this.root &&
        (!this.root.device || definitionOwners.get(this.root.device) !== member.owner)
      )
        this.root.error('IR_SCOPE', 'Enum member belongs to another device definition.');
      return { kind: 'enum', name: member.name };
    }
    if (typeof value === 'number') return n;
    if (typeof value === 'boolean') return b;
    if (typeof value === 'string') return str;
    if (Array.isArray(value) || value instanceof Uint8Array) return bytes;
    this.root.error('IR_TYPE', 'A null or record literal requires an explicit target type.');
  }
  constantData(type: ValueTypeIR, value: unknown): ConstantIR {
    if (type.kind === 'optional') {
      if (value !== null)
        this.root.error('IR_TYPE', 'Optional constants must be lifted from a non-null value.');
      return { kind: 'none' };
    }
    if (type.kind === 'number' || type.kind === 'bool' || type.kind === 'string') {
      if (typeof value !== (type.kind === 'bool' ? 'boolean' : type.kind))
        this.root.error('IR_TYPE', 'Constant value does not match its target type.');
      return { kind: type.kind, value } as ConstantIR;
    }
    if (type.kind === 'enum') {
      const member = enumOf(value);
      if (!member || member.name !== type.name)
        this.root.error('IR_TYPE', 'Enum constants require a matching enum member token.');
      if (
        member.owner &&
        member.owner !== this.root &&
        (!this.root.device || definitionOwners.get(this.root.device) !== member.owner)
      )
        this.root.error('IR_SCOPE', 'Enum member belongs to another definition.');
      return { kind: 'enum', name: member.name, member: member.member };
    }
    if (type.kind === 'record') {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        this.root.error('IR_TYPE', 'A record constant requires a field object.');
      const info = [...this.root.expectedTypes].find((info) => {
        const base = info.type.kind === 'optional' ? info.type.inner : info.type;
        return base.kind === 'record' && base.name === type.name && info.fields;
      });
      const declaration = this.root.names.get(type.name);
      const expected = info?.fields
        ? Object.entries(info.fields).map(([name, t]) => ({
            name,
            type: typeData.get(t)!.type.kind,
          }))
        : declaration?.kind === 'record'
          ? declaration.fields
          : undefined;
      if (!expected)
        this.root.error('IR_TYPE', 'Record constants require a complete named type descriptor.');
      const input = value as Node;
      if (
        Object.keys(input).length !== expected.length ||
        expected.some(
          (field) =>
            !Object.hasOwn(input, field.name) ||
            typeof input[field.name] !== (field.type === 'bool' ? 'boolean' : 'number'),
        )
      )
        this.root.error('IR_TYPE', 'Record constant fields do not match the target type.');
      return {
        kind: 'record',
        name: type.name,
        fields: Object.keys(input).map((name) => ({
          name,
          value: input[name] as number | boolean,
        })),
      };
    }
    if (type.kind === 'bytes') {
      if (!(value instanceof Uint8Array) && !Array.isArray(value))
        this.root.error('IR_TYPE', 'bytes constants require a Uint8Array or number array.');
      const array = Array.from(value as ArrayLike<number>);
      if (array.some((element) => !Number.isInteger(element) || element < 0 || element > 255))
        this.root.error('IR_TYPE', 'Every bytes element must be an integer from zero to 255.');
      return { kind: 'bytes', value: Object.freeze(array) };
    }
    this.root.error('IR_TYPE', 'sample and intent cannot be constructed from host constants.');
  }
  operand(value: unknown, expected?: ValueTypeIR): Handle {
    if (infoOf(value)) {
      const info = this.handle(value);
      if (expected && expected.kind === 'optional' && sameType(info.type, expected.inner)) {
        const lifted = this.handle(this.result(expected, { kind: 'optional', value: info.id }));
        this.facts.set(alias(lifted), true);
        return lifted;
      }
      if (expected && !sameType(info.type, expected))
        this.root.error('IR_TYPE', 'Operand type does not match the expected type.');
      return info;
    }
    const type = expected ?? this.infer(value);
    if (type.kind === 'optional' && value !== null) {
      const constant = this.operand(value, type.inner);
      const lifted = this.handle(this.result(type, { kind: 'optional', value: constant.id }));
      this.facts.set(alias(lifted), true);
      return lifted;
    }
    return this.handle(
      this.result(
        type,
        { kind: 'constant', constant: this.constantData(type, value) },
        { none: value === null },
      ),
    );
  }
  ref(value: unknown, category: 'pin' | 'memory'): PinRefIR | MemoryRefIR {
    if (typeof value === 'string') return { kind: category, name: value };
    const info = referenceOf(value);
    if (
      !info ||
      info.root !== this.root ||
      info.space !== this.space ||
      !descendant(this.scope, info.scope)
    )
      this.root.error('IR_SCOPE', 'Resource reference is not visible in this body.');
    if ((info.ref.kind === 'parameter' ? info.ref.resource : info.ref.kind) !== category)
      this.root.error('IR_REFERENCE', 'Resource reference category does not match.');
    return info.ref;
  }
  refHandle(name: unknown, category: 'pin' | 'memory'): object {
    return fresh(refs, {
      root: this.root,
      scope: this.scope,
      space: this.space,
      ref: { kind: category, name: name as string },
    });
  }
  requireRead(): void {
    if (['creation', 'initial'].includes(this.mode))
      this.root.error('IR_EFFECT', 'Runtime resource reads are not available in creation code.');
  }
  requireEffect(): void {
    if (['creation', 'initial', 'pure'].includes(this.mode))
      this.root.error('IR_EFFECT', 'Runtime effects are not available in pure or creation code.');
  }
  branch(
    emit: unknown,
    condition?: { info: Handle; truth: boolean },
    compute?: ValueTypeIR,
    loop = false,
  ): { body: RegionIR; builder: Body; returned: unknown } {
    if (typeof emit !== 'function') this.root.error('IR_SCHEMA', 'A body callback is required.');
    const body = new Body(
      this.root,
      this.mode,
      this.space,
      { parent: this.scope },
      this,
      this.returns,
    );
    body.source = this.source;
    body.loop = compute ? 0 : this.loop + (loop ? 1 : 0);
    body.calculate = !!compute || this.calculate;
    body.facts = new Map(this.facts);
    body.localValues = new Map(this.localValues);
    if (condition)
      for (const [value, fact] of (condition.truth ? condition.info.yes : condition.info.no) ?? [])
        body.facts.set(alias(value), fact);
    const previous = this.root.active;
    this.root.active = body;
    let returned: unknown;
    try {
      returned = emit(body.view());
      if (compute) {
        if (returned === undefined) {
          if (!body.ended)
            this.root.error(
              'IR_CONTROL_FLOW',
              'A compute callback must produce a value on every normal path.',
            );
        } else if (!body.ended) {
          const value = body.operand(returned, compute);
          body.node({ kind: 'yield', value: value.id });
          body.yielded = true;
          body.ended = true;
        }
      }
    } finally {
      body.closed = true;
      this.root.active = previous;
    }
    this.root.check();
    return {
      body: {
        operations: body.operations,
        ...(body.source ? { source: snapshot(body.source) } : {}),
      },
      builder: body,
      returned,
    };
  }
  merge(branches: Body[]): void {
    const live = branches.filter((branch) => !branch.ended);
    if (!live.length) {
      this.ended = true;
      this.endedByWaitUntil = branches.some((branch) => branch.endedByWaitUntil);
      return;
    }
    this.facts = joinFacts(live.map((branch) => branch.facts));
    for (const [local, old] of this.localValues) {
      const candidates = live.map((branch) => branch.localValues.get(local) ?? old);
      if (candidates.every((value) => value === candidates[0]))
        this.localValues.set(local, candidates[0]!);
      else {
        const merged: Handle = { ...old, alias: undefined } as Handle;
        this.localValues.set(local, merged);
        if (candidates.every((value, i) => live[i]!.facts.get(alias(value)) === true))
          this.facts.set(merged, true);
      }
    }
  }
  mergeComputations(branches: Body[], includeCurrent = false): void {
    const live = branches.filter((branch) => branch.yielded);
    if (includeCurrent) live.push(this);
    if (!live.length) {
      this.ended = true;
      return;
    }
    this.facts = joinFacts(live.map((branch) => branch.facts));
    for (const [local, old] of this.localValues) {
      const candidates = live.map((branch) => branch.localValues.get(local) ?? old);
      if (candidates.every((value) => value === candidates[0]))
        this.localValues.set(local, candidates[0]!);
      else {
        const unknown = { ...old, alias: undefined } as Handle;
        this.localValues.set(local, unknown);
        if (candidates.every((value, i) => live[i]!.facts.get(alias(value)) === true))
          this.facts.set(unknown, true);
      }
    }
  }
  invoke(method: string, args: unknown[]): unknown {
    if (unary.includes(method)) {
      const value = this.operand(args[0], method === 'not' ? b : n);
      return this.result(
        method === 'not' ? b : n,
        { kind: 'unary', operator: method, value: value.id },
        method === 'not' ? { yes: value.no ?? new Map(), no: value.yes ?? new Map() } : {},
      );
    }
    if (binary.includes(method)) {
      const equality = ['equal', 'notEqual'].includes(method);
      const type = equality ? this.root.type(args.shift()) : method === 'concat' ? str : n;
      const left = this.operand(args[0], type),
        right = this.operand(args[1], type);
      if (
        equality &&
        (type.kind === 'intent' ||
          (type.kind === 'optional' && type.inner.kind === 'intent' && !left.none && !right.none))
      )
        this.root.error('IR_TYPE', 'Intent values do not support content equality.');
      const tested = left.none ? right : right.none ? left : undefined;
      const comparison =
        equality ||
        ['lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual'].includes(method);
      return this.result(
        comparison ? b : type,
        { kind: 'binary', operator: method, left: left.id, right: right.id },
        tested
          ? {
              yes: new Map([[alias(tested), method !== 'equal']]),
              no: new Map([[alias(tested), method === 'equal']]),
            }
          : {},
      );
    }
    if (numeric.includes(method)) {
      const count = ['min', 'max', 'pow'].includes(method) ? 2 : 1;
      if (args.length !== count)
        this.root.error('IR_TYPE', 'Numeric builtin argument count does not match.');
      return this.result(method.startsWith('is') ? b : n, {
        kind: 'numeric',
        builtin: method,
        args: args.map((value) => this.operand(value, n).id),
      });
    }
    if (loads.includes(method) || stores.includes(method)) {
      this.requireRead();
      const memory = this.ref(args[0], 'memory'),
        offset = this.operand(args[1], n);
      if (stores.includes(method)) {
        this.requireEffect();
        this.node({ kind: method, memory, offset: offset.id, value: this.operand(args[2], n).id });
        return;
      }
      return this.result(n, { kind: method, memory, offset: offset.id });
    }
    switch (method) {
      case 'withSource': {
        const [source, emit] = args;
        const view = new Body(
          this.root,
          this.mode,
          this.space,
          this.scope,
          this.parent,
          this.returns,
        );
        view.source = snapshot(source as SourceInfo);
        view.loop = this.loop;
        view.calculate = this.calculate;
        view.facts = this.facts;
        view.localValues = this.localValues;
        const previous = this.root.active;
        this.root.active = view;
        try {
          (emit as BodyEmitter)(view.view());
        } finally {
          view.closed = true;
          this.root.active = previous;
        }
        this.operations.push(...view.operations);
        this.ended = view.ended;
        this.endedByWaitUntil = view.endedByWaitUntil;
        this.facts = view.facts;
        this.localValues = view.localValues;
        return;
      }
      case 'constant':
        if (infoOf(args[1]))
          this.root.error('IR_TYPE', 'constant requires a host constant, not a Value handle.');
        return this.objectOperand(args[1], this.root.type(args[0]));
      case 'readProperty':
      case 'readConst':
      case 'readState':
      case 'readDerived': {
        if (['readState', 'readDerived'].includes(method)) this.requireRead();
        const resource = method.slice(4).toLowerCase();
        return this.result(this.root.type(args[1]), { kind: 'read', resource, name: args[0] });
      }
      case 'local': {
        const type = this.root.type(args[0]),
          initial = this.operand(args[1], type),
          id = this.space.local++;
        this.node({ kind: 'local', local: id, type, initial: initial.id });
        const data: LocalHandle = {
          root: this.root,
          space: this.space,
          scope: this.scope,
          type,
          id,
        };
        this.localValues.set(data, initial);
        return fresh(locals, data);
      }
      case 'getLocal': {
        const local = this.localHandle(args[0]),
          current = this.localValues.get(local)!;
        return this.result(
          local.type,
          { kind: 'localRead', local: local.id },
          {
            alias: alias(current),
            yes: current.yes ?? new Map(),
            no: current.no ?? new Map(),
            none: current.none ?? false,
          },
        );
      }
      case 'setLocal': {
        const local = this.localHandle(args[0]),
          value = this.operand(args[1], local.type);
        this.node({ kind: 'localWrite', local: local.id, value: value.id });
        this.localValues.set(local, value);
        return;
      }
      case 'record': {
        const type = this.root.type(args[0]),
          descriptor = typeData.get(args[0] as object)!;
        const input = args[1];
        if (
          type.kind !== 'record' ||
          !descriptor.fields ||
          !input ||
          typeof input !== 'object' ||
          Object.keys(input).length !== Object.keys(descriptor.fields).length ||
          Object.keys(descriptor.fields).some((key) => !Object.hasOwn(input, key))
        )
          this.root.error('IR_TYPE', 'Record fields must exactly match the descriptor.');
        return this.result(type, {
          kind: 'record',
          fields: Object.keys(input).map((name) => ({
            name,
            value: this.operand(
              (input as Record<string, unknown>)[name],
              this.root.type(descriptor.fields![name]),
            ).id,
          })),
        });
      }
      case 'field': {
        const value = this.handle(args[0]),
          field = args[1] as string;
        let type: ValueTypeIR | undefined;
        if (value.type.kind === 'sample')
          type = (
            {
              voltage: { kind: 'optional', inner: n },
              level: { kind: 'enum', name: 'Logic' },
              status: { kind: 'enum', name: 'SampleStatus' },
            } as Record<string, ValueTypeIR>
          )[field];
        else if (value.type.kind === 'record') {
          const name = value.type.name;
          const descriptor = [...this.root.expectedTypes].find((info) => {
            const base = info.type.kind === 'optional' ? info.type.inner : info.type;
            return base.kind === 'record' && base.name === name && info.fields;
          });
          const f = descriptor?.fields?.[field];
          if (f) type = this.root.type(f);
          else {
            const declaration = this.root.names.get(name);
            const found =
              declaration?.kind === 'record'
                ? declaration.fields.find((f) => f.name === field)
                : undefined;
            if (found) type = { kind: found.type };
          }
        }
        if (!type) this.root.error('IR_REFERENCE', 'Unknown record or sample field.');
        const parent = alias(value);
        parent.fields ??= new Map();
        const previous = parent.fields.get(field);
        const output = this.result(
          type,
          { kind: 'field', value: value.id, field },
          previous ? { alias: previous } : {},
        );
        if (!previous) parent.fields.set(field, this.handle(output));
        return output;
      }
      case 'bytes':
        return this.result(bytes, {
          kind: 'bytes',
          elements: args.map((value) => this.operand(value, n).id),
        });
      case 'length': {
        const value = this.handle(args[0]);
        if (!['string', 'bytes'].includes(value.type.kind))
          this.root.error('IR_TYPE', 'length requires string or bytes.');
        return this.result(n, { kind: 'length', value: value.id });
      }
      case 'index': {
        const value = this.handle(args[0]);
        if (!['string', 'bytes'].includes(value.type.kind))
          this.root.error('IR_TYPE', 'index requires string or bytes.');
        return this.result(value.type.kind === 'string' ? str : n, {
          kind: 'index',
          value: value.id,
          index: this.operand(args[1], n).id,
        });
      }
      case 'optional': {
        const value = this.handle(args[0]);
        if (value.type.kind === 'optional')
          this.root.error('IR_TYPE', 'Optional types cannot be nested.');
        const output = this.result(
          { kind: 'optional', inner: value.type },
          { kind: 'optional', value: value.id },
        );
        this.facts.set(alias(this.handle(output)), true);
        return output;
      }
      case 'isNone': {
        const value = this.handle(args[0]);
        if (value.type.kind !== 'optional')
          this.root.error('IR_TYPE', 'isNone requires an optional value.');
        return this.result(
          b,
          { kind: 'isNone', value: value.id },
          { yes: new Map([[alias(value), false]]), no: new Map([[alias(value), true]]) },
        );
      }
      case 'nonNull': {
        const value = this.handle(args[0]);
        if (value.type.kind !== 'optional' || this.facts.get(alias(value)) !== true)
          this.root.error('IR_TYPE', 'nonNull requires a dominating non-null proof.');
        return this.result(value.type.inner, { kind: 'nonNull', value: value.id });
      }
      case 'pin':
        if (this.mode === 'creation')
          this.root.error(
            'IR_EFFECT',
            'Pin references are not available in ordinary creation computations.',
          );
        return this.refHandle(args[0], 'pin');
      case 'memory':
        this.requireRead();
        return this.refHandle(args[0], 'memory');
      case 'memoryLength':
        this.requireRead();
        return this.result(n, { kind: 'memoryLength', memory: this.ref(args[0], 'memory') });
      case 'copyBytes':
        this.requireRead();
        return this.result(bytes, {
          kind: 'copyBytes',
          memory: this.ref(args[0], 'memory'),
          offset: this.operand(args[1], n).id,
          length: this.operand(args[2], n).id,
        });
      case 'readSample':
        this.requireRead();
        return this.result(sample, { kind: 'readSample', pin: this.ref(args[0], 'pin') });
      case 'resistor':
        if (this.mode === 'creation')
          this.root.error(
            'IR_EFFECT',
            'Intent construction requires initial-intent or runtime code.',
          );
        return this.result(intent, {
          kind: 'resistor',
          to: this.ref(args[0], 'pin'),
          resistance: this.operand(args[1], n).id,
        });
      case 'combineIntents':
        if (this.mode === 'creation')
          this.root.error('IR_EFFECT', 'Intent construction is not available here.');
        return this.result(intent, {
          kind: 'combineIntents',
          values: args.map((value) => this.operand(value, intent).id),
        });
      case 'refEqual': {
        this.requireRead();
        const left = referenceOf(args[0]),
          right = referenceOf(args[1]);
        if (!left || !right)
          this.root.error('IR_TYPE', 'refEqual requires resource reference handles.');
        const category = left.ref.kind === 'parameter' ? left.ref.resource : left.ref.kind;
        return this.result(b, {
          kind: 'refEqual',
          left: this.ref(args[0], category),
          right: this.ref(args[1], category),
        });
      }
      case 'writeState':
        this.requireEffect();
        this.node({
          kind: 'write',
          resource: 'state',
          name: args[0],
          value: this.operand(args[1], this.root.declarationType(args[0])).id,
        });
        return;
      case 'writeIntent':
        this.requireEffect();
        this.node({
          kind: 'writeIntent',
          pin: this.ref(args[0], 'pin'),
          value: this.operand(args[1], intent).id,
        });
        return;
      case 'send':
        this.requireEffect();
        this.node({
          kind: 'send',
          channel: args[0],
          value: this.operand(args[1], this.root.declarationType(args[0])).id,
        });
        return;
      case 'notify':
        this.requireEffect();
        this.node({ kind: 'notify', notification: args[0] });
        return;
      case 'now':
      case 'random':
        this.requireEffect();
        return this.result(n, { kind: method });
      case 'call':
      case 'callValue':
      case 'callPure':
      case 'callPureValue': {
        const pure = method.startsWith('callPure'),
          hasValue = method.endsWith('Value');
        if (!pure) this.requireEffect();
        const name = args.shift() as string,
          type = hasValue ? this.root.type(args.shift()) : undefined;
        const signature = this.root.names.get(name);
        const parameters = signature?.kind === 'function' ? signature.params : undefined;
        const argumentsIR = args.map((value, index) => {
          const ref = referenceOf(value);
          if (ref) {
            if (this.mode === 'creation')
              this.root.error(
                'IR_EFFECT',
                'Resource arguments are not available in ordinary creation code.',
              );
            return this.ref(value, ref.ref.kind === 'parameter' ? ref.ref.resource : ref.ref.kind);
          }
          const expected = parameters?.[index]?.type;
          if (expected && ['pin', 'memory'].includes(expected.kind))
            this.root.error('IR_TYPE', 'A resource reference argument is required.');
          if (!expected && !infoOf(value)) {
            const requiresSignature =
              value === null ||
              (typeof value === 'object' &&
                !enumOf(value) &&
                !Array.isArray(value) &&
                !(value instanceof Uint8Array));
            const inferred = requiresSignature ? n : this.infer(value);
            const node: PendingNode = {
              kind: 'constant',
              result: this.space.result++,
              type: inferred,
              constant: requiresSignature
                ? { kind: 'number', value: 0 }
                : this.constantData(inferred, value),
              ...(this.source ? { source: snapshot(this.source) } : {}),
            };
            this.operations.push(node as unknown as OperationIR);
            this.root.pending.push({
              node,
              call: name,
              index,
              value: enumOf(value) ? value : snapshot(value),
              body: this,
              requiresSignature,
            });
            return { kind: 'value', value: node.result };
          }
          return {
            kind: 'value',
            value: this.operand(value, expected as ValueTypeIR | undefined).id,
          };
        });
        const node = { kind: hasValue ? 'callValue' : 'call', name, pure, args: argumentsIR };
        if (hasValue) return this.result(type!, node);
        this.node(node);
        return;
      }
      case 'receive':
        if (this.calculate || this.mode !== 'process')
          this.root.error('IR_EFFECT', 'receive requires a process statement region.');
        return this.result(this.root.type(args[1]), { kind: 'receive', channel: args[0] });
      case 'if': {
        const condition = this.operand(args[0], b);
        const yes = this.branch(args[1], { info: condition, truth: true });
        const no = this.branch(args[2] ?? (() => {}), { info: condition, truth: false });
        this.node({
          kind: 'if',
          condition: condition.id,
          yes: yes.body,
          ...(args[2] ? { no: no.body } : {}),
        });
        this.merge([yes.builder, no.builder]);
        return;
      }
      case 'match': {
        const value = this.handle(args[0]),
          arms = args[1];
        if (!Array.isArray(arms)) this.root.error('IR_SCHEMA', 'match arms must be an array.');
        const builders: Body[] = [];
        const nodes = arms.map((arm: Node) => {
          const pattern =
            arm.pattern === null
              ? { kind: 'none' }
              : this.constantData(
                  value.type.kind === 'optional' ? value.type.inner : value.type,
                  arm.pattern,
                );
          if (!['none', 'number', 'bool', 'string', 'enum'].includes(pattern.kind))
            this.root.error('IR_TYPE', 'Invalid match pattern.');
          const condition: Handle = {
            ...value,
            yes: new Map([[alias(value), pattern.kind !== 'none']]),
          };
          const branch = this.branch(arm.emit, { info: condition, truth: true });
          builders.push(branch.builder);
          return { pattern, body: branch.body };
        });
        const defaultCondition = nodes.some((node) => node.pattern.kind === 'none')
          ? { info: { ...value, yes: new Map([[alias(value), true]]) }, truth: true }
          : undefined;
        const fallback = args[2] ? this.branch(args[2], defaultCondition) : undefined;
        if (fallback) builders.push(fallback.builder);
        this.node({
          kind: 'match',
          value: value.id,
          arms: nodes,
          ...(fallback ? { otherwise: fallback.body } : {}),
        });
        this.merge(builders.length ? builders : [this]);
        return;
      }
      case 'while':
      case 'loop': {
        const before = new Map(this.localValues);
        const test = method === 'while' ? this.branch(args[0], undefined, b) : undefined;
        const body = this.branch(args[method === 'while' ? 1 : 0], undefined, undefined, true);
        this.node({
          kind: method,
          ...(test ? { test: { type: b, body: test.body } } : {}),
          body: body.body,
        });
        for (const [local, old] of before)
          if (
            body.builder.localValues.get(local) !== old ||
            (test && test.builder.localValues.get(local) !== old)
          )
            this.localValues.set(local, { ...old, alias: undefined } as Handle);
        if (test && !test.builder.yielded) this.ended = true;
        return;
      }
      case 'and':
      case 'or': {
        const left = this.operand(args[0], b),
          isAnd = method === 'and';
        const branch = this.branch(args[1], { info: left, truth: isAnd }, b);
        const right = infoOf(branch.returned);
        const combine = (a?: Map<Handle, boolean>, b?: Map<Handle, boolean>) =>
          new Map([...(a ?? []), ...(b ?? [])]);
        const yes = isAnd
          ? combine(left.yes, right?.yes)
          : joinFacts([left.yes ?? new Map(), combine(left.no, right?.yes)]);
        const no = isAnd
          ? joinFacts([left.no ?? new Map(), combine(left.yes, right?.no)])
          : combine(left.no, right?.no);
        const value = this.result(
          b,
          { kind: method, left: left.id, right: { type: b, body: branch.body } },
          { yes, no },
        );
        this.mergeComputations([branch.builder], true);
        return value;
      }
      case 'select': {
        const type = this.root.type(args[0]),
          condition = this.operand(args[1], b);
        const yes = this.branch(args[2], { info: condition, truth: true }, type),
          no = this.branch(args[3], { info: condition, truth: false }, type);
        const value = this.result(type, {
          kind: 'select',
          condition: condition.id,
          yes: { type, body: yes.body },
          no: { type, body: no.body },
        });
        this.mergeComputations([yes.builder, no.builder]);
        return value;
      }
      case 'assert': {
        const condition = this.operand(args[0], b),
          message = args[1]
            ? this.branch(args[1], { info: condition, truth: false }, str)
            : undefined;
        this.node({
          kind: 'assert',
          condition: condition.id,
          ...(message ? { message: { type: str, body: message.body } } : {}),
        });
        for (const [value, fact] of condition.yes ?? []) this.facts.set(alias(value), fact);
        return;
      }
      case 'wait':
      case 'elapse':
        if (this.calculate || (method === 'wait' ? this.mode !== 'process' : this.mode !== 'jit'))
          this.root.error('IR_EFFECT', `${method} is not permitted in this context.`);
        this.node({ kind: method, duration: this.operand(args[0], n).id });
        return;
      case 'waitUntil':
        if (this.mode !== 'jit' || this.calculate || this.loop)
          this.root.error(
            'IR_JIT_BOUNDARY',
            'waitUntil requires a JIT tail path outside loops and computations.',
          );
        this.node({ kind: 'waitUntil', predicate: args[0] });
        this.ended = true;
        this.endedByWaitUntil = true;
        return;
      case 'redirect':
        if (!['jit', 'sync'].includes(this.mode))
          this.root.error('IR_EFFECT', 'redirect requires a JIT-capable context.');
        this.node({
          kind: 'redirect',
          target: this.operand(args[0], n).id,
          delay: this.operand(args[1] ?? 0, n).id,
        });
        this.ended = true;
        return;
      case 'stop':
        if (this.mode !== 'jit' || this.calculate)
          this.root.error('IR_EFFECT', 'stop requires a JIT statement region.');
        this.node({ kind: 'stop' });
        this.ended = true;
        return;
      case 'break':
      case 'continue':
        if (!this.loop) this.root.error('IR_CONTROL_FLOW', `${method} requires an enclosing loop.`);
        this.node({ kind: method });
        this.ended = true;
        return;
      case 'return':
        if (this.calculate || this.returns || ['jit', 'creation', 'initial'].includes(this.mode))
          this.root.error('IR_CONTROL_FLOW', 'Void return is not permitted in this body.');
        this.node({ kind: 'return' });
        this.ended = true;
        return;
      case 'returnValue':
        if (this.calculate || !this.returns)
          this.root.error('IR_CONTROL_FLOW', 'returnValue is not permitted in this body.');
        this.node({ kind: 'returnValue', value: this.operand(args[0], this.returns).id });
        this.ended = true;
        return;
      default:
        this.root.error('IR_SCHEMA', `Unknown Builder operation ${method}.`);
    }
  }
  objectOperand(value: unknown, type: ValueTypeIR): object {
    const info = this.operand(value, type);
    // Return the original opaque handle identity, not the internal metadata object.
    return fresh(values, info);
  }
}
function deviceView(root: Root, temporary = { closed: false }): DeviceBuilder {
  return new Proxy(Object.create(null), {
    get: (_target, method) =>
      typeof method === 'string'
        ? (...args: unknown[]) => {
            if (method === 'finish') {
              root.check();
              if (temporary.closed) root.error('IR_LIFECYCLE', 'This source view is closed.');
              if (root.active)
                root.error('IR_SCOPE', 'Cannot finish a device while a body callback is active.');
              root.closed = true;
              root.resolve();
              const definition = validateDeviceIR({
                kind: 'device',
                name: root.options.name,
                declarations: root.declarations,
                ...root.sourceFor(),
              });
              definitionOwners.set(definition, root);
              return definition;
            }
            return root.guard(() => {
              if (temporary.closed) root.error('IR_LIFECYCLE', 'This source view is closed.');
              if (root.active)
                root.error(
                  'IR_SCOPE',
                  'Cannot add declarations inside an executable body callback.',
                );
              if (method === 'withSource') {
                const previous = root.source,
                  viewState = { closed: false };
                root.source = snapshot(args[0] as SourceInfo);
                try {
                  (args[1] as (view: DeviceBuilder) => unknown)(deviceView(root, viewState));
                } finally {
                  viewState.closed = true;
                  root.source = previous;
                }
                return;
              }
              const options = (args[0] ?? {}) as RuntimeOptions,
                source = options.source ?? root.source;
              const base = { name: options.name, ...root.sourceFor(options) };
              if (method === 'enum') {
                const descriptor = factory.namedEnum(options.name, options.members);
                const data = typeData.get(descriptor)!;
                data.owner = root;
                const owned = enumType(options.name, options.members, root);
                root.add({ kind: 'enum', ...base, members: [...options.members] });
                return owned;
              }
              if (method === 'record') {
                factory.namedRecord(options.name, options.fields);
                for (const type of Object.values(options.fields)) root.type(type as object);
                const descriptor = recordType(options.name, options.fields, root);
                root.add({
                  kind: 'record',
                  ...base,
                  fields: Object.entries(options.fields).map(([name, type]) => ({
                    name,
                    type: root.type(type as object).kind,
                  })),
                });
                return descriptor;
              }
              if (['property', 'constant', 'state'].includes(method)) {
                const type = root.type(options.type),
                  key =
                    method === 'property' ? 'default' : method === 'constant' ? 'value' : 'initial';
                if (key !== 'default' && !Object.hasOwn(options, key))
                  root.error('IR_SCHEMA', `Missing ${key}.`);
                root.add({
                  kind: method === 'constant' ? 'const' : method,
                  ...base,
                  type,
                  ...(Object.hasOwn(options, key)
                    ? { [key]: root.creation(type, options[key], 'creation', source) }
                    : {}),
                });
                return;
              }
              if (method === 'derived') {
                const type = root.type(options.type);
                root.add({
                  kind: 'derived',
                  ...base,
                  type,
                  value: { type, body: root.body('pure', args[1], type, source) },
                });
                return;
              }
              if (method === 'pin') {
                if (Object.hasOwn(options, 'low') !== Object.hasOwn(options, 'high'))
                  root.error('IR_SCHEMA', 'Pin thresholds must be specified together.');
                root.add({
                  kind: 'pin',
                  ...base,
                  ...(Object.hasOwn(options, 'low')
                    ? {
                        low: root.creation(n, options.low, 'creation', source),
                        high: root.creation(n, options.high, 'creation', source),
                      }
                    : {}),
                  ...(Object.hasOwn(options, 'initial')
                    ? { initial: root.creation(intent, options.initial, 'initial', source) }
                    : {}),
                });
                return;
              }
              if (method === 'memory') {
                root.add({
                  kind: 'memory',
                  ...base,
                  public: options.public ?? false,
                  length: root.creation(n, options.length, 'creation', source),
                });
                return;
              }
              if (method === 'channel') {
                const type = root.type(options.type);
                root.add({
                  kind: 'channel',
                  ...base,
                  direction: options.direction,
                  type,
                  capacity: root.creation(n, options.capacity, 'creation', source),
                  ...(Object.hasOwn(options, 'maxLength')
                    ? { maxLength: root.creation(n, options.maxLength, 'creation', source) }
                    : {}),
                  ...(Object.hasOwn(options, 'overflow')
                    ? {
                        overflow: root.creation(
                          { kind: 'enum', name: 'Overflow' },
                          options.overflow,
                          'creation',
                          source,
                        ),
                      }
                    : {}),
                });
                return;
              }
              if (method === 'notification') {
                root.add({ kind: 'notification', ...base, direction: options.direction });
                return;
              }
              if (method === 'fn' || method === 'pureFn') {
                const pure = method === 'pureFn',
                  returns = Object.hasOwn(options, 'returns')
                    ? root.type(options.returns)
                    : undefined;
                if (!Array.isArray(options.params))
                  root.error('IR_SCHEMA', 'Function parameters must be an array.');
                const params: ParameterIR[] = options.params.map((param) => ({
                  name: param.name,
                  type:
                    param.type === types.pin
                      ? { kind: 'pin' }
                      : param.type === types.memory
                        ? { kind: 'memory' }
                        : root.type(param.type),
                }));
                let bindings: Record<string, object> = {};
                const body = root.body(
                  pure ? 'pure' : 'sync',
                  (view: BodyView) =>
                    (args[1] as (body: BodyView, bindings: Record<string, object>) => unknown)(
                      view,
                      bindings,
                    ),
                  returns,
                  source,
                  (body) => {
                    bindings = Object.create(null);
                    params.forEach((param, index) => {
                      bindings[param.name] =
                        param.type.kind === 'pin' || param.type.kind === 'memory'
                          ? fresh(refs, {
                              root,
                              scope: body.scope,
                              space: body.space,
                              ref: { kind: 'parameter', resource: param.type.kind, index },
                            })
                          : body.result(param.type as ValueTypeIR, { kind: 'parameter', index });
                    });
                  },
                );
                root.add({
                  kind: 'function',
                  ...base,
                  pure,
                  params,
                  ...(returns ? { returns } : {}),
                  body,
                });
                return;
              }
              if (method === 'start') {
                root.add({
                  kind: 'start',
                  body: root.body('process', args[0]),
                  ...root.sourceFor(),
                });
                return;
              }
              if (method === 'on') {
                root.add({
                  kind: 'on',
                  ...base,
                  sourcePath: snapshot(options.sourcePath),
                  body: root.body('process', args[1], undefined, source),
                });
                return;
              }
              if (method === 'reaction') {
                if (!Array.isArray(options.captures) || !args[1] || typeof args[1] !== 'object')
                  root.error(
                    'IR_SCHEMA',
                    'Reaction captures require descriptors and an emitter object.',
                  );
                const emitters = args[1] as Record<string, BodyEmitter>;
                const names = options.captures.map((capture) => capture.name);
                const keys = Object.keys(args[1]);
                if (
                  keys.length !== names.length ||
                  keys.some((key) => !names.includes(key)) ||
                  names.some((name: string) => typeof emitters[name] !== 'function')
                )
                  root.error(
                    'IR_SCHEMA',
                    'Reaction capture emitter keys must exactly match descriptor names.',
                  );
                const sourceType = root.type(options.sourceType);
                const captures = options.captures.map((capture) => {
                  const type = root.type(capture.type);
                  return {
                    name: capture.name,
                    value: {
                      type,
                      body: root.body(
                        'pure',
                        emitters[capture.name],
                        type,
                        capture.source ?? source,
                      ),
                    },
                    ...root.sourceFor(capture),
                  };
                });
                let bindings = {} as RuntimeReactionBindings;
                const body = root.body(
                  'reaction',
                  (view: BodyView) =>
                    (args[2] as (body: BodyView, bindings: RuntimeReactionBindings) => unknown)(
                      view,
                      bindings,
                    ),
                  undefined,
                  source,
                  (body) => {
                    bindings = {
                      previous: body.result(sourceType, {
                        kind: 'reactionValue',
                        binding: 'previous',
                      }),
                      current: body.result(sourceType, {
                        kind: 'reactionValue',
                        binding: 'current',
                      }),
                      captures: Object.create(null),
                    };
                    captures.forEach((capture, index) => {
                      bindings.captures[capture.name] = body.result(capture.value.type, {
                        kind: 'reactionCapture',
                        index,
                      });
                    });
                  },
                );
                root.add({
                  kind: 'reaction',
                  ...base,
                  sourcePath: snapshot(options.sourcePath),
                  sourceType,
                  previous: options.previous,
                  current: options.current,
                  captures,
                  body,
                });
                return;
              }
              if (method === 'assert') {
                root.add({
                  kind: 'assert',
                  body: root.body('creation', args[0]),
                  ...root.sourceFor(),
                });
                return;
              }
              root.error('IR_SCHEMA', `Unknown device Builder method ${method}.`);
            });
          }
        : undefined,
  }) as DeviceBuilder;
}
export function createDeviceBuilder(options: NamedOptions): DeviceBuilder {
  if (options === undefined) options = { name: 'GeneratedDevice' };
  if (!options || typeof options.name !== 'string')
    fail('IR_SCHEMA', 'A device name is required.', [], 'construct');
  return deviceView(
    new Root({
      name: options.name,
      ...(options.source ? { source: snapshot(options.source) } : {}),
    }),
  );
}
export interface JitBuilderOptions {
  readonly device?: DeviceIR;
  readonly source?: SourceInfo;
}
/** Runtime integration factory; only existing resources can be referenced by the returned view. */
export function createJitBlockBuilder(options: JitBuilderOptions = {}): JitBlockBuilder {
  const root: Root = new Root(
    { name: 'JitBlock', ...(options.source ? { source: options.source } : {}) },
    options.device,
    true,
  );
  if (options.device)
    for (const declaration of options.device.declarations)
      if ('name' in declaration) root.names.set(declaration.name, declaration);
  const view = (state = { closed: false }): JitBlockBuilder =>
    new Proxy(Object.create(null), {
      get: (_target, method) =>
        typeof method === 'string'
          ? (...args: unknown[]) => {
              if (method === 'finish') {
                root.check();
                if (state.closed) root.error('IR_LIFECYCLE', 'This source view is closed.');
                if (root.active)
                  root.error('IR_SCOPE', 'Cannot finish a block inside an instruction callback.');
                root.closed = true;
                root.resolve();
                const block = {
                  kind: 'block',
                  instructions: root.instructions,
                  ...root.sourceFor(),
                };
                return options.device
                  ? validateBoundBlockIR(block, options.device)
                  : validateBlockIR(block);
              }
              return root.guard(() => {
                if (state.closed) root.error('IR_LIFECYCLE', 'This source view is closed.');
                if (root.active)
                  root.error('IR_SCOPE', 'Cannot add instructions inside an instruction callback.');
                if (method === 'withSource') {
                  const old = root.source,
                    nested = { closed: false };
                  root.source = snapshot(args[0] as SourceInfo);
                  try {
                    (args[1] as (view: JitBlockBuilder) => unknown)(view(nested));
                  } finally {
                    nested.closed = true;
                    root.source = old;
                  }
                  return;
                }
                if (method !== 'instruction')
                  root.error('IR_SCHEMA', `Unknown block Builder method ${method}.`);
                const boundary = args[0] as InstructionBoundary | undefined;
                if (!boundary || !Number.isFinite(boundary.pc) || !Number.isFinite(boundary.nextPc))
                  root.error('IR_SCHEMA', 'Instruction boundaries require finite pc and nextPc.');
                const previous = root.instructions.at(-1);
                if (previous && previous.nextPc !== boundary.pc)
                  root.error('IR_JIT_BOUNDARY', 'Adjacent instruction boundaries must match.');
                const body = root.body('jit', args[1], undefined, boundary.source ?? root.source);
                root.instructions.push({
                  pc: boundary.pc,
                  nextPc: boundary.nextPc,
                  body,
                  ...root.sourceFor(boundary),
                });
              });
            }
          : undefined,
    }) as JitBlockBuilder;
  return view();
}
