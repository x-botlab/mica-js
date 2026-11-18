import { describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/ddl';
import type { ComputationIR } from '@mica-js/device-model';
import { evaluateConstant } from './unified-defaults';

async function defaultOf(source: string, property: string): Promise<ComputationIR> {
  const model = await compileDDL(source);
  const declaration = model.declarations.find(
    (entry) => entry.kind === 'property' && entry.name === property,
  );
  if (declaration?.kind !== 'property' || declaration.default === undefined)
    throw new Error(`missing default for ${property}`);
  return declaration.default;
}

describe('evaluateConstant', () => {
  it('evaluates literals and constant arithmetic', async () => {
    const source = `device Probe(
      ratio: number default 1 + 2 * 3,
      label: string default "a" + "b",
      enabled: bool default !false,
      mode: Mode default Mode.slow,
      optional: number? default none,
      size: number default 60 * 1000
    ) {
      enum Mode { fast, slow }
      pin a;
    }`;
    expect(await defaultOf(source, 'ratio').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: 7,
    });
    expect(await defaultOf(source, 'label').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: 'ab',
    });
    expect(await defaultOf(source, 'enabled').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: true,
    });
    expect(await defaultOf(source, 'mode').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: 'slow',
    });
    expect(await defaultOf(source, 'optional').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: null,
    });
    expect(await defaultOf(source, 'size').then((value) => evaluateConstant(value))).toEqual({
      known: true,
      value: 60_000,
    });
  });

  it('resolves DDL constants and rejects cycles', async () => {
    const model = await compileDDL(`device Probe(ratio: number default Scale) {
      const Scale = 4;
      pin a;
    }`);
    const constants = new Map(
      model.declarations
        .filter((declaration) => declaration.kind === 'const')
        .map((declaration) => [declaration.name, declaration.value]),
    );
    const property = model.declarations.find((entry) => entry.kind === 'property');
    if (property?.kind !== 'property' || property.default === undefined)
      throw new Error('missing default');
    expect(evaluateConstant(property.default, constants)).toEqual({ known: true, value: 4 });

    const cyclic = new Map<string, ComputationIR>([['Loop', property.default]]);
    expect(evaluateConstant(property.default, new Map([['Scale', property.default]]))).toEqual({
      known: false,
      reason: 'constant "Scale" is defined in terms of itself',
    });
    expect(cyclic.size).toBe(1);
  });

  it('reports values that are only known at run time instead of guessing', () => {
    const computation = {
      type: { kind: 'number' },
      body: {
        operations: [
          {
            kind: 'call',
            result: 0,
            type: { kind: 'number' },
            callee: 1,
            arguments: [],
          },
          { kind: 'returnValue', value: 0 },
        ],
      },
    } as unknown as ComputationIR;
    expect(evaluateConstant(computation)).toEqual({
      known: false,
      reason: 'it depends on a value that is only known at run time',
    });
  });
});
