import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as bus from './stm32g431/bus.mjs';
import { createThumbTranslator, cpuInitialState } from './stm32g431/cpu.mjs';
import {
  DEFAULT_CYCLE_PS,
  FLASH_BASE,
  FLASH_SIZE,
  RESET_PC,
  STACK_TOP,
} from './stm32g431/constants.mjs';
import { modelFor, readSnapshot } from './stm32g431/model.mjs';
import { firmwareFor, workloadNames } from './stm32g431/firmware/index.mjs';
import { createReference } from './stm32g431/reference.mjs';
import { profileInstructions } from './stm32g431/profile.mjs';

export { workloadNames };
export const defaults = Object.freeze({
  workload: 'alu-branch',
  cyclePs: DEFAULT_CYCLE_PS,
  execution: 'throughput',
  memoryAccess: 'bytes',
  blockSize: 8,
});

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
}

export function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('STM32 options must be an object');
  for (const name of Object.keys(options))
    if (!Object.hasOwn(defaults, name)) throw new TypeError(`Unknown STM32 option: ${name}`);
  const config = { ...defaults, ...options };
  if (!workloadNames.includes(config.workload)) throw new RangeError('Unknown STM32 workload');
  integer(config.cyclePs, 1, 1_000_000, 'cyclePs');
  integer(config.blockSize, 1, 8, 'blockSize');
  if (!['throughput', 'precise'].includes(config.execution))
    throw new RangeError('Invalid execution mode');
  if (!['bytes', 'wide'].includes(config.memoryAccess))
    throw new RangeError('Invalid memory access mode');
  return Object.freeze(config);
}

export function create(sdk, options = {}) {
  const config = normalizeOptions(options);
  const firmware = firmwareFor(config.workload);
  if (
    !(firmware.bytes instanceof Uint8Array) ||
    firmware.bytes.length < 8 ||
    firmware.bytes.length > FLASH_SIZE
  )
    throw new RangeError('Firmware must contain a vector table within Flash');
  const vectors = new DataView(
    firmware.bytes.buffer,
    firmware.bytes.byteOffset,
    firmware.bytes.byteLength,
  );
  assert.equal(vectors.getUint32(0, true), STACK_TOP, 'Initial MSP');
  assert.equal(vectors.getUint32(4, true), RESET_PC | 1, 'Thumb reset vector');
  const { model, fields } = modelFor(config);
  const instructions = new Map();
  let translations = 0;
  let translateMs = 0;
  let context;
  let disposed = false;
  const gpioWrites = [];
  const translate = createThumbTranslator({ ...config, bus });
  const library = sdk.createDeviceLibrary([
    {
      id: 'stm32g431-benchmark',
      model,
      create(ctx) {
        context = ctx;
        const registration = ctx.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          beforeInstruction: { when: 'takeIrq', call: 'enterIrq' },
          translate(input, builder) {
            const started = performance.now();
            try {
              const block = translate(input, builder);
              translations++;
              for (const instruction of block.instructions)
                if (!instructions.has(instruction.pc))
                  instructions.set(instruction.pc, instruction);
              return block;
            } finally {
              translateMs += performance.now() - started;
            }
          },
        });
        try {
          ctx.loadBytes('code', firmware.bytes);
          return {
            sync(batch) {
              gpioWrites.push(...(batch.outputs.gpioChanged ?? []));
            },
            dispose() {
              registration.dispose();
            },
          };
        } catch (error) {
          registration.dispose();
          throw error;
        }
      },
    },
  ]);
  const board = sdk.createBoard(
    library,
    {
      instances: [{ id: 'mcu', type: 'stm32g431-benchmark', props: { firmware: firmware.bytes } }],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: [{ instance: 'mcu', pin: 'supply' }] },
        { id: 'vss', voltage: 0, pins: [{ instance: 'mcu', pin: 'reference' }] },
        { id: 'pa5', pins: [{ instance: 'mcu', pin: 'pa5' }] },
      ],
    },
    { execution: config.execution },
  );
  const reference = createReference({ firmware, cyclePs: config.cyclePs });
  const valid = () => {
    if (disposed) throw new Error('STM32 benchmark is disposed');
  };
  let cycles = 0;
  return {
    board,
    model,
    config,
    firmware,
    get progress() {
      return { cycles, time: board.time };
    },
    step(count) {
      valid();
      integer(count, 1, 2_000_000, 'cycles');
      integer(cycles + count, 1, 10_000_000, 'cumulative cycles');
      assert.equal(board.time, cycles * config.cyclePs, 'Advance the benchmark using step()');
      const from = board.time;
      const to = (cycles + count) * config.cyclePs;
      const started = performance.now();
      board.runUntil(to);
      const wallMs = performance.now() - started;
      cycles += count;
      return { from, to, cycles: count, wallMs };
    },
    capture() {
      valid();
      context.inputs.snapshotRequest.notify();
      board.runUntil(board.time);
      return {
        time: board.time,
        states: readSnapshot(context.memory.snapshot, fields),
        ram: Uint8Array.from(context.memory.ram),
        gpioWrites: gpioWrites.map((write) => ({ ...write })),
      };
    },
    verify() {
      valid();
      const expected = reference.advance(board.time);
      const actual = this.capture();
      assert.equal(board.status, 'ready');
      for (const name of Object.keys(cpuInitialState))
        assert.equal(actual.states[name], expected.states[name], `${name} at ${board.time}ps`);
      const peripheral = [
        ['gpioModer', expected.states.gpioa.moder],
        ['gpioOdr', expected.states.gpioa.odr],
        ['rccAhb2enr', expected.states.rcc.ahb2enr],
        ['systickReload', expected.states.systick.load],
        ['systickCountflag', Number(expected.states.systick.countflag)],
        ['systickTicks', expected.states.systick.ticks],
        ['irqPending', expected.states.systick.pending],
        ['vtor', expected.states.vtor],
      ];
      for (const [name, value] of peripheral)
        assert.equal(actual.states[name], value, `${name} at ${board.time}ps`);
      assert.equal(
        actual.states.systickCtrl & 7,
        expected.states.systick.ctrl & 7,
        `SYST_CSR at ${board.time}ps`,
      );
      assert.deepEqual(actual.ram, expected.ram, `SRAM at ${board.time}ps`);
      assert.equal(
        actual.states.pa5Level,
        expected.pa5Level,
        `PA5 electrical level at ${board.time}ps`,
      );
      assert.deepEqual(
        actual.gpioWrites.map(({ time, value }) => ({ time, value })),
        expected.gpioWrites.map(({ time, odr }) => ({ time, value: odr })),
        `GPIO output writes at ${board.time}ps`,
      );
      return {
        ...actual,
        instructionsIssued: expected.instructionsIssued,
        exceptionEntries: expected.exceptionEntries,
      };
    },
    profile() {
      valid();
      return {
        translations,
        translateMs,
        ...profileInstructions([...instructions.values()], model),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      board.dispose();
    },
  };
}

export function parseArgs(args) {
  const options = {
    workload: 'all',
    samples: 3,
    cycles: 2_000,
    warmup: 5_000,
    coldCycles: 1_024,
    execution: 'throughput',
    memoryAccess: 'bytes',
  };
  for (const arg of args) {
    if (arg === '--smoke')
      Object.assign(options, { samples: 1, cycles: 2_048, warmup: 512, coldCycles: 256 });
    else if (arg === '--json') continue;
    else if (arg.startsWith('--workload=')) options.workload = arg.slice(11);
    else if (arg.startsWith('--execution=')) options.execution = arg.slice(12);
    else if (arg.startsWith('--memory-access=')) options.memoryAccess = arg.slice(16);
    else {
      const match = /^--(samples|cycles|warmup|cold-cycles)=(\d+)$/.exec(arg);
      if (!match) throw new TypeError(`Unknown argument: ${arg}`);
      options[match[1] === 'cold-cycles' ? 'coldCycles' : match[1]] = Number(match[2]);
    }
  }
  if (options.workload !== 'all' && !workloadNames.includes(options.workload))
    throw new RangeError('Unknown workload');
  integer(options.samples, 1, 20, 'samples');
  integer(options.cycles, 1, 2_000_000, 'cycles');
  integer(options.warmup, 0, 2_000_000, 'warmup');
  integer(options.coldCycles, 1, 2_000_000, 'cold cycles');
  integer(
    options.coldCycles + options.warmup + options.samples * options.cycles,
    1,
    10_000_000,
    'total cycles',
  );
  normalizeOptions({
    workload: options.workload === 'all' ? workloadNames[0] : options.workload,
    execution: options.execution,
    memoryAccess: options.memoryAccess,
  });
  return options;
}

export function measure(sdk, options) {
  const results = [];
  const workloads = options.workload === 'all' ? workloadNames : [options.workload];
  for (const workload of workloads) {
    const setupStarted = performance.now();
    const bench = create(sdk, {
      workload,
      execution: options.execution,
      memoryAccess: options.memoryAccess,
    });
    const setupMs = performance.now() - setupStarted;
    try {
      const cold = bench.step(options.coldCycles);
      bench.verify();
      if (options.warmup) {
        bench.step(options.warmup);
        bench.verify();
      }
      let previous = bench.verify();
      const samples = [];
      for (let index = 0; index < options.samples; index++) {
        const sample = bench.step(options.cycles);
        const current = bench.verify();
        const instructionsIssued = current.instructionsIssued - previous.instructionsIssued;
        samples.push({
          ...sample,
          instructionsIssued,
          guestMipsIssued: instructionsIssued / (sample.wallMs * 1000),
        });
        previous = current;
      }
      const wallMs = samples.reduce((sum, sample) => sum + sample.wallMs, 0);
      const instructionsIssued = samples.reduce(
        (sum, sample) => sum + sample.instructionsIssued,
        0,
      );
      results.push({
        workload,
        config: bench.config,
        firmware: {
          bytes: bench.firmware.bytes.length,
          sha256: createHash('sha256').update(bench.firmware.bytes).digest('hex'),
          flashBase: FLASH_BASE,
        },
        setupMs,
        cold,
        samples,
        steady: {
          wallMs,
          instructionsIssued,
          guestMipsIssued: instructionsIssued / (wallMs * 1000),
        },
        exceptionEntries: previous.exceptionEntries,
        gpioWrites: previous.gpioWrites.length,
        profile: bench.profile(),
      });
    } finally {
      bench.dispose();
    }
  }
  return {
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      flags: process.execArgv,
    },
    timing:
      'Simplified instruction-cycle model; guestMipsIssued counts guest instruction starts, excluding hardware exception entry. Only runUntil is timed; verification and offline profiles are untimed.',
    results,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2));
  const sdk = await import('../dist/index.js');
  console.log(JSON.stringify(measure(sdk, options), null, 2));
}
