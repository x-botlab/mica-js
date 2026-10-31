import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIRJIT, createIRModule, toNumber } from '@mica-js/ir';
import { allocateElectricalNetwork } from './unified-ir/compiler/electrical-network';
import { generateResistiveSolver } from './unified-ir/compiler/resistive-solver';
import { createModuleValidation } from './unified-ir/validation';
import {
  ElectricalDefinitionError,
  prepareElectricalDevice,
  type ElectricalFactoryContext,
} from './electrical-authoring';

const definition = {
  properties: {
    resistance: { type: 'number', default: 1000, exclusiveMin: 0, unit: 'ohm' },
    image: { type: 'image', default: { src: 'image.png', mode: 'file' } },
  },
  pins: { A: { kind: 'signal', side: 'left' }, B: { kind: 'signal', side: 'right' } },
  resistors: { body: { pins: ['A', 'B'] } },
};

function factory(ctx: ElectricalFactoryContext): void {
  ctx.electrical.initializeResistor('body', {
    resistance: ctx.properties['resistance'] as number,
    enabled: true,
  });
}

function code(action: () => unknown, expected: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ElectricalDefinitionError);
  expect((caught as ElectricalDefinitionError).code).toBe(expected);
}

describe('electrical JSON and paired factory', () => {
  it('executes the RFC resistor JSON and paired JS example', async () => {
    const document = readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'docs', 'rfc', '0005-device-definition.md'),
      'utf8',
    );
    const jsonExamples = [...document.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(
      (match) => JSON.parse(match[1]!) as Record<string, unknown>,
    );
    const resistor = jsonExamples.find((example) => example['resistors'] !== undefined);
    expect(resistor).toBeDefined();
    const source = /```js\r?\n([\s\S]*?)```/.exec(document)?.[1];
    expect(source).toBeDefined();
    const url = `data:text/javascript,${encodeURIComponent(source!)}`;
    const { default: create } = (await import(/* @vite-ignore */ url)) as {
      default: (ctx: ElectricalFactoryContext) => void;
    };
    const prepared = prepareElectricalDevice(resistor, { resistance: 3300 }, create);
    expect(prepared.resistors['body']?.resistance).toBe(3300);
    expect(prepared.implementation).toBeUndefined();
    const linked = allocateElectricalNetwork([{ id: 'r1', prepared }], { VDD: { voltage: 5 } }, [
      [{ device: 'r1', pin: 'A' }, { source: 'VDD' }],
      [{ device: 'r1', pin: 'B' }, { source: 'GND' }],
    ]);
    const module = createIRModule();
    const solver = generateResistiveSolver(module, linked.network, 'rfc');
    const runtime = createIRJIT(module, {
      validation: createModuleValidation(module),
      jit: { tierUpThreshold: 0 },
    });
    runtime.execute(solver.solve, [], { instanceId: 'rfc-resistor', virtualTime: 0 });
    expect(runtime.storage.loadState(solver.fault)).toBe(0);
    expect(
      toNumber(runtime.storage.loadArray(solver.current, linked.resistors.get('r1')!.get('body')!)),
    ).toBeCloseTo(5 / 3300, 12);
  });
  it('initializes default and per-instance resistances without tick behavior', () => {
    const first = prepareElectricalDevice(definition, {}, factory);
    const second = prepareElectricalDevice(definition, { resistance: 2200 }, factory);
    expect(first.resistors['body']).toEqual({ pins: ['A', 'B'], resistance: 1000, enabled: true });
    expect(second.resistors['body']?.resistance).toBe(2200);
    expect(first.implementation).toBeUndefined();
    expect(Object.isFrozen(first.resistors['body']?.pins)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('closes retained initialization handles and freezes property snapshots', () => {
    let saved: ElectricalFactoryContext | undefined;
    prepareElectricalDevice(definition, {}, (ctx) => {
      saved = ctx;
      factory(ctx);
    });
    expect(Object.isFrozen(saved!.properties)).toBe(true);
    expect(Object.isFrozen(saved!.properties['image'])).toBe(true);
    expect(saved!.properties['image']).toEqual({ src: 'image.png', mode: 'file' });
    code(() => factory(saved!), 'electrical/factory-closed');
    expect(() => Object.assign(saved!.properties, { resistance: 5 })).toThrow(TypeError);
  });

  it('makes a private copy of initialized values', () => {
    const initial = { resistance: 1000, enabled: true };
    const prepared = prepareElectricalDevice(definition, {}, (ctx) => {
      ctx.electrical.initializeResistor('body', initial);
    });
    initial.resistance = 20;
    expect(prepared.resistors['body']?.resistance).toBe(1000);
  });

  it('requires every declared resistor to be initialized exactly once', () => {
    code(
      () => prepareElectricalDevice(definition, {}, () => {}),
      'electrical/missing-initialization',
    );
    code(
      () =>
        prepareElectricalDevice(definition, {}, (ctx) => {
          factory(ctx);
          factory(ctx);
        }),
      'electrical/duplicate-initialization',
    );
    code(
      () =>
        prepareElectricalDevice(definition, {}, (ctx) => {
          ctx.electrical.initializeResistor('missing', { resistance: 1, enabled: true });
        }),
      'electrical/unknown-resource',
    );
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid resistance %s before solving', (resistance) => {
    code(
      () =>
        prepareElectricalDevice(definition, {}, (ctx) => {
          ctx.electrical.initializeResistor('body', { resistance, enabled: true });
        }),
      'electrical/invalid-parameter',
    );
  });

  it('checks instance property constraints before invoking the factory', () => {
    let invoked = false;
    code(
      () =>
        prepareElectricalDevice(definition, { resistance: -1 }, () => {
          invoked = true;
        }),
      'electrical/invalid-parameter',
    );
    expect(invoked).toBe(false);
  });

  it('closes a factory even when it throws', () => {
    let saved: ElectricalFactoryContext | undefined;
    expect(() =>
      prepareElectricalDevice(definition, {}, (ctx) => {
        saved = ctx;
        throw new Error('factory failure');
      }),
    ).toThrow('factory failure');
    code(() => factory(saved!), 'electrical/factory-closed');
  });

  it('rejects asynchronous factories', () => {
    code(
      () => prepareElectricalDevice(definition, {}, async (ctx) => factory(ctx)),
      'electrical/invalid-definition',
    );
  });

  it.each([
    { ...definition, pins: { A: { kind: 'signal', direction: 'passive' }, B: { kind: 'signal' } } },
    { ...definition, resistors: { body: { pins: ['A', 'B'], resistance: 1000 } } },
    { ...definition, resistors: { body: { pins: ['A', 'B'], adjustable: false } } },
    { ...definition, resistors: { body: { pins: ['A', 'missing'] } } },
    { ...definition, resistors: { body: { pins: ['A', 'A'] } } },
    { ...definition, connections: ['contact'] },
  ])('rejects obsolete fields or invalid topology', (raw) => {
    code(() => prepareElectricalDevice(raw, {}, factory), 'electrical/invalid-definition');
  });

  it('accepts symmetric ideal contacts and preserves their initial states', () => {
    const raw = {
      pins: definition.pins,
      connections: { contact: { pins: ['A', 'B'], initial: 'closed' } },
    };
    const prepared = prepareElectricalDevice(raw, {}, () => {});
    expect(prepared.connections['contact']).toEqual({ pins: ['A', 'B'], initial: 'closed' });
  });

  it('initializes explicit pin parameters without a direction field', () => {
    const raw = { pins: { P0: { kind: 'signal' } } };
    const pin = {
      drive: { reference: { source: 'VDD' }, highResistance: 30, lowResistance: 25 },
      input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
    };
    const prepared = prepareElectricalDevice(raw, {}, (ctx) =>
      ctx.electrical.initializePin('P0', pin),
    );
    pin.drive.highResistance = 90;
    expect(prepared.pins['P0']?.drive?.highResistance).toBe(30);
  });

  it('checks pin resources, thresholds and duplicate initialization', () => {
    const raw = { pins: { P0: { kind: 'signal' } } };
    const pin = { input: { reference: { source: 'VDD' }, low: 0.7, high: 0.3 } };
    code(
      () => prepareElectricalDevice(raw, {}, (ctx) => ctx.electrical.initializePin('P0', pin)),
      'electrical/invalid-parameter',
    );
    pin.input.low = 0.2;
    code(
      () => prepareElectricalDevice(raw, {}, (ctx) => ctx.electrical.initializePin('P1', pin)),
      'electrical/unknown-resource',
    );
    code(
      () =>
        prepareElectricalDevice(raw, {}, (ctx) => {
          ctx.electrical.initializePin('P0', pin);
          ctx.electrical.initializePin('P0', pin);
        }),
      'electrical/duplicate-initialization',
    );
  });

  it('supports own-key resource IDs without prototype lookup', () => {
    const raw = JSON.parse(
      '{"pins":{"__proto__":{"kind":"signal"},"B":{"kind":"signal"}},"resistors":{"constructor":{"pins":["__proto__","B"]}}}',
    ) as unknown;
    const prepared = prepareElectricalDevice(raw, {}, (ctx) => {
      ctx.electrical.initializeResistor('constructor', { resistance: 10, enabled: true });
    });
    expect(Object.hasOwn(prepared.resistors, 'constructor')).toBe(true);
  });
});
