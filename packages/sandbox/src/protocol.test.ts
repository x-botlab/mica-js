import { describe, expect, it } from 'vitest';
import { SandboxError, deserializeError } from './errors';
import { isEnvelope, serializeError, toCloneableParts } from './protocol';

describe('protocol: error serialization', () => {
  it('keeps name, message, stack and code', () => {
    const error = new SandboxError('capability-failed', 'nope');
    const serialized = serializeError(error);

    expect(serialized.name).toBe('SandboxError');
    expect(serialized.message).toBe('nope');
    expect(serialized.code).toBe('capability-failed');
    expect(serialized.stack).toBeTypeOf('string');

    const restored = deserializeError(serialized);
    expect(restored).toBeInstanceOf(SandboxError);
    expect(restored.code).toBe('capability-failed');
    expect(restored.message).toBe('nope');
    expect(restored.remoteStack).toBe(serialized.stack);
  });

  it('maps unknown codes to guest-error', () => {
    const restored = deserializeError({ name: 'Error', message: 'boom', code: 'not-a-code' });
    expect(restored.code).toBe('guest-error');
  });

  it('handles non-error values', () => {
    expect(serializeError('plain string')).toEqual({ name: 'Error', message: 'plain string' });
    expect(serializeError({ a: 1 }).message).toBe('{"a":1}');
  });
});

describe('protocol: envelopes', () => {
  it('accepts known envelopes', () => {
    expect(isEnvelope({ k: 'request', id: 1, method: 'x', args: [] })).toBe(true);
    expect(isEnvelope({ k: 'ready', info: {} })).toBe(true);
  });

  it('rejects unknown or malformed messages', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('ready')).toBe(false);
    expect(isEnvelope({ k: 'unknown' })).toBe(false);
    expect(isEnvelope({})).toBe(false);
  });
});

describe('protocol: cloneable log parts', () => {
  it('keeps cloneable values and describes the rest', () => {
    const [object, fn, symbol] = toCloneableParts([{ a: 1 }, () => undefined, Symbol('s')]);
    expect(object).toEqual({ a: 1 });
    expect(fn).toBe('[Function anonymous]');
    expect(String(symbol)).toBe('Symbol(s)');
  });
});
