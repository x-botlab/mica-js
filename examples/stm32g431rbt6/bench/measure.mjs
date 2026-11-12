import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { model, create } from '../dist/devices/stm32g431rbt6/device.js';

/**
 * 临时测量脚本：与 bench/perf.test.ts 同构，但用进程 CPU 时间读数，
 * 避免宿主负载导致的挂钟抖动。
 */

const DIR = import.meta.dirname;
const firmware = new Uint8Array(
  readFileSync(join(DIR, '..', 'test', 'fixtures', 'gpio-blink.bin')),
);
const systickFirmware = new Uint8Array(
  readFileSync(join(DIR, '..', 'test', 'fixtures', 'systick.bin')),
);

const PROBE_MODEL = `
device TestProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 64, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high { level.send(1); }
    else if p.sample.level == Logic.low { level.send(0); }
    else { level.send(2); }
  }
  process start { report(); }
  reaction changed on p.sample.level as (previous, next) { report(); }
}
`;
const SOURCE_MODEL = `
device TestSource(outputResistance: number default 25) {
  pin y;
  pin vcc;
  pin gnd;
  input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
  state wanted: number = 2;
  fn apply() {
    if wanted == 1 { y.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
    else if wanted == 0 { y.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
    else { y.intent <- []; }
  }
  process start { apply(); loop { wanted = await level.receive(); apply(); } }
}
`;

const probeModel = await compileDDL(PROBE_MODEL);
const sourceModel = await compileDDL(SOURCE_MODEL);

const NOOP = () => ({ sync() {}, dispose() {} });
const PINS = ['PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PA8', 'PA9', 'PA10'];
const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];

function benchBoard(clock, code) {
  const entries = [
    { id: 'mcu', model, create },
    ...PINS.map((pin) => ({ id: `probe_${pin}`, model: probeModel, create: NOOP })),
    ...PINS.map((pin) => ({ id: `src_${pin}`, model: sourceModel, create: NOOP })),
  ];
  const instances = [
    { id: 'mcu', type: 'mcu', props: { firmware: code, clockFrequency: clock } },
    ...PINS.map((pin) => ({ id: `probe_${pin}`, type: `probe_${pin}` })),
    ...PINS.map((pin) => ({ id: `src_${pin}`, type: `src_${pin}` })),
  ];
  const nets = [
    {
      id: 'vdd',
      pins: [
        ...VDD.map((pin) => ({ instance: 'mcu', pin })),
        ...PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'vcc' })),
      ],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        ...VSS.map((pin) => ({ instance: 'mcu', pin })),
        ...PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'gnd' })),
      ],
      voltage: 0,
    },
    ...PINS.map((pin) => ({
      id: pin,
      pins: [
        { instance: 'mcu', pin },
        { instance: `probe_${pin}`, pin: 'p' },
        { instance: `src_${pin}`, pin: 'y' },
      ],
    })),
  ];

  return createBoard(createDeviceLibrary(entries), { instances, nets });
}

function bareBoard(clock, code) {
  return createBoard(createDeviceLibrary([{ id: 'mcu', model, create }]), {
    instances: [{ id: 'mcu', type: 'mcu', props: { firmware: code, clockFrequency: clock } }],
    nets: [
      { id: 'vdd', pins: VDD.map((pin) => ({ instance: 'mcu', pin })), voltage: 3.3 },
      { id: 'vss', pins: VSS.map((pin) => ({ instance: 'mcu', pin })), voltage: 0 },
    ],
  });
}

const cpuMs = (fn) => {
  const before = process.cpuUsage();

  fn();

  const usage = process.cpuUsage(before);

  return (usage.user + usage.system) / 1000;
};

// --- 1. bench 同构：1 MHz，20 ms 预热，500 ms 测量 ---
{
  const cold = [];
  const steady = [];

  for (let round = 0; round < 3; round += 1) {
    let board;
    const coldMs = cpuMs(() => {
      board = benchBoard(1_000_000, firmware);
      board.runUntil(0);
      board.runUntil(20_000_000_000);
    });
    const steadyMs = cpuMs(() => board.runUntil(board.time + 500_000_000_000));

    cold.push(coldMs);
    steady.push(steadyMs);
    board.dispose();
  }

  console.log(
    'BENCH',
    JSON.stringify({
      clockMHz: 1,
      coldMs: Number(Math.min(...cold).toFixed(0)),
      wallMs: Number(Math.min(...steady).toFixed(0)),
      slowdown: Number((Math.min(...steady) / 500).toFixed(2)),
    }),
  );
}

// --- 2. 裸板多主频：100 ms 仿真，3 轮 ---
for (const [name, code] of [
  ['blink', firmware],
  ['systick', systickFirmware],
]) {
  for (const clock of [1_000_000, 16_000_000, 80_000_000, 100_000_000, 170_000_000]) {
    const board = bareBoard(clock, code);
    const samples = [];

    board.runUntil(0);
    board.runUntil(20_000_000_000);

    for (let round = 0; round < 3; round += 1) {
      samples.push(cpuMs(() => board.runUntil(board.time + 100_000_000_000)));
    }

    const ms = Math.min(...samples);

    console.log(
      'BARE',
      JSON.stringify({
        firmware: name,
        clockMHz: clock / 1e6,
        wallMs: Number(ms.toFixed(1)),
        slowdown: Number((ms / 100).toFixed(2)),
        mips: Number((((clock / 1e6) * 0.1) / (ms / 1000)).toFixed(2)),
      }),
    );
    board.dispose();
  }
}
