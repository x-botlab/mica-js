import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { CPU_CYCLE_PS } from '@mica-js/stm32g431rbt6-core/layout';
import { PERIPHERALS } from '@mica-js/stm32g431rbt6-core/peripherals';
import { clockBoard } from '../../test/stm32g431rbt6/clock-harness';
import { SystemThumb, vectorOf } from '../../test/stm32g431rbt6/system-thumb';

// Production stand-alone MCU profile, not the fused CT117E or a CPU-only rig.
// The fixture activates GPIO, TIM2/NVIC, SysTick and USART2, not every module.
const CLOCK_HZ = 80_000_000;
const UART_BAUD = 115_200;
const WARM_MS = 4;
const WINDOW_MS = 2;
const WINDOWS = 5;
const PS_PER_MS = 1_000_000_000;
const RAM = 0x2000_0100;
const TIM2 = 0x4000_0000;
const UART2 = 0x4000_4400;
const GPIOA = 0x4800_0000;
const PA5 = 1 << 5;
const UART_BYTE = 0x55;

function firmware(staticSram: boolean): Uint8Array {
  const t = new SystemThumb().vector(3, 'fault').vector(15, 'systick').vector(vectorOf(28), 'tim2');
  const load = (r: number, value: number) => t.movw(r, value).movt(r, value >>> 16);
  const write = (address: number, value: number) => {
    load(0, address);
    load(1, value).strWord(1, 0, 0);
  };
  const increment = (offset: number) => {
    load(0, RAM).ldrWord(1, 0, offset).adds(1, 1).strWord(1, 0, offset);
  };

  write(0x4002_104c, 1); // AHB2ENR.GPIOAEN
  write(0x4002_1058, (1 << 17) | 1); // APB1ENR1.USART2EN | TIM2EN
  write(GPIOA, (1 << 10) | (2 << 4)); // PA5 output, PA2 alternate
  write(GPIOA + 0x20, 7 << 8); // PA2 AF7 = USART2 TX
  write(UART2 + 0x0c, Math.round(CLOCK_HZ / UART_BAUD)); // OVER16, prescaler /1
  write(UART2, 9); // UE | TE
  write(RAM + 12, RAM); // Guest-written pointer: loop load/store stays dynamic.
  write(0xe000_e014, CLOCK_HZ / 1000 - 1); // SysTick every 1 ms
  write(0xe000_e018, 0);
  write(0xe000_e010, 7);
  write(TIM2 + 0x2c, CLOCK_HZ / 4000 - 1); // TIM2 update every 250 µs
  write(TIM2 + 0x0c, 1); // DIER.UIE
  write(0xe000_e100, 1 << 28);
  write(TIM2, 1); // CR1.CEN

  t.mark('loop');
  // Keep the same loads and guest cycles; only change whether the pointer feeds the store.
  load(0, RAM)
    .ldrWord(staticSram ? 3 : 0, 0, 12)
    .ldrWord(1, 0, 0)
    .adds(1, 1)
    .strWord(1, 0, 0)
    .b('loop');

  t.mark('systick');
  increment(4);
  t.bx(14);
  t.mark('tim2');
  write(TIM2 + 0x10, 0); // Clear UIF
  increment(8);
  load(0, GPIOA).ldrWord(1, 0, 0x14).movs(2, PA5);
  t.half(0x4051).strWord(1, 0, 0x14); // eors r1, r2; update ODR
  write(UART2 + 0x28, UART_BYTE);
  t.bx(14);
  t.mark('fault').bkpt().spin();
  return t.build();
}

interface JitView {
  readonly cache: ReadonlyMap<number, unknown>;
  readonly revision: number;
  readonly direct?: unknown;
  readonly directStats?: {
    readonly directCompiles: number;
    readonly directCalls: number;
    readonly directFallbacks: number;
  };
}

it('measures active steady state on the full STM32G431 peripheral profile', async () => {
  const execution = process.env.STEADY_MODE ?? 'throughput';
  if (execution !== 'precise' && execution !== 'throughput') throw new Error(`mode: ${execution}`);
  const addressing = process.env.STEADY_SRAM ?? 'dynamic';
  if (addressing !== 'dynamic' && addressing !== 'static')
    throw new Error(`SRAM addressing: ${addressing}`);
  const image = firmware(addressing === 'static');
  const log = (tag: string, data: unknown) =>
    console.log(`G431_STEADY_${tag} ${JSON.stringify(data)}`);
  log('BEGIN', {
    execution,
    addressing,
    node: process.version,
    clockHz: CLOCK_HZ,
    warmMs: WARM_MS,
    windowMs: WINDOW_MS,
    windows: WINDOWS,
    modules: PERIPHERALS.map(({ id }) => id),
    firmwareSha256: createHash('sha256').update(image).digest('hex'),
  });

  const setupCpu = process.cpuUsage();
  const setup = performance.now();
  const rig = await clockBoard({
    firmware: image,
    clockFrequency: CLOCK_HZ,
    pins: ['PA5'],
    execution,
  });
  const setupWallMs = performance.now() - setup;
  const { user, system } = process.cpuUsage(setupCpu);
  log('SETUP', { wallMs: setupWallMs, cpuMs: (user + system) / 1000 });
  const errors: string[] = [];
  const subscription = rig.board.onDidError((error) => errors.push(error.message));
  try {
    const [jit] = (rig.board as unknown as { jits: readonly JitView[] }).jits;
    if (jit === undefined) throw new Error('production JIT not attached');
    const observe = () => ({
      timePs: rig.time(),
      cpuCyclePs: rig.state(CPU_CYCLE_PS),
      main: rig.readSram(0x100),
      systick: rig.readSram(0x104),
      tim2: rig.readSram(0x108),
      gpio: rig.transitions.PA5?.length ?? 0,
      tx: rig.topics['serial2.tx']?.length ?? 0,
      blocks: jit.cache.size,
      revision: jit.revision,
      compiles: jit.directStats?.directCompiles ?? 0,
      calls: jit.directStats?.directCalls ?? 0,
      fallbacks: jit.directStats?.directFallbacks ?? 0,
    });
    const health = () => {
      expect(errors).toEqual([]);
      expect(rig.topics.fault ?? []).toEqual([]);
      expect(rig.state('halted')).toBe(false);
      // The firmware keeps the boot clock; the RCC frequency cache is not populated.
      expect(rig.state(CPU_CYCLE_PS)).toBe((1000 * PS_PER_MS) / CLOCK_HZ);
      const sys = rig.memory('sys');
      const view = new DataView(sys.buffer, sys.byteOffset, sys.byteLength);
      expect([view.getUint32(0x128, true), view.getUint32(0x12c, true)]).toEqual([0, 0]);
    };
    const advance = (ms: number) => {
      const cpu = process.cpuUsage();
      const wall = performance.now();
      rig.run(ms * PS_PER_MS);
      const wallMs = performance.now() - wall;
      const { user, system } = process.cpuUsage(cpu);
      return { wallMs, cpuMs: (user + system) / 1000 };
    };
    const warm = advance(WARM_MS);
    let before = observe();
    log('WARM', { ...warm, ...before });
    health();
    expect(before.timePs).toBe(WARM_MS * PS_PER_MS);
    expect(before.main).toBeGreaterThan(0);
    expect(before.systick).toBeGreaterThan(0);
    expect(before.tim2).toBeGreaterThan(0);
    if (execution === 'throughput') expect(jit.direct).toBeDefined();

    const wallSamples: number[] = [];
    const cpuSamples: number[] = [];
    for (let window = 1; window <= WINDOWS; window += 1) {
      const timings = advance(WINDOW_MS);
      const after = observe();
      const delta = {
        main: after.main - before.main,
        systick: after.systick - before.systick,
        tim2: after.tim2 - before.tim2,
        gpio: after.gpio - before.gpio,
        tx: after.tx - before.tx,
        blocks: after.blocks - before.blocks,
        revision: after.revision - before.revision,
        compiles: after.compiles - before.compiles,
        calls: after.calls - before.calls,
        fallbacks: after.fallbacks - before.fallbacks,
      };
      log('WINDOW', { window, fromPs: before.timePs, toPs: after.timePs, ...timings, delta });
      health();
      expect(after.timePs - before.timePs).toBe(WINDOW_MS * PS_PER_MS);
      expect(delta.main).toBe(13_305);
      expect(delta.systick).toBe(WINDOW_MS);
      expect(delta.tim2).toBe(4 * WINDOW_MS);
      expect(delta.gpio).toBe(delta.tim2);
      const edges = rig.transitions.PA5!.slice(before.gpio - 1, after.gpio);
      expect(edges).toHaveLength(delta.gpio + 1);
      expect(
        edges.every(
          ({ value }, i) =>
            (value === 0 || value === 1) && (i === 0 || value !== edges[i - 1]!.value),
        ),
      ).toBe(true);
      expect(delta.tx).toBe(delta.tim2);
      const bytes = (rig.topics['serial2.tx'] as Uint8Array[])
        .slice(before.tx, after.tx)
        .flatMap((chunk) => [...chunk]);
      expect(bytes).toEqual(Array<number>(delta.tim2).fill(UART_BYTE));
      expect([delta.blocks, delta.revision, delta.compiles]).toEqual([0, 0, 0]);
      if (execution === 'throughput') expect(delta.calls - delta.fallbacks).toBeGreaterThan(0);
      wallSamples.push(timings.wallMs);
      cpuSamples.push(timings.cpuMs);
      before = after;
    }
    const median = (samples: number[]) =>
      samples.toSorted((a, b) => a - b)[Math.floor(WINDOWS / 2)]!;
    const medianWallMs = median(wallSamples);
    log('RESULT', {
      execution,
      windows: WINDOWS,
      medianWallMs,
      medianCpuMs: median(cpuSamples),
      realtimeFactor: WINDOW_MS / medianWallMs,
      slowdown: medianWallMs / WINDOW_MS,
    });
  } finally {
    subscription.dispose();
    rig.dispose();
  }
});
