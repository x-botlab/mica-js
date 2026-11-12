import type { Diagnostic, DiagnosticCode, DiagnosticPhase, InputPath, SourceInfo } from './ir.js';

export function snapshot<T>(input: T): T {
  return capture(input, new Set<object>(), []);
}

/**
 * Recursive copy behind `snapshot`. `path` is a mutable stack: an array copy is
 * only made when a diagnostic is raised, which keeps the hot path allocation-free.
 * Output properties are created by assignment, so `__proto__` needs `defineProperty`.
 */
function capture<T>(input: T, ancestors: Set<object>, path: (string | number)[]): T {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint') {
      fail('IR_SCHEMA', 'Expected ordinary IR data.', path.slice());
    }
    return input;
  }
  if (ancestors.has(input)) fail('IR_SCHEMA', 'Cyclic IR data is not supported.', path.slice());
  ancestors.add(input);
  let output: unknown;
  if (input instanceof Uint8Array)
    output = Object.freeze(Array.from(Uint8Array.prototype.values.call(input)));
  else if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype)
      fail('IR_SCHEMA', 'Expected an ordinary IR array.');
    const result: unknown[] = [];
    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)
        fail('IR_SCHEMA', 'IR arrays cannot contain extra properties.');
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!('value' in descriptor)) fail('IR_SCHEMA', 'IR arrays cannot contain accessors.');
    }
    for (let i = 0; i < input.length; i++) {
      if (!Object.hasOwn(input, i)) fail('IR_SCHEMA', 'IR arrays cannot be sparse.');
      path.push(i);
      result.push(capture(Object.getOwnPropertyDescriptor(input, i)!.value, ancestors, path));
      path.pop();
    }
    output = Object.freeze(result);
  } else {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      fail('IR_SCHEMA', 'Expected an ordinary data object.');
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (typeof key !== 'string' || !('value' in descriptor))
        fail('IR_SCHEMA', 'IR data cannot contain symbols or accessors.');
      path.push(key);
      const value = capture(descriptor.value, ancestors, path);
      path.pop();
      if (key === '__proto__') Object.defineProperty(result, key, { value, enumerable: true });
      else result[key] = value;
    }
    output = Object.freeze(result);
  }
  ancestors.delete(input);
  return output as T;
}

export class BuildError extends Error {
  readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  constructor(diagnostics: readonly [Diagnostic, ...Diagnostic[]]) {
    if (!diagnostics.length) throw new TypeError('BuildError requires at least one diagnostic.');
    super(diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    this.name = 'BuildError';
    this.diagnostics = snapshot(diagnostics);
  }
}

export function fail(
  code: DiagnosticCode,
  message: string,
  path: InputPath = [],
  phase: DiagnosticPhase = 'finalize',
  source?: SourceInfo,
): never {
  throw new BuildError([
    { code, message, path, phase, related: [], ...(source === undefined ? {} : { source }) },
  ]);
}
