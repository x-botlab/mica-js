import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pinDriver } from '../../../../tests/conformance/devices/smoke-support.mjs';

export const physicalNames = ['sram', 'pwm', 'electrical-chain', 'electrical-independent'];
const fixture = (name) =>
  readFile(
    new URL(`../../../../tests/conformance/devices/${name}/${name}.ddl`, import.meta.url),
    'utf8',
  );
const endpoint = (instance, pin) => ({ instance, pin });
const rails = (ids) => [
  { id: 'supply', voltage: 3.3, pins: ids.map((id) => endpoint(id, 'supply')) },
  { id: 'reference', voltage: 0, pins: ids.map((id) => endpoint(id, 'reference')) },
];
const passive = () => ({ sync() {}, dispose() {} });

async function prepareSram({ size, compile, createDeviceLibrary, createBoard }) {
  const pins = [
    'a0',
    'a1',
    'selected',
    'writeEnable',
    'outputEnable',
    ...Array.from({ length: 8 }, (_, i) => `d${i}`),
  ];
  const data = pins.slice(5);
  const memoryModel = await compile(await fixture('asynchronous-sram'));
  const {
    entry: { model: driverModel },
  } = await pinDriver({ compileDDL: compile }, pins);
  const monitorModel = await compile(`device BusMonitor {
    ${data.map((pin) => `pin ${pin}(low: 0.8, high: 2.0);`).join('\n')}
    public memory evidence[2];
    record Bus { value: number; known: bool; }
    derived bus: Bus = {
      value: ${data.map((pin, i) => `((${pin}.sample.level == Logic.high ? 1 : 0) << ${i})`).join(' + ')},
      known: ${data.map((pin) => `${pin}.sample.level != Logic.unknown`).join(' && ')}
    };
    fn publish(value: Bus) { store8(evidence, 0, value.value); store8(evidence, 1, value.known ? 1 : 0); }
    process start { publish(bus); }
    reaction changed on bus as (previous, current) { publish(current); }
  }`);
  let active;
  const library = createDeviceLibrary([
    { id: 'sram', model: memoryModel, create: passive },
    {
      id: 'driver',
      model: driverModel,
      create(ctx) {
        active.drivers.push(ctx);
        return passive();
      },
    },
    {
      id: 'monitor',
      model: monitorModel,
      create(ctx) {
        active.monitors.push(ctx.memory.evidence);
        return passive();
      },
    },
  ]);
  const instances = Array.from({ length: size }, (_, i) => [
    { id: `ram${i}`, type: 'sram' },
    { id: `driver${i}`, type: 'driver' },
    { id: `monitor${i}`, type: 'monitor' },
  ]).flat();
  const nets = [
    ...rails(instances.filter(({ type }) => type !== 'monitor').map(({ id }) => id)),
    ...Array.from({ length: size }, (_, i) =>
      pins.map((pin) => ({
        id: `${i}-${pin}`,
        pins: [
          endpoint(`ram${i}`, pin),
          endpoint(`driver${i}`, pin),
          ...(data.includes(pin) ? [endpoint(`monitor${i}`, pin)] : []),
        ],
      })),
    ).flat(),
  ];
  const transactions = 8;
  return {
    unit: 'readWritePairs',
    description:
      'Real four-byte SRAMs; host bus drive, electrical solve, reactions and instrumented bus reads included.',
    create() {
      active = { drivers: [], monitors: [] };
      const state = active;
      const board = createBoard(library, { instances, nets });
      let actual = [];
      const drive = (address, writing, output, values) => {
        for (let i = 0; i < size; i++)
          state.drivers[i].inputs.command.send({
            value: address | 4 | (writing ? 8 : 0) | (output ? 16 : 0) | ((values?.[i] ?? 0) << 5),
            mask: 31 | (values ? 255 << 5 : 0),
          });
        board.runUntil(board.time + 1);
      };
      return {
        board,
        operationsPerStep: size * transactions,
        initialize() {
          board.runUntil(0);
        },
        step(index) {
          actual = [];
          for (let transaction = 0; transaction < transactions; transaction++) {
            const address = transaction % 4;
            const values = Array.from(
              { length: size },
              (_, i) => (index * 17 + transaction * 29 + i * 53) & 255,
            );
            drive(address, true, false, values);
            drive(address, false, false, values);
            drive(address, false, true, null);
            actual.push(state.monitors.map((bytes) => [bytes[0], bytes[1]]));
            drive(address, false, false, null);
          }
        },
        verify(completed) {
          assert.equal(board.status, 'ready');
          assert.equal(board.time, completed * transactions * 4);
          for (let transaction = 0; transaction < transactions; transaction++) {
            for (let i = 0; i < size; i++)
              assert.deepEqual(actual[transaction][i], [
                ((completed - 1) * 17 + transaction * 29 + i * 53) & 255,
                1,
              ]);
          }
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

async function preparePwm({ size, compile, createDeviceLibrary, createBoard }) {
  const pwmModel = await compile(await fixture('counter-pwm'));
  const monitorModel = await compile(`device LevelMonitor {
    pin input(low: 0.8, high: 2.0);
    public memory evidence[1];
    fn publish(value: sample) { store8(evidence, 0, value.level == Logic.high ? 1 : 0); }
    process start { publish(input.sample); }
    reaction changed on input.sample as (previous, current) { publish(current); }
  }`);
  let active;
  const library = createDeviceLibrary([
    {
      id: 'pwm',
      model: pwmModel,
      create(ctx) {
        const state = active;
        const index = state.contexts.length;
        state.contexts.push(ctx);
        return {
          sync(batch) {
            if (batch.outputs.wrapped) {
              state.wraps[index]++;
              state.lastWrap[index] = batch.outputs.wrapped.time;
            }
          },
          dispose() {},
        };
      },
    },
    {
      id: 'monitor',
      model: monitorModel,
      create(ctx) {
        active.monitors.push(ctx.memory.evidence);
        return passive();
      },
    },
  ]);
  const instances = Array.from({ length: size }, (_, i) => [
    { id: `pwm${i}`, type: 'pwm', props: { tickPeriod: 2, initialDuty: 128 } },
    { id: `monitor${i}`, type: 'monitor' },
  ]).flat();
  const nets = [
    ...rails(Array.from({ length: size }, (_, i) => `pwm${i}`)),
    ...Array.from({ length: size }, (_, i) => ({
      id: `out${i}`,
      pins: [endpoint(`pwm${i}`, 'pwm'), endpoint(`monitor${i}`, 'input')],
    })),
  ];
  const duties = [0, 1, 128, 256];
  return {
    unit: 'timerTicks',
    description:
      'Real PWM counters; buffered duty updates, register stores, electrical edges and observation reactions included.',
    create() {
      active = {
        contexts: [],
        monitors: [],
        wraps: Array(size).fill(0),
        lastWrap: Array(size).fill(0),
      };
      const state = active;
      const board = createBoard(library, { instances, nets });
      return {
        board,
        operationsPerStep: size * 256,
        initialize() {
          board.runUntil(0);
        },
        step(index) {
          for (let i = 0; i < size; i++)
            state.contexts[i].inputs.duty.send(duties[(index + i) % duties.length]);
          board.runUntil(board.time + 512);
        },
        verify(completed) {
          assert.equal(board.status, 'ready');
          assert.equal(board.time, completed * 512);
          for (let i = 0; i < size; i++) {
            const duty = duties[(completed - 1 + i) % duties.length];
            assert.deepEqual(
              [...state.contexts[i].memory.registers],
              [0, 0, duty & 255, duty >> 8],
            );
            assert.equal(state.monitors[i][0], duty > 0 ? 1 : 0);
            assert.equal(state.wraps[i], completed);
            assert.equal(state.lastWrap[i], board.time);
          }
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

async function prepareElectrical(name, { size, compile, createDeviceLibrary, createBoard }) {
  const nodes = size * 8;
  const chain = name === 'electrical-chain';
  const model = await compile(`device ElectricalBenchmark {
    pin supply; pin reference;
    ${Array.from(
      { length: nodes },
      (_, i) =>
        `pin n${i} = [${
          chain
            ? [
                i === 0 ? 'resistor(to: reference, resistance: 1000)' : '',
                i + 1 < nodes
                  ? `resistor(to: n${i + 1}, resistance: 1000)`
                  : 'resistor(to: supply, resistance: 1000)',
              ]
                .filter(Boolean)
                .join(', ')
            : 'resistor(to: reference, resistance: 1000), resistor(to: supply, resistance: 1000)'
        }];`,
    ).join('\n')}
    input channel resistance: number(capacity: 1);
    record Reading { index: number; voltage: number; }
    output channel readings: Reading(capacity: ${nodes * 2});
    fn publish(index: number, raw: sample) {
      const voltage = raw.voltage;
      if voltage != none {
        readings.send({ index: index, voltage: voltage });
      } else {
        assert false, "Referenced network must have a voltage";
      }
    }
    process start {
      ${Array.from({ length: nodes }, (_, i) => `publish(${i}, n${i}.sample);`).join('\n')}
      loop {
        const value = await resistance.receive();
        ${chain ? `n${nodes - 1}.intent <- [resistor(to: supply, resistance: value)];` : Array.from({ length: nodes }, (_, i) => `n${i}.intent <- [resistor(to: reference, resistance: 1000), resistor(to: supply, resistance: value)];`).join('\n')}
      }
    }
    ${Array.from({ length: nodes }, (_, i) => `reaction observe${i} on n${i}.sample as (previous, current) { publish(${i}, current); }`).join('\n')}
  }`);
  let active;
  const library = createDeviceLibrary([
    {
      id: 'network',
      model,
      create(ctx) {
        const state = active;
        state.context = ctx;
        return {
          sync(batch) {
            state.readings.push(...batch.outputs.readings);
          },
          dispose() {},
        };
      },
    },
  ]);
  return {
    unit: 'nodeUpdates',
    description: `${nodes} unknown nodes in ${chain ? 'one connected resistor chain' : 'independent voltage dividers'}; resistance changes force new matrices; public samples checked against closed form.`,
    create() {
      active = { context: null, readings: [], sampleTime: 0 };
      const state = active;
      const board = createBoard(library, {
        instances: [{ id: 'network', type: 'network' }],
        nets: rails(['network']),
      });
      const check = (ratio) => {
        assert.equal(state.readings.length, nodes);
        const seen = new Set();
        for (const { value, time } of state.readings) {
          assert.equal(time, state.sampleTime);
          assert(!seen.has(value.index));
          assert(value.index >= 0 && value.index < nodes);
          seen.add(value.index);
          const expected = chain ? (3.3 * (value.index + 1)) / (nodes + ratio) : 3.3 / (1 + ratio);
          assert.ok(
            Math.abs(value.voltage - expected) <= 1e-9,
            `${value.index}: ${value.voltage} != ${expected}`,
          );
        }
        assert.equal(board.status, 'ready');
      };
      return {
        board,
        operationsPerStep: nodes,
        initialize() {
          board.runUntil(0);
          check(1);
        },
        step(index) {
          state.readings.length = 0;
          state.sampleTime = board.time;
          state.context.inputs.resistance.send(index % 2 === 0 ? 2000 : 1000);
          board.runUntil(board.time + 1);
        },
        verify(completed) {
          assert.equal(board.time, completed);
          check(completed % 2 === 1 ? 2 : 1);
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

export async function preparePhysical(name, tools) {
  if (name === 'sram') return prepareSram(tools);
  if (name === 'pwm') return preparePwm(tools);
  assert(physicalNames.includes(name), `Unknown physical workload: ${name}`);
  return prepareElectrical(name, tools);
}
