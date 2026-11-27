export const STEP = 10;
export const PIXEL = 0x5a3c;
export const CHECKPOINTS = Symbol.for('mica-js.simulator/checkpoints');

export function fixture(api, modelApi, kind, options = {}) {
  const { createDeviceBuilder, types } = modelApi;
  const { number, bool } = types;
  const {
    items = 16,
    periods,
    mutateAt,
    mutation = 'irq',
    competitorAt,
    observe = false,
    declareBatch = true,
    reportService = false,
    edgeCapacity = items * 2,
    initialCursor = 0,
    reportAddress = false,
  } = options;
  const nets = [];
  const builder = createDeviceBuilder({ name: kind });
  const state = (name, initial = 0) =>
    builder.state({ name, initial, type: typeof initial === 'boolean' ? bool : number });
  const memory = (name, length) => builder.memory({ name, length, public: true });
  const output = (name, type = number, capacity = 64) =>
    builder.channel({ name, type, capacity, direction: 'output' });
  const signal = (name) => builder.notification({ name, direction: 'output' });
  const fn = (name, body) => builder.fn({ name, params: [] }, body);
  const pc = (body) => body.readState('pc', number);
  const cursor = (body) => body.readState('cursor', number);
  state('pc');
  memory('code', 8);
  let configure;
  let end;

  if (kind === 'Lcd') {
    const length = items * 2;
    end = items * STEP;
    state('cursor', initialCursor);
    state('dirtyLast', -1);
    state('strobe', false);
    memory('pixels', length);
    output('edges', bool, edgeCapacity);
    if (reportAddress) output('address', number, items);
    output('observed', number, items);
    signal('frame');
    if (observe) {
      builder.on({ name: 'observeDirty', sourcePath: ['dirtyLast'] }, (body) =>
        body.send('observed', body.readState('dirtyLast', number)),
      );
    }
    if (mutateAt !== undefined) {
      builder.start((body) => {
        body.wait(mutateAt);
        body.store8('code', 0, 1);
      });
    }
    configure = (context) =>
      context.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        codeMetadata: () => ({ polling: [], delays: new Map() }),
        translate(input, block) {
          if (input.pc === 0) {
            if (declareBatch) input.markBatchLoop?.({ pc: 0 });
            block.instruction({ pc: 0, nextPc: 2 }, (body) => {
              const address = cursor(body);
              body.if(body.lessThan(address, length), (step) => {
                if (reportAddress) step.send('address', address);
                step.writeState('strobe', false);
                step.send('edges', false);
                step.store16be('pixels', address, PIXEL + input.code[0]);
                step.writeState('dirtyLast', address);
                step.send('edges', true);
                step.writeState('strobe', true);
                step.writeState('cursor', step.add(address, 2));
                step.redirect(0, STEP);
              });
            });
          } else {
            block.instruction({ pc: 2, nextPc: 4 }, (body) => {
              body.notify('frame');
              body.stop();
            });
          }
          return block.finish();
        },
      });
  } else if (kind === 'Dma') {
    const length = items * 2;
    const middle = length / 2;
    end = (items + 1) * STEP;
    state('cursor');
    state('remaining', length);
    state('srcAddress', 1000);
    state('dstAddress', 2000);
    state('flags');
    state('irq', false);
    state('stacked', -1);
    memory('src', length);
    memory('dst', length);
    output('irqEntry');
    output('counts');
    signal('half');
    signal('complete');
    builder.pureFn({ name: 'awake', params: [], returns: bool }, (body) =>
      body.returnValue(body.readState('irq', bool)),
    );
    fn('enterIrq', (body) => {
      body.writeState('stacked', body.add(pc(body), 2));
      body.writeState('pc', 4);
      body.writeState('irq', false);
    });
    builder.start((body) => {
      // Initializing the whole source models the already loaded SRAM image.
      for (let at = 0; at < Math.min(length, 32); at += 2) body.store16le('src', at, 0x1211);
      const copy = (limit) => {
        body.while(
          (test) => test.lessThan(cursor(test), limit),
          (step) => {
            const at = cursor(step);
            const next = step.add(at, 2);
            step.store16le('dst', at, step.load16le('src', at));
            step.writeState('srcAddress', step.add(at, 1002));
            step.writeState('dstAddress', step.add(at, 2002));
            step.writeState('remaining', step.subtract(length - 2, at));
            step.writeState('cursor', next);
            step.wait(STEP);
          },
        );
      };
      const interrupt = (name, flag) => {
        body.send('counts', body.readState('remaining', number));
        body.writeState('flags', flag);
        body.notify(name);
        body.writeState('irq', true);
      };
      copy(middle);
      interrupt('half', 1);
      body.wait(STEP);
      copy(length);
      interrupt('complete', 2);
    });
    if (mutateAt !== undefined) {
      builder.pin({ name: 'bus', low: 0.8, high: 2 });
      builder.reaction(
        {
          name: 'busWrite',
          sourcePath: ['bus', 'sample', 'level'],
          sourceType: types.logic,
          previous: 'before',
          current: 'level',
          captures: [],
        },
        {},
        (body, bindings) => {
          body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (step) =>
            step.store16le('src', 8, 0x7b6a),
          );
        },
      );
      nets.push(
        {
          id: 'bus',
          pins: [
            { instance: kind, pin: 'bus' },
            { instance: 'peer', pin: 'drive' },
          ],
        },
        { id: 'high', voltage: 3.3, pins: [{ instance: 'peer', pin: 'supply' }] },
      );
    }
    configure = (context) => {
      const half = declareBatch
        ? context.registerProcessBatch({ process: { kind: 'start', index: 0 }, loop: 0 })
        : undefined;
      const full = declareBatch
        ? context.registerProcessBatch({ process: { kind: 'start', index: 0 }, loop: 1 })
        : undefined;
      const jit = context.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        beforeInstruction: { when: 'irq', call: 'enterIrq' },
        polling: [{ pc: 0, predicate: 'awake' }],
        translate(input, block) {
          block.instruction({ pc: input.pc, nextPc: 0 }, (body) => {
            body.send('irqEntry', body.readState('stacked', number));
          });
          return block.finish();
        },
      });
      return {
        dispose() {
          jit.dispose();
          full?.dispose();
          half?.dispose();
        },
      };
    };
  } else if (kind === 'Parking') {
    end = periods === undefined ? 35 : periods * 15;
    state('clockRead', -1);
    state('irq', false);
    state('stacked', -1);
    memory('clock', 4);
    output('trace');
    fn('callTick', (body) => body.send('trace', 1));
    fn('loadTick', (body) => {
      const n = body.load32le('clock', 0);
      body.writeState('clockRead', n);
      body.send('trace', n);
    });
    fn('compare', (body) => {
      body.send('trace', 3);
      body.writeState('pc', 0);
    });
    if (reportService) {
      output('queuedService');
      output('startedService');
    }
    builder.fn({ name: 'advance', params: [{ name: 'elapsed', type: number }] }, (body, args) => {
      if (reportService) {
        body.send('queuedService', args.elapsed);
        body.writeState('pc', 7);
      }
    });
    fn('enterIrq', (body) => {
      body.writeState('stacked', pc(body));
      body.writeState('pc', 6);
      body.writeState('irq', false);
    });
    builder.pureFn({ name: 'ready', params: [], returns: bool }, (body) =>
      body.returnValue(body.readState('irq', bool)),
    );
    builder.pureFn({ name: 'delay', params: [], returns: number }, (body) => body.returnValue(15));
    builder.start((body) => {
      body.store32le('clock', 0, 0x12345678);
      if (mutateAt !== undefined) {
        body.wait(mutateAt);
        body.send('trace', body.readState('clockRead', number));
        if (mutation === 'code') body.store8('code', 0, 1);
        else body.writeState('irq', true);
      }
    });
    configure = (context) =>
      context.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        beforeInstruction: { when: 'irq', call: 'enterIrq' },
        codeMetadata: ({ region }) => ({
          delays: new Map(),
          polling:
            declareBatch && region.code[0] === 0
              ? [
                  {
                    pc: 0,
                    predicate: 'ready',
                    wait: {
                      delay: 'delay',
                      advance: 'advance',
                      checkpoints: [
                        { at: 0, nextPc: 2, call: 'callTick' },
                        { at: 5, nextPc: 4, call: 'loadTick' },
                        { at: 10, nextPc: 5, resumePc: 0, call: 'compare' },
                      ],
                    },
                  },
                ]
              : [],
        }),
        translate(input, block) {
          if (input.pc === 0) {
            block.instruction({ pc: 0, nextPc: 2 }, (body) => {
              body.call('callTick');
              body.elapse(5);
            });
          } else if (input.pc === 2) {
            block.instruction({ pc: 2, nextPc: 4 }, (body) => {
              body.call('loadTick');
              body.elapse(5);
            });
          } else if (input.pc === 4) {
            block.instruction({ pc: 4, nextPc: 5 }, (body) => {
              if (input.code[0] === 0) body.call('compare');
              else body.send('trace', 33);
              body.redirect(0, 5);
            });
          } else if (input.pc === 7 && reportService) {
            block.instruction({ pc: 7, nextPc: 7 }, (body) => {
              body.send('startedService', pc(body));
              body.stop();
            });
          } else {
            block.instruction({ pc: 6, nextPc: 6 }, (body) => {
              body.send('trace', body.readState('stacked', number));
              body.stop();
            });
          }
          return block.finish();
        },
      });
  } else {
    throw new RangeError(`Unknown fixture ${kind}`);
  }

  let session;
  const entries = [
    {
      id: kind,
      model: builder.finish(),
      create(current) {
        const currentSession = session;
        currentSession.context = current;
        const registration = configure(current);
        return {
          sync(batch) {
            currentSession.deliveries.push(batch);
          },
          dispose() {
            registration.dispose();
          },
        };
      },
    },
  ];
  const instances = [{ id: kind, type: kind }];
  if (competitorAt !== undefined || nets.length !== 0) {
    const competitor = createDeviceBuilder({ name: 'OtherMaster' });
    competitor.memory({ name: 'code', length: 2 });
    competitor.state({ name: 'pc', initial: 0, type: number });
    competitor.channel({ name: 'other', type: number, capacity: 1, direction: 'output' });
    if (nets.length !== 0) {
      competitor.pin({ name: 'drive' });
      competitor.pin({ name: 'supply' });
      competitor.start((body) => {
        body.wait(mutateAt);
        body.writeIntent('drive', body.combineIntents(body.resistor(body.pin('supply'), 1000)));
      });
    }
    entries.push({
      id: 'peer',
      model: competitor.finish(),
      create(peer) {
        const currentSession = session;
        const jit =
          competitorAt === undefined
            ? undefined
            : peer.attachJit({
                entry: 'peer',
                code: 'code',
                pc: 'pc',
                translate(input, block) {
                  if (input.pc === 0)
                    block.instruction({ pc: 0, nextPc: 1 }, (body) => body.elapse(competitorAt));
                  else
                    block.instruction({ pc: 1, nextPc: 1 }, (body) => {
                      body.send('other', 1);
                      body.stop();
                    });
                  return block.finish();
                },
              });
        return {
          sync(batch) {
            currentSession.deliveries.push(batch);
          },
          dispose() {
            jit?.dispose();
          },
        };
      },
    });
    instances.push({ id: 'peer', type: 'peer' });
  }
  const library = api.createDeviceLibrary(entries);
  return {
    end,
    create(batchExecution) {
      const currentSession = { context: undefined, deliveries: [] };
      session = currentSession;
      let board;
      try {
        board = api.createBoard(library, { instances, nets }, { batchExecution });
      } finally {
        session = undefined;
      }
      const { context, deliveries } = currentSession;
      return {
        board,
        deliveries,
        snapshot() {
          // Only differential runs read the internal state bank. Bytes and output
          // timestamps come from the actual public context and adapter.
          const states = Object.fromEntries(board.instances[0].states);
          const bytes = Object.fromEntries(
            Object.entries(context.memory).map(([name, view]) => [name, [...view]]),
          );
          return { time: board.time, states, bytes, outputs: deliveries.splice(0) };
        },
      };
    },
  };
}
