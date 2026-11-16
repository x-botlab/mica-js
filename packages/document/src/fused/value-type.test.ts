import { describe, expect, it } from 'vitest';
import type { ValueType } from './types/model';
import { validateModelValue } from './value-type';
import { catchError, codesOf, pointersOf } from './test-helpers';

const STATE: ValueType = {
  type: 'object',
  properties: {
    pressed: { type: 'boolean' },
    samples: { type: 'array', items: { type: 'number' } },
  },
  optional: ['samples'],
  additionalProperties: { type: 'string' },
};

const TYPES: Readonly<Record<string, ValueType>> = { State: STATE };

function validationError(value: unknown, type: ValueType, types?: Record<string, ValueType>) {
  return catchError(() => validateModelValue(value, type, types));
}

describe('validateModelValue', () => {
  it('accepts a value that matches its declared type', () => {
    expect(() =>
      validateModelValue({ pressed: true, samples: [1, 2], note: 'ok' }, { ref: 'State' }, TYPES),
    ).not.toThrow();
  });

  it('rejects a missing required property', () => {
    const error = validationError({ samples: [1] }, STATE);

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/pressed']);
  });

  it('rejects an unexpected property', () => {
    const error = validationError(
      { pressed: true, extra: 1 },
      {
        type: 'object',
        properties: { pressed: { type: 'boolean' } },
      },
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/extra']);
  });

  it('validates array items', () => {
    const error = validationError({ pressed: true, samples: [1, 'two'] }, STATE);

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/samples/1']);
  });

  it('rejects a non-finite number', () => {
    const error = validationError(Number.POSITIVE_INFINITY, { type: 'number' });

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
  });

  it('accepts bytes and rejects byte-like arrays', () => {
    expect(() => validateModelValue(new Uint8Array([1, 2]), { type: 'binary' })).not.toThrow();

    const error = validationError([1, 2], { type: 'binary' });
    expect(codesOf(error)).toEqual(['schema/invalid-value']);
  });

  it('rejects values outside the value domain', () => {
    expect(codesOf(validationError(new Date(), STATE))).toEqual(['schema/invalid-value']);
    expect(codesOf(validationError(undefined, { type: 'null' }))).toEqual(['schema/invalid-value']);
  });

  it('rejects an unknown type reference', () => {
    const error = validationError(1, { ref: 'Missing' }, TYPES);

    expect(codesOf(error)).toEqual(['type/unknown']);
  });

  it('rejects a declaration cycle that never reaches a value type', () => {
    const error = validationError(1, { ref: 'A' }, { A: { ref: 'B' }, B: { ref: 'A' } });

    expect(codesOf(error)).toEqual(['model/invalid-interface']);
  });

  it('accepts recursive object types', () => {
    const types: Record<string, ValueType> = {
      Node: {
        type: 'object',
        properties: { value: { type: 'number' }, next: { ref: 'Node' } },
        optional: ['next'],
      },
    };

    expect(() =>
      validateModelValue({ value: 1, next: { value: 2 } }, { ref: 'Node' }, types),
    ).not.toThrow();
  });
});
