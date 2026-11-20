import { createBoardWith, US } from '../harness.ts';
import type { TestBoard } from '../harness.ts';

/**
 * 红外数据链路的测试夹具。
 *
 * 发射端只输出「载波是否开启」的逻辑流；这里把该输出在零延迟下桥接到现有接收头的
 * `setCarrier`，不经过任何光电或模拟波形。帧编码是本测试文件定义的示例脉宽格式，
 * 不是 NEC/RC5 等具体协议，也不是 ir-emitter 的器件功能。
 *
 * 为了从接收端恢复数据，夹具按固定 50 µs 采样 `receiving`，记录低脉冲宽度；解码器
 * 只读这些低脉冲，不读取发射端的排程。
 */

export const SAMPLE_US = 50;
export const PREAMBLE_US = 2000;
export const TRAILER_US = 2000;
export const BIT_ZERO_US = 400;
export const BIT_ONE_US = 1200;
export const SEPARATOR_US = 1000;

export type ReceiverId = 'vs1838' | 'cx20106a';

export interface Pulse {
  readonly carrier: boolean;
  readonly durationUs: number;
}

export interface Sample {
  readonly time: number;
  readonly receiving: boolean;
}

export interface LinkFixture {
  readonly board: TestBoard;
  readonly receiver: ReceiverId;
}

export async function createLink(receiver: ReceiverId): Promise<LinkFixture> {
  const nets = [
    {
      id: 'vcc',
      pins: [
        { instance: 'tx', pin: 'vcc' },
        { instance: 'rx', pin: 'vcc' },
        { instance: 'modDrv', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'tx', pin: 'gnd' },
        { instance: 'rx', pin: 'gnd' },
        { instance: 'modDrv', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'mod',
      pins: [
        { instance: 'tx', pin: 'mod' },
        { instance: 'modDrv', pin: 'y' },
      ],
    },
    {
      id: 'rxOut',
      pins: [
        { instance: 'rx', pin: 'out' },
        { instance: 'rxPull', pin: 'a' },
        { instance: 'rxProbe', pin: 'y' },
      ],
    },
    {
      id: 'rxPullUp',
      pins: [{ instance: 'rxPull', pin: 'b' }],
      voltage: 5,
    },
  ];

  const board = await createBoardWith(
    [
      { id: 'tx', type: 'ir-emitter' },
      { id: 'rx', type: receiver },
    ],
    {
      nets,
      sources: ['modDrv'],
      probes: ['rxProbe'],
      resistors: [{ id: 'rxPull', resistance: 10_000 }],
    },
  );

  board.run(0);
  return { board, receiver };
}

/** 定义测试用的脉宽帧：前导长载波、每字节 8 位 MSB-first、结尾长载波。 */
export function encodeDemoFrame(bytes: Uint8Array): Pulse[] {
  const pulses: Pulse[] = [
    { carrier: true, durationUs: PREAMBLE_US },
    { carrier: false, durationUs: SEPARATOR_US },
  ];

  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const one = ((byte >> bit) & 1) === 1;
      pulses.push({ carrier: true, durationUs: one ? BIT_ONE_US : BIT_ZERO_US });
      pulses.push({ carrier: false, durationUs: SEPARATOR_US });
    }
  }

  pulses.push({ carrier: true, durationUs: TRAILER_US });
  pulses.push({ carrier: false, durationUs: SEPARATOR_US });
  return pulses;
}

function applyModulation(link: LinkFixture, carrier: boolean): void {
  const { board } = link;
  board.send('modDrv', 'level', carrier ? 1 : 0);
  board.run(0);

  const actual = board.call('tx', 'isCarrier') === true;
  if (actual !== carrier) {
    throw new Error(`emitter carrier mismatch: expected ${carrier}, received ${actual}`);
  }

  // 零延迟逻辑桥：发射端输出通道 → 现有接收头的公共 setCarrier 输入。
  board.send('rx', 'setCarrier', actual);
}

/** 按脉冲排程驱动发射端，并按 50 µs 采样接收端解调输出。 */
export function driveFrame(link: LinkFixture, pulses: readonly Pulse[]): Sample[] {
  const { board } = link;
  const samples: Sample[] = [];
  const capture = (): void => {
    samples.push({
      time: board.time,
      receiving: board.call('rx', 'isReceiving') === true,
    });
  };

  capture();
  for (const pulse of pulses) {
    if (pulse.durationUs <= 0 || pulse.durationUs % SAMPLE_US !== 0) {
      throw new Error(`pulse duration must be a positive multiple of ${SAMPLE_US} µs`);
    }

    applyModulation(link, pulse.carrier);
    capture();

    const steps = pulse.durationUs / SAMPLE_US;
    for (let step = 0; step < steps; step++) {
      board.run(SAMPLE_US * US);
      capture();
    }
  }

  return samples;
}

interface LowPulse {
  readonly start: number;
  readonly end: number;
  readonly width: number;
}

function lowPulses(samples: readonly Sample[]): LowPulse[] {
  const pulses: LowPulse[] = [];
  let start: number | undefined;

  for (const sample of samples) {
    if (sample.receiving) {
      start ??= sample.time;
    } else if (start !== undefined) {
      pulses.push({ start, end: sample.time, width: sample.time - start });
      start = undefined;
    }
  }

  if (start !== undefined) {
    throw new Error('receiver output is still low at the end of the capture');
  }

  return pulses;
}

/** 从接收端低脉冲宽度恢复字节；前导/结尾长脉冲只用于定界。 */
export function decodeDemoFrame(samples: readonly Sample[]): Uint8Array {
  const pulses = lowPulses(samples);
  const delimiters = pulses
    .map((pulse, index) => (pulse.width >= 1500 * US ? index : -1))
    .filter((index) => index >= 0);

  if (delimiters.length !== 2) {
    throw new Error(
      `expected one preamble and one trailer, received ${delimiters.length} long pulses`,
    );
  }

  const preamble = delimiters[0];
  const trailer = delimiters[1];
  if (preamble === undefined || trailer === undefined) {
    throw new Error('missing frame delimiter');
  }
  const bits: number[] = [];
  for (let index = preamble + 1; index < trailer; index++) {
    const width = pulses[index]?.width;
    if (width === undefined) throw new Error('missing bit pulse');
    if (width >= 900 * US) {
      bits.push(1);
    } else if (width >= 300 * US) {
      bits.push(0);
    } else {
      throw new Error(`unrecognized pulse width ${width} ps`);
    }
  }

  if (bits.length % 8 !== 0) {
    throw new Error(`decoded ${bits.length} bits, expected a whole number of bytes`);
  }

  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bits.length; index++) {
    if (bits[index] === 1) {
      bytes[Math.floor(index / 8)]! |= 1 << (7 - (index % 8));
    }
  }
  return bytes;
}
