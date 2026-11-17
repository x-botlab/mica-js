import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { createCt107dBoard } from '../bench/board';
import { assemble } from './fixtures/8051/assemble';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', '8051');
const firmware = (name: string): Uint8Array =>
  assemble(readFileSync(join(FIXTURE_DIR, `${name}.asm`), 'utf8'));

interface Captured {
  readonly signals: Map<string, number>;
  readonly bytes: Map<string, Uint8Array>;
  readonly uartTx: number[];
  readonly probeTx: number[];
  readonly status: () => string;
  readonly faults: () => readonly string[];
  runUntil(targetPs: number): void;
  dispose(): void;
}

function captureFused(fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>): Captured {
  const signals = new Map<string, number>();
  const bytes = new Map<string, Uint8Array>();
  const uartTx: number[] = [];
  const probeTx: number[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic === 'signal') {
      const value = message.payload as { designator: string; port: string; value: number };
      signals.set(`${value.designator}/${value.port}`, value.value);
      if (value.designator === 'UART_PROBE' && value.port === 'tx') probeTx.push(value.value);
    } else if (message.topic === 'bytes') {
      const value = message.payload as { designator: string; port: string; data: Uint8Array };
      bytes.set(`${value.designator}/${value.port}`, new Uint8Array(value.data));
      if (value.designator === 'UART_PROBE' && value.port === 'tx') probeTx.push(...value.data);
    } else if (message.topic === 'uart1.tx') {
      const value = message.payload as { readonly data?: Uint8Array };
      if (value.data !== undefined) uartTx.push(...value.data);
    }
  });
  return {
    signals,
    bytes,
    uartTx,
    probeTx,
    status: () => fused.board.status,
    faults: () => fused.faults,
    runUntil: (target) => fused.board.runUntil(target),
    dispose() {
      subscription.dispose();
      fused.dispose();
    },
  };
}

function captureDiscrete(discrete: Awaited<ReturnType<typeof createCt107dBoard>>): Captured {
  const signals = new Map<string, number>();
  const bytes = new Map<string, Uint8Array>();
  const uartTx: number[] = [];
  const probeTx: number[] = [];
  const designatorOf = new Map<string, string>();
  for (const [id, designator] of discrete.designators) designatorOf.set(id, designator);
  const subscription = discrete.board.topics.onDidReceive((message) => {
    const id = discrete.topicOrigin();
    const designator = id === undefined ? undefined : designatorOf.get(id);
    if (designator === undefined) return;
    const key = `${designator}/${message.topic}`;
    if (typeof message.payload === 'number') signals.set(key, message.payload);
    else if (typeof message.payload === 'boolean') signals.set(key, message.payload ? 1 : 0);
    else if (message.payload instanceof Uint8Array) {
      bytes.set(key, new Uint8Array(message.payload));
      if (designator === 'UART_PROBE' && message.topic === 'tx') probeTx.push(...message.payload);
    } else if (
      message.topic === 'uart1Tx' &&
      message.payload !== null &&
      typeof message.payload === 'object' &&
      'data' in message.payload
    ) {
      const data = (message.payload as { readonly data: Uint8Array }).data;
      uartTx.push(...data);
    }
  });
  return {
    signals,
    bytes,
    uartTx,
    probeTx,
    status: () => discrete.board.status,
    faults: () => discrete.faults,
    runUntil: (target) => discrete.board.runUntil(target),
    dispose() {
      subscription.dispose();
      discrete.dispose();
    },
  };
}

async function boards(name: string) {
  const image = firmware(name);
  const fused = await createFusedCt107dBoard({ firmware: image });
  const discrete = await createCt107dBoard({
    firmware: image,
    props: { clockFrequency: 11_059_200 },
    execution: 'throughput',
  });
  return {
    fused,
    discrete,
    actual: captureFused(fused),
    oracle: captureDiscrete(discrete),
  };
}

function advance(captures: readonly Captured[], fromMs: number, toMs: number): void {
  for (let ms = fromMs; ms <= toMs; ms += 1)
    for (const capture of captures) capture.runUntil(ms * 1_000_000_000);
}

function closeBoards(
  fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>,
  discrete: Awaited<ReturnType<typeof createCt107dBoard>>,
  actual: Captured,
  oracle: Captured,
): void {
  actual.dispose();
  oracle.dispose();
  fused.dispose();
  discrete.dispose();
}

function expectReady(captures: readonly Captured[]): void {
  for (const capture of captures) {
    expect(capture.status()).toBe('ready');
    expect(capture.faults()).toEqual([]);
  }
}

describe('fused board self-made firmware fixtures', () => {
  it('reset P3/P4 reads are FF without external load in throughput and precise', async () => {
    const image = Uint8Array.from([
      0xe5,
      0xb0, // MOV A,P3
      0xf5,
      0x80,
      0x75,
      0xa0,
      0x80,
      0x75,
      0xa0,
      0x00,
      0xe5,
      0xc0, // MOV A,P4
      0xf5,
      0x80,
      0x75,
      0xa0,
      0xe0,
      0x75,
      0xa0,
      0x00,
      0x80,
      0xfe,
    ]);
    for (const execution of ['throughput', 'precise'] as const) {
      const fused = await createFusedCt107dBoard({ firmware: image, execution });
      const signals = new Map<string, number>();
      const subscription = fused.board.topics.onDidReceive((message) => {
        if (message.topic !== 'signal') return;
        const value = message.payload as { designator: string; port: string; value: number };
        signals.set(`${value.designator}/${value.port}`, value.value);
      });
      try {
        fused.board.runUntil(1_000_000_000);
        expect(signals.get('U6/latch'), `${execution} P3 reset`).toBe(0xff);
        expect(signals.get('U7/latch'), `${execution} P4 reset`).toBe(0xff);
        expect(fused.faults).toEqual([]);
      } finally {
        subscription.dispose();
        fused.dispose();
      }
    }
  }, 60_000);

  it('reset P3/P4 reads are weak-high before any port write; external S4 can pull P33 low', async () => {
    // First instructions read the reset pins directly and latch them through the normal
    // J13 2-3 IO path (WR grounded). No MOV P3,#FF / MOV P4,#FF priming is present.
    const image = Uint8Array.from([
      0xe5,
      0xb0, // MOV A,P3
      0xf5,
      0x80, // MOV P0,A
      0x75,
      0xa0,
      0x80, // MOV P2,#80H (U6 latch)
      0x75,
      0xa0,
      0x00,
      0xe5,
      0xc0, // MOV A,P4
      0xf5,
      0x80,
      0x75,
      0xa0,
      0xe0, // MOV P2,#E0H (U7 latch)
      0x75,
      0xa0,
      0x00,
      0x80,
      0xfe, // SJMP $
    ]);
    const fused = await createFusedCt107dBoard({ firmware: image });
    const signals = new Map<string, number>();
    const subscription = fused.board.topics.onDidReceive((message) => {
      if (message.topic !== 'signal') return;
      const value = message.payload as { designator: string; port: string; value: number };
      signals.set(`${value.designator}/${value.port}`, value.value);
    });
    try {
      fused.methods.setSwitch!({ designator: 'S4', pressed: true });
      fused.board.runUntil(1_000_000_000);
      // S4 is an independent key in the default J5 2-3 assembly: it pulls P3.3 low.
      expect(signals.get('U6/latch')).toBe(0xf7);
      expect(signals.get('U7/latch')).toBe(0xff);
      expect(fused.faults).toEqual([]);
    } finally {
      subscription.dispose();
      fused.dispose();
    }
  }, 60_000);

  it('I2C: AT24C02 write/read-back and independent PCF8591 AIN2', async () => {
    const { fused, discrete, actual, oracle } = await boards('i2c-eeprom-pcf');
    try {
      // LM324 output must not implicitly drive PCF AIN2; the analog channel is independent.
      fused.methods.setAnalogInput!({ channel: 2, value: 0.5 });
      fused.methods.setAmplifierInputs!({ plus: 5, minus: 0 });
      fused.methods.setWiper!({ value: 0 });
      expect(discrete.sendInput('U16', 'ain2', 0.5)).toBe(true);

      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 100);
      expectReady([actual, oracle]);

      const fusedDump = actual.bytes.get('U4/dump')!;
      const discreteDump = oracle.bytes.get('U4/dump')!;
      expect(fusedDump, 'EEPROM dump').toBeDefined();
      expect(fusedDump![0x10]).toBe(0x5a);
      expect(discreteDump![0x10]).toBe(0x5a);
      expect(actual.signals.get('U6/latch'), 'EEPROM read-back').toBe(0x5a);
      expect(oracle.signals.get('U6/latch')).toBe(0x5a);
      expect(actual.signals.get('U7/latch'), 'PCF AIN2').toBe(128);
      expect(oracle.signals.get('U7/latch')).toBe(128);
      expect((fused.methods.getEeprom!(null) as Uint8Array)[0x10]).toBe(0x5a);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 120_000);

  it('UART: injects bytes and receives the exact echoed stream', async () => {
    const { fused, discrete, actual, oracle } = await boards('uart-echo');
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 5);
      const input = Uint8Array.from([0x01, 0x23, 0x45, 0x00, 0xff]);
      fused.methods.sendUart!({ data: input });
      expect(discrete.sendInput('UART_PROBE', 'send', input)).toBe(true);
      advance([actual, oracle], 6, 100);
      expectReady([actual, oracle]);

      expect(actual.uartTx).toEqual([...input]);
      expect(oracle.uartTx).toEqual([...input]);
      expect(actual.probeTx).toEqual([...input]);
      expect(oracle.probeTx).toEqual([...input]);
      const chunk = fused.methods.readSerial!({ channel: 'uart1Tx', cursor: 0 }) as {
        readonly data: Uint8Array;
      };
      expect([...chunk.data]).toEqual([...input]);
      const status = fused.methods.getSerialStatus!({ channel: 'uart1Tx' }) as {
        readonly droppedTotal: number;
      };
      expect(status.droppedTotal).toBe(0);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 120_000);

  it('1-Wire: DS18B20 converts an injected temperature and reads it back', async () => {
    const { fused, discrete, actual, oracle } = await boards('ds18b20-temp');
    try {
      fused.methods.setTemperature!({ value: 25.0625 });
      expect(discrete.sendInput('U5', 'temperature', 25.0625)).toBe(true);
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 1600);
      expectReady([actual, oracle]);

      expect(actual.signals.get('U5/temperatureOut')).toBeCloseTo(25.0625, 4);
      expect(oracle.signals.get('U5/temperatureOut')).toBeCloseTo(25.0625, 4);
      expect(actual.signals.get('U6/latch')).toBe(0x91);
      expect(oracle.signals.get('U6/latch')).toBe(0x91);
      expect(actual.signals.get('U7/latch')).toBe(0x01);
      expect(oracle.signals.get('U7/latch')).toBe(0x01);
      const snapshot = fused.methods.getSnapshot!(null) as {
        readonly temperature: { readonly converted: boolean; readonly value: number };
      };
      expect(snapshot.temperature.converted).toBe(true);
      expect(snapshot.temperature.value).toBeCloseTo(25.0625, 4);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 240_000);

  it('DS1302: reads a nonzero seconds register after the RTC advances', async () => {
    const { fused, discrete, actual, oracle } = await boards('ds1302-read');
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 3000);
      expectReady([actual, oracle]);

      const seconds = actual.signals.get('U6/latch');
      expect(seconds).toBeDefined();
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(0x09);
      expect(oracle.signals.get('U6/latch')).toBe(seconds);
      expect(actual.bytes.get('U19/datetime')).toEqual(oracle.bytes.get('U19/datetime'));
      const rtc = fused.methods.getRtc!(null) as {
        readonly datetime: string;
        readonly running: boolean;
      };
      expect(rtc.running).toBe(true);
      expect(rtc.datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 240_000);

  it('ultrasonic: eight triggers produce an echo and the firmware latches it', async () => {
    const { fused, discrete, actual, oracle } = await boards('ultrasonic-echo');
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 50);
      expectReady([actual, oracle]);
      expect(actual.signals.get('U6/latch')).toBe(0xa5);
      expect(oracle.signals.get('U6/latch')).toBe(0xa5);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 120_000);

  it('IR/J2: independent receivers and the 2×3 jumper select P1.1', async () => {
    const { fused, discrete, actual, oracle } = await boards('ir-j2');
    const setCarrier = (designator: 'U11' | 'U20', value: boolean): void => {
      fused.methods.setIrCarrier!({ designator, value });
      expect(discrete.sendInput(designator, 'carrier', value)).toBe(true);
    };
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 5);
      expect(actual.signals.get('U6/latch')! & 0x02).toBe(0x02);

      // J2 defaults to VS1838: only U20 can pull P1.1 low.
      setCarrier('U20', true);
      setCarrier('U11', true);
      advance([actual, oracle], 6, 10);
      expect(actual.signals.get('U6/latch')! & 0x02).toBe(0);
      expect(oracle.signals.get('U6/latch')! & 0x02).toBe(0);

      // Switch J2 to CX20106A while both receivers still see a carrier.
      fused.methods.setJumper!({ designator: 'J2', closed: false });
      expect(discrete.sendInput('J2', 'control2', false)).toBe(true);
      setCarrier('U20', false);
      advance([actual, oracle], 11, 20);
      expect(actual.signals.get('U6/latch')! & 0x02).toBe(0);
      expect(oracle.signals.get('U6/latch')! & 0x02).toBe(0);

      // U11 no longer detects: P1.1 returns high even though J2 selects CX20106A.
      setCarrier('U11', false);
      advance([actual, oracle], 21, 30);
      expect(actual.signals.get('U6/latch')! & 0x02).toBe(0x02);
      expect(oracle.signals.get('U6/latch')! & 0x02).toBe(0x02);

      // The unselected VS1838 must not reach P1.1.
      setCarrier('U20', true);
      advance([actual, oracle], 31, 40);
      expect(actual.signals.get('U6/latch')! & 0x02).toBe(0x02);
      expect(oracle.signals.get('U6/latch')! & 0x02).toBe(0x02);
      expectReady([actual, oracle]);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 120_000);

  it('actuators: ULN2003 channels drive the relay and buzzer observables', async () => {
    const { fused, discrete, actual, oracle } = await boards('actuators');
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      advance([actual, oracle], 1, 20);
      expectReady([actual, oracle]);
      expect(actual.signals.get('K1/energized')).toBe(1);
      expect(oracle.signals.get('K1/energized')).toBe(1);
      expect(actual.signals.get('SP1/active')).toBe(1);
      expect(oracle.signals.get('SP1/active')).toBe(1);
      const snapshot = fused.methods.getSnapshot!(null) as {
        readonly relay: boolean;
        readonly buzzer: boolean;
        readonly lm386: { readonly active: boolean };
        readonly uln2003: { readonly mask: number; readonly channels: string };
      };
      expect(snapshot.relay).toBe(true);
      expect(snapshot.buzzer).toBe(true);
      expect(snapshot.lm386.active).toBe(true);
      expect(snapshot.uln2003.mask & 0x50).toBe(0x50);
      expect(snapshot.uln2003.channels[4]).toBe('1');
      expect(snapshot.uln2003.channels[6]).toBe('1');
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 120_000);

  it('key matrix: all 16 scanned keys, independent keys and multi-key propagation', async () => {
    const { fused, discrete, actual, oracle } = await boards('key-scan');
    const rows = ['P30', 'P31', 'P32', 'P33'];
    const keys = [
      ['S4', 3, 'ind'],
      ['S5', 2, 'ind'],
      ['S6', 1, 'ind'],
      ['S7', 0, 'ind'],
      ['S8', 3, 'p42'],
      ['S9', 2, 'p42'],
      ['S10', 1, 'p42'],
      ['S11', 0, 'p42'],
      ['S12', 3, 'p35'],
      ['S13', 2, 'p35'],
      ['S14', 1, 'p35'],
      ['S15', 0, 'p35'],
      ['S16', 3, 'p34'],
      ['S17', 2, 'p34'],
      ['S18', 1, 'p34'],
      ['S19', 0, 'p34'],
    ] as const;
    try {
      actual.runUntil(0);
      oracle.runUntil(0);
      let nowMs = 0;
      const runFor = (ms: number): void => {
        nowMs += ms;
        for (const capture of [actual, oracle]) capture.runUntil(nowMs * 1_000_000_000);
      };
      runFor(20);

      // S1 is the reset button on this schematic: it has no MCU port net, so the shared
      // observable is the switch channel itself. S4-S19 below are the 16 matrix/independent
      // keys that drive P30-P35.
      fused.methods.setSwitch!({ designator: 'S1', pressed: true });
      expect(discrete.sendInput('S1', 'press', true)).toBe(true);
      runFor(10);
      expect(actual.signals.get('S1/pressed')).toBe(1);
      expect(oracle.signals.get('S1/pressed')).toBe(1);
      fused.methods.setSwitch!({ designator: 'S1', pressed: false });
      expect(discrete.sendInput('S1', 'press', false)).toBe(true);
      runFor(10);
      expect(actual.signals.get('S1/pressed')).toBe(0);
      expect(oracle.signals.get('S1/pressed')).toBe(0);

      for (const [key, row, column] of keys) {
        fused.methods.setSwitch!({ designator: key, pressed: true });
        expect(discrete.sendInput(key, 'press', true)).toBe(true);
        // The scan loop includes a debounce-sized delay; hold each key across at least
        // one complete U6/U8/U7 scan before sampling the latches.
        runFor(50);
        const fusedLatch = actual.signals;
        const discreteLatch = oracle.signals;
        for (const designator of ['U6', 'U7', 'U8'])
          expect(fusedLatch.get(`${designator}/latch`), `${key} ${designator}`).toBe(
            discreteLatch.get(`${designator}/latch`),
          );
        const snapshot = {
          U6: fusedLatch.get('U6/latch')!,
          U7: fusedLatch.get('U7/latch')!,
          U8: fusedLatch.get('U8/latch')!,
        };
        const expectedScan = column === 'p35' ? 'U8' : column === 'p34' ? 'U7' : 'U6';
        expect(snapshot[expectedScan]!, `${key} row ${rows[row]} on ${expectedScan}`).toBe(
          snapshot[expectedScan]! & ~(1 << row),
        );
        fused.methods.setSwitch!({ designator: key, pressed: false });
        expect(discrete.sendInput(key, 'press', false)).toBe(true);
        runFor(50);
      }

      // U6 drives P42 low: S4's independent GND column pulls P33 low and S9 pulls
      // P32 low through the real P42 column; S12 pulls P35 low in the U8 scan.
      for (const key of ['S4', 'S9', 'S12']) {
        fused.methods.setSwitch!({ designator: key, pressed: true });
        expect(discrete.sendInput(key, 'press', true)).toBe(true);
      }
      runFor(50);
      const u6 = actual.signals.get('U6/latch')!;
      const u8 = actual.signals.get('U8/latch')!;
      expect(u6 & (1 << 3)).toBe(0); // S4/S12 row P33
      expect(u6 & (1 << 2)).toBe(0); // S9 row P32 via the driven P42 column
      expect(u6 & (1 << 5)).toBe(0); // S12 pulls P35 low through S4
      expect(u8 & (1 << 3)).toBe(0); // S12 row P33 via the driven P35 column
      for (const designator of ['U6', 'U7', 'U8'])
        expect(actual.signals.get(`${designator}/latch`)).toBe(
          oracle.signals.get(`${designator}/latch`),
        );
      expectReady([actual, oracle]);
    } finally {
      closeBoards(fused, discrete, actual, oracle);
    }
  }, 180_000);

  it('J5=1-2: the exact P42/P44 two-phase scan produces all 16 source key codes', async () => {
    const image = firmware('key-matrix-p4');
    const fused = await createFusedCt107dBoard({
      firmware: image,
      props: { clockFrequency: 12_000_000 },
    });
    const signals = new Map<string, number>();
    const subscription = fused.board.topics.onDidReceive((message) => {
      if (message.topic !== 'signal') return;
      const value = message.payload as { designator: string; port: string; value: number };
      signals.set(`${value.designator}/${value.port}`, value.value);
    });
    const codes = {
      S4: 0x77,
      S5: 0x7b,
      S6: 0x7d,
      S7: 0x7e,
      S8: 0xb7,
      S9: 0xbb,
      S10: 0xbd,
      S11: 0xbe,
      S12: 0xd7,
      S13: 0xdb,
      S14: 0xdd,
      S15: 0xde,
      S16: 0xe7,
      S17: 0xeb,
      S18: 0xed,
      S19: 0xee,
    } as const;
    let nowMs = 0;
    const runFor = (ms: number): void => {
      nowMs += ms;
      fused.board.runUntil(nowMs * 1_000_000_000);
    };
    try {
      // Explicit matrix assembly: J5 1-2 (closed=false) and J3 open. J13 stays in its
      // default 2-3 IO position, so WR is grounded and latch writes remain valid.
      fused.methods.setJumper!({ designator: 'J5', closed: false });
      fused.methods.setJumper!({ designator: 'J3', closed: false });
      runFor(20);
      expect(fused.methods.getSnapshot!(null)).toMatchObject({
        jumpers: { J5: false, J3: false, J13: true },
      });
      expect(signals.get('U6/latch')).toBe(0xff);

      // A held key must be recomputed immediately when J5 changes. In independent mode
      // S4 reads 0xF7 (GND column, P44 high); switching to matrix makes the same held
      // key read 0x77 (P44 column low in phase 1 and pulled low in phase 2).
      fused.methods.setJumper!({ designator: 'J5', closed: true });
      fused.methods.setSwitch!({ designator: 'S4', pressed: true });
      runFor(50);
      expect(signals.get('U6/latch')).toBe(0xf7);
      fused.methods.setJumper!({ designator: 'J5', closed: false });
      runFor(50);
      expect(signals.get('U6/latch')).toBe(0x77);
      fused.methods.setSwitch!({ designator: 'S4', pressed: false });
      runFor(50);
      expect(signals.get('U6/latch')).toBe(0xff);

      for (const [key, code] of Object.entries(codes)) {
        fused.methods.setSwitch!({ designator: key, pressed: true });
        runFor(20);
        expect(signals.get('U6/latch'), `${key} source key code`).toBe(code);
        fused.methods.setSwitch!({ designator: key, pressed: false });
        runFor(10);
        expect(signals.get('U6/latch'), `${key} release`).toBe(0xff);
      }
      expect(fused.faults).toEqual([]);
    } finally {
      subscription.dispose();
      fused.dispose();
    }
  }, 180_000);

  it('J13 2-3 grounds WR by default; 1-2 follows P42 instead of floating', async () => {
    const io = await createFusedCt107dBoard({ firmware: firmware('latch') });
    const memoryWithoutStrobe = await createFusedCt107dBoard({ firmware: firmware('latch') });
    const memoryWithStrobe = await createFusedCt107dBoard({ firmware: firmware('latch-p42-wr') });
    const read = (fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>): number => {
      const snapshot = fused.methods.getSnapshot!(null) as {
        readonly latches: { readonly U6: number };
      };
      return snapshot.latches.U6;
    };
    try {
      memoryWithoutStrobe.methods.setJumper!({ designator: 'J13', closed: false });
      memoryWithStrobe.methods.setJumper!({ designator: 'J13', closed: false });
      io.board.runUntil(1_000_000_000);
      memoryWithoutStrobe.board.runUntil(1_000_000_000);
      memoryWithStrobe.board.runUntil(1_000_000_000);

      // Default IO (2-3): WR grounded, so a plain P2/P0 write latches 0xA5.
      expect(read(io)).toBe(0xa5);
      // 1-2: WR follows P42. P42 stays weak-high, so there is no latch strobe; the
      // latch keeps its deterministic power-on value 0.
      expect(read(memoryWithoutStrobe)).toBe(0x00);
      // 1-2 + firmware drives P42 low: the real memory-mode strobe works.
      expect(read(memoryWithStrobe)).toBe(0x5a);
      for (const fused of [io, memoryWithoutStrobe, memoryWithStrobe])
        expect(fused.faults).toEqual([]);
    } finally {
      io.dispose();
      memoryWithoutStrobe.dispose();
      memoryWithStrobe.dispose();
    }
  }, 60_000);
});
