import type { ComputationIR } from '@mica-js/device-model';

/** Result of a pure, side-effect-free evaluation of a DDL default computation. */
export type ConstantEvaluation =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false; readonly reason: string };

const RUNTIME_REASON = 'it depends on a value that is only known at run time';

/**
 * Evaluates a DDL computation that must be pure, such as a property default.
 *
 * Only operations whose result depends solely on literals and `const` declarations are evaluated:
 * literals, unary and binary operators, pure numeric builtins, record/bytes construction, field and
 * index access, and `length`. Anything else reports `known: false` with the reason, so a caller can
 * reject the input instead of silently accepting an unverifiable value.
 *
 * `constants` maps DDL `const` declarations to their value computations; the evaluation is
 * recursive and detects constant cycles.
 */
export function evaluateConstant(
  computation: ComputationIR,
  constants: ReadonlyMap<string, ComputationIR> = new Map(),
): ConstantEvaluation {
  try {
    const value = evaluate(computation, constants, new Set());
    if (value === UNVERIFIED) return { known: false, reason: RUNTIME_REASON };
    return { known: true, value };
  } catch (error) {
    if (error instanceof Unverifiable) return { known: false, reason: error.reason };
    throw error;
  }
}

class Unverifiable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const UNVERIFIED = Symbol('unverified');

type Value = unknown | typeof UNVERIFIED;

function fail(reason: string): never {
  throw new Unverifiable(reason);
}

function evaluate(
  computation: ComputationIR,
  constants: ReadonlyMap<string, ComputationIR>,
  visiting: Set<string>,
): Value {
  const results = new Map<number, Value>();
  let returned: Value = UNVERIFIED;
  const operations = computation.body.operations as unknown as readonly Readonly<
    Record<string, unknown>
  >[];
  for (const operation of operations) {
    const kind = operation['kind'];
    if (kind === 'returnValue') {
      const value = operation['value'] as number;
      returned = results.has(value) ? results.get(value)! : UNVERIFIED;
      continue;
    }
    if (kind === 'local' || kind === 'localWrite' || kind === 'write') continue;
    const result = operation['result'];
    if (typeof result !== 'number') continue;
    if (kind === 'localRead') {
      results.set(result, UNVERIFIED);
      continue;
    }
    results.set(result, apply(operation, results, constants, visiting));
  }
  return returned;
}

function apply(
  operation: Readonly<Record<string, unknown>>,
  results: Map<number, Value>,
  constants: ReadonlyMap<string, ComputationIR>,
  visiting: Set<string>,
): Value {
  const read = (id: unknown): Value => {
    if (typeof id !== 'number') return UNVERIFIED;
    return results.has(id) ? results.get(id)! : UNVERIFIED;
  };
  switch (operation['kind']) {
    case 'constant':
      return constantValue(operation['constant'] as Readonly<Record<string, unknown>>);
    case 'read': {
      if (operation['resource'] !== 'const') return UNVERIFIED;
      const name = operation['name'];
      if (typeof name !== 'string') return UNVERIFIED;
      const declaration = constants.get(name);
      if (declaration === undefined) return fail(`constant "${name}" is not declared in the model`);
      if (visiting.has(name)) return fail(`constant "${name}" is defined in terms of itself`);
      visiting.add(name);
      try {
        return evaluate(declaration, constants, visiting);
      } finally {
        visiting.delete(name);
      }
    }
    case 'unary': {
      const value = read(operation['value']);
      if (value === UNVERIFIED) return UNVERIFIED;
      switch (operation['operator']) {
        case 'positive':
          return typeof value === 'number' ? value : UNVERIFIED;
        case 'negate':
          return typeof value === 'number' ? -value : UNVERIFIED;
        case 'not':
          return typeof value === 'boolean' ? !value : UNVERIFIED;
        case 'bitNot':
          return typeof value === 'number' ? ~value : UNVERIFIED;
        default:
          return UNVERIFIED;
      }
    }
    case 'binary':
      return binaryValue(operation, read(operation['left']), read(operation['right']));
    case 'numeric':
      return numericValue(
        operation['builtin'],
        (operation['args'] as readonly unknown[]).map(read),
      );
    case 'record': {
      const fields = operation['fields'] as readonly {
        readonly name: string;
        readonly value: number;
      }[];
      const record: Record<string, unknown> = {};
      for (const field of fields) {
        const value = read(field.value);
        if (value === UNVERIFIED) return UNVERIFIED;
        record[field.name] = value;
      }
      return record;
    }
    case 'field': {
      const value = read(operation['value']);
      const field = operation['field'];
      if (value === UNVERIFIED || typeof value !== 'object' || value === null) return UNVERIFIED;
      return (value as Record<string, unknown>)[String(field)];
    }
    case 'index': {
      const value = read(operation['value']);
      const index = read(operation['index']);
      if (value === UNVERIFIED || typeof index !== 'number') return UNVERIFIED;
      if (typeof value === 'string') return value[index];
      if (Array.isArray(value)) return value[index];
      return UNVERIFIED;
    }
    case 'bytes': {
      const values: number[] = [];
      for (const element of operation['elements'] as readonly unknown[]) {
        const value = read(element);
        if (typeof value !== 'number') return UNVERIFIED;
        values.push(value);
      }
      return values;
    }
    case 'length': {
      const value = read(operation['value']);
      if (typeof value === 'string' || Array.isArray(value)) return value.length;
      return UNVERIFIED;
    }
    case 'optional':
    case 'nonNull':
      return read(operation['value']);
    case 'isNone':
      return read(operation['value']) === null;
    default:
      return UNVERIFIED;
  }
}

function constantValue(constant: Readonly<Record<string, unknown>> | undefined): Value {
  if (constant === undefined) return UNVERIFIED;
  switch (constant['kind']) {
    case 'number':
    case 'bool':
    case 'string':
      return constant['value'];
    case 'none':
      return null;
    case 'enum':
      return constant['member'];
    case 'record': {
      const fields = constant['fields'] as readonly {
        readonly name: string;
        readonly value: number | boolean;
      }[];
      return Object.fromEntries(fields.map((field) => [field.name, field.value]));
    }
    case 'bytes':
      return Array.from(constant['value'] as readonly number[]);
    default:
      return UNVERIFIED;
  }
}

function binaryValue(
  operation: Readonly<Record<string, unknown>>,
  left: Value,
  right: Value,
): Value {
  if (left === UNVERIFIED || right === UNVERIFIED) return UNVERIFIED;
  const numeric = typeof left === 'number' && typeof right === 'number';
  switch (operation['operator']) {
    case 'add':
      if (numeric) return left + right;
      return typeof left === 'string' && typeof right === 'string' ? left + right : UNVERIFIED;
    case 'subtract':
      return numeric ? left - right : UNVERIFIED;
    case 'multiply':
      return numeric ? left * right : UNVERIFIED;
    case 'divide':
      return numeric ? left / right : UNVERIFIED;
    case 'remainder':
      return numeric ? left % right : UNVERIFIED;
    case 'power':
      return numeric ? left ** right : UNVERIFIED;
    case 'lessThan':
      return numeric ? left < right : UNVERIFIED;
    case 'lessThanOrEqual':
      return numeric ? left <= right : UNVERIFIED;
    case 'greaterThan':
      return numeric ? left > right : UNVERIFIED;
    case 'greaterThanOrEqual':
      return numeric ? left >= right : UNVERIFIED;
    case 'equal':
      return left === right;
    case 'notEqual':
      return left !== right;
    case 'concat':
      if (typeof left === 'string' && typeof right === 'string') return left + right;
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
      return UNVERIFIED;
    case 'bitAnd':
      return numeric ? left & right : UNVERIFIED;
    case 'bitOr':
      return numeric ? left | right : UNVERIFIED;
    case 'bitXor':
      return numeric ? left ^ right : UNVERIFIED;
    default:
      return UNVERIFIED;
  }
}

function numericValue(builtin: unknown, args: readonly Value[]): Value {
  const numbers = args as readonly number[];
  if (numbers.some((value) => typeof value !== 'number')) return UNVERIFIED;
  switch (builtin) {
    case 'isNaN':
      return Number.isNaN(numbers[0]);
    case 'isFinite':
      return Number.isFinite(numbers[0]);
    case 'isInteger':
      return Number.isInteger(numbers[0]);
    case 'isSafeInteger':
      return Number.isSafeInteger(numbers[0]);
    case 'abs':
      return Math.abs(numbers[0]!);
    case 'floor':
      return Math.floor(numbers[0]!);
    case 'ceil':
      return Math.ceil(numbers[0]!);
    case 'trunc':
      return Math.trunc(numbers[0]!);
    case 'round':
      return Math.round(numbers[0]!);
    case 'sqrt':
      return Math.sqrt(numbers[0]!);
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
    case 'pow':
      return numbers[0]! ** numbers[1]!;
    default:
      return UNVERIFIED;
  }
}
