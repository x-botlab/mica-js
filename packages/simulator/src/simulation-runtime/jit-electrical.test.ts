import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { JitTranslate } from '../types';

describe('throughput JIT electrical effects', () => {
  it('preserves pin transitions after the direct program is warm', () => {
    const driverBuilder = createDeviceBuilder({ name: 'PinTransitionDriver' });
    driverBuilder.pin({ name: 'out' });
    driverBuilder.pin({ name: 'vcc' });
    driverBuilder.pin({ name: 'gnd' });
    driverBuilder.memory({ name: 'code', length: 4 });
    driverBuilder.state({ name: 'pc', type: types.number, initial: 0 });

    const probeBuilder = createDeviceBuilder({ name: 'PinTransitionProbe' });
    probeBuilder.pin({ name: 'in', low: 0.8, high: 2 });
    probeBuilder.channel({
      name: 'edges',
      direction: 'output',
      type: types.number,
      capacity: 8,
      overflow: types.overflow.members.drop_oldest,
    });
    probeBuilder.derived({ name: 'level', type: types.logic }, (body) => {
      body.returnValue(body.field(body.readSample('in'), 'level'));
    });
    probeBuilder.on({ name: 'observe', sourcePath: ['level'] }, (body) => {
      const level = body.readDerived('level', types.logic);
      const high = body.equal(
        types.logic,
        level,
        body.constant(types.logic, types.logic.members.high),
      );
      const low = body.equal(
        types.logic,
        level,
        body.constant(types.logic, types.logic.members.low),
      );
      body.if(
        high,
        (on) => on.send('edges', on.constant(types.number, 1)),
        (off) => off.if(low, (on) => on.send('edges', on.constant(types.number, 0))),
      );
    });

    const observed: number[] = [];
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: (pc + 1) % 4 }, (body) => {
        const target = pc % 2 === 0 ? 'vcc' : 'gnd';
        body.writeIntent('out', body.resistor(target, body.constant(types.number, 25)));
        body.elapse(body.constant(types.number, 1));
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'cpu',
        model: driverBuilder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            pc: 'pc',
            translate,
          });
          context.loadBytes('code', new Uint8Array(4));
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
      {
        id: 'probe',
        model: probeBuilder.finish(),
        create: () => ({
          sync(batch: {
            readonly outputs: {
              readonly edges: readonly { readonly value: unknown }[];
            };
          }) {
            observed.push(...batch.outputs.edges.map(({ value }) => value as number));
          },
          dispose() {},
        }),
      },
    ]);

    const board = createBoard(
      library,
      {
        instances: [
          { id: 'cpu', type: 'cpu' },
          { id: 'probe', type: 'probe' },
        ],
        nets: [
          { id: 'vcc', pins: [{ instance: 'cpu', pin: 'vcc' }], voltage: 5 },
          { id: 'gnd', pins: [{ instance: 'cpu', pin: 'gnd' }], voltage: 0 },
          {
            id: 'signal',
            pins: [
              { instance: 'cpu', pin: 'out' },
              { instance: 'probe', pin: 'in' },
            ],
          },
        ],
      },
      { execution: 'throughput' },
    );

    try {
      board.runUntil(4);
      observed.length = 0;
      board.runUntil(8);
      expect(observed).toEqual([1, 0, 1, 0]);
    } finally {
      board.dispose();
    }
  });
});
