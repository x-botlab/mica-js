import { withCheckpointDiagnostics } from './batch-execution-fixture.mjs';
import { CHECKPOINTS, fixture } from './observable-batch-fixture.mjs';

const cases = [
  { kind: 'Lcd', options: { mutateAt: 40 }, cuts: [39, 40, 41, 99, 159, 160, 161] },
  { kind: 'Lcd', options: { observe: true }, cuts: [159, 160, 161] },
  {
    kind: 'Dma',
    options: { mutateAt: 40, competitorAt: 50 },
    cuts: [39, 40, 41, 49, 50, 51, 79, 80, 81, 169, 170, 171],
  },
  {
    kind: 'Parking',
    options: { mutateAt: 6, competitorAt: 5 },
    cuts: [4, 5, 6, 9, 10, 11, 14, 15, 16],
  },
];

function verify(api, modelApi) {
  return withCheckpointDiagnostics(() =>
    cases.map(({ kind, options, cuts }) => {
      const workload = fixture(api, modelApi, kind, options);
      const ordinary = workload.create(false);
      const enabled = workload.create(true);
      try {
        let parked = false;
        for (const time of cuts) {
          ordinary.board.runUntil(time);
          enabled.board.runUntil(time);
          if (JSON.stringify(ordinary.snapshot()) !== JSON.stringify(enabled.snapshot()))
            throw new Error(`${kind}: differential failed at ${time} ps`);
          parked ||= enabled.board.instances[0].jits[0]?.pollingReservation !== undefined;
        }
        const a = ordinary.board[CHECKPOINTS]();
        const b = enabled.board[CHECKPOINTS]();
        const stats = kind === 'Dma' ? b.batchExecution.process : b.batchExecution.jit;
        const hit = kind === 'Parking' ? parked : stats.executed > 0;
        if (hit === !!options.observe || stats.committed !== stats.published)
          throw new Error(`${kind}: unexpected admissions or publication count`);
        return {
          kind,
          options,
          cuts,
          ordinary: a.batchExecution,
          enabled: b.batchExecution,
          parked,
        };
      } finally {
        ordinary.board.dispose();
        enabled.board.dispose();
      }
    }),
  );
}

const variants = ['disabled', 'enabled', 'controlDisabled', 'controlEnabled'];

function makeRun(api, modelApi, kind, size, variant) {
  const workload = fixture(api, modelApi, kind, {
    items: size,
    periods: size,
    declareBatch: !variant.startsWith('control'),
  });
  const enabled = variant === 'enabled' || variant === 'controlEnabled';
  return () => {
    const start = globalThis.performance.now();
    const { board } = workload.create(enabled);
    try {
      board.runUntil(workload.end + 1);
    } finally {
      board.dispose();
    }
    return globalThis.performance.now() - start;
  };
}

function median(samples) {
  const values = [...samples].sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
}

export function acceptance(api, modelApi, { size, warmup, samples, memory }) {
  if (memory) {
    const [kind, variant] = memory.split(':');
    const run = makeRun(api, modelApi, kind, size, variant);
    for (let index = 0; index < samples; index++) run();
    return { kind, variant, size, completed: samples };
  }
  const checks = verify(api, modelApi);
  const timings = ['Lcd', 'Dma', 'Parking'].map((kind) => {
    const runners = variants.map((variant) => makeRun(api, modelApi, kind, size, variant));
    const rows = variants.map(() => []);
    for (let i = -warmup; i < samples; i++) {
      for (let j = 0; j < variants.length; j++) {
        const index = (i + warmup + j) % variants.length;
        const time = runners[index]();
        if (i >= 0) rows[index].push(time);
      }
    }
    const medians = Object.fromEntries(
      variants.map((variant, index) => [variant, median(rows[index])]),
    );
    return {
      kind,
      medianMs: medians,
      enabledRatio: medians.enabled / medians.disabled,
      ordinaryPathRatio: medians.controlEnabled / medians.controlDisabled,
      samplesMs: Object.fromEntries(variants.map((variant, index) => [variant, rows[index]])),
    };
  });
  return { checks, timings, size, warmup, samples };
}
