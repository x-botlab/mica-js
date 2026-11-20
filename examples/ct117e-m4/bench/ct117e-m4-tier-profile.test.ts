import { writeSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadFirmware } from '../test/firmware';
import {
  CT117E_M4_CLEAR_END_PS,
  CT117E_M4_CLEAR_START_PS,
  CT117E_M4_END_TIME_PS,
  CT117E_M4_EXPECTED,
  CT117E_M4_MID_TIME_PS,
  createHarness,
  lcdWorkDelta,
} from '../test/harness';

// Emit a fresh, named function in the V8 code log, using the same clock as tick and deopt records.
// Run once so that V8 emits bytecode even when the parser compiles functions lazily.
function mark(phase: 'begin' | 'end', round: number): void {
  new Function(`return function ct117e_clear_${phase}_${round}() {};`)()();
}

const QUANTUM_PS = 10_000_000_000;

/** Only the runtime fields read by this opt-in probe; the public harness hides JIT internals. */
interface EntryJit {
  readonly revision: number;
  readonly directRevision: number;
  readonly directStats?: Readonly<Record<string, number>>;
  readonly direct?: {
    readonly pcs: ReadonlySet<number>;
    readonly program: object;
    readonly frame: { readonly states: object };
  };
}

it.skipIf(process.env.MICA_CT117E_M4_TIER_PROFILE !== '1')(
  'samples the execution tier of generated code during the LCD clear',
  async () => {
    const { hex, imageSha256 } = loadFirmware();
    const packageDirectory = process.env.MICA_CT117E_M4_PACKAGE;
    const options = {
      hex,
      stepPs: QUANTUM_PS,
      ...(packageDirectory === undefined ? {} : { packageDirectory }),
    };
    const trackEntry = process.env.MICA_CT117E_M4_PROFILE_ENTRY === '1';
    await (await createHarness(options)).dispose();

    for (let round = 1; round <= 6; round++) {
      const harness = await createHarness(options);
      const { advanceTo: advance } = harness;
      const jit = harness.instance.jits[0] as EntryJit;
      const identities = new WeakMap<object, number>();
      let nextIdentity = 1;
      const identity = (value: object | undefined) => {
        if (!value) return null;
        const known = identities.get(value);
        if (known !== undefined) return known;
        const id = nextIdentity++;
        identities.set(value, id);
        return id;
      };
      const entry = [];
      const snapshot = () => {
        const direct = jit.direct;
        return {
          timePs: harness.runtime.getState().simTime,
          revision: jit.revision,
          directRevision: jit.directRevision,
          directCompiles: jit.directStats?.directCompiles,
          directStats: { ...jit.directStats },
          covered: direct?.pcs.size,
          program: identity(direct?.program),
          frame: identity(direct?.frame),
          states: identity(direct?.frame.states),
          frameKeys: direct && Object.keys(direct.frame),
        };
      };
      try {
        await advance(QUANTUM_PS);
        await advance(CT117E_M4_MID_TIME_PS);
        if (trackEntry) {
          // These are existing 10 ms cuts; do not force an extra suspension.
          for (
            let target = CT117E_M4_MID_TIME_PS;
            target < CT117E_M4_CLEAR_START_PS;
            target += QUANTUM_PS
          ) {
            await advance(target);
            entry.push(snapshot());
          }
        }
        await advance(CT117E_M4_CLEAR_START_PS);
        const before = harness.workload();
        if (trackEntry) entry.push(snapshot());

        mark('begin', round);
        const cpu = process.threadCpuUsage();
        const wall = performance.now();
        await advance(CT117E_M4_CLEAR_END_PS);
        const wallMs = performance.now() - wall;
        const thread = process.threadCpuUsage(cpu);
        mark('end', round);

        if (trackEntry) entry.push(snapshot());
        const work = lcdWorkDelta(before, harness.workload());
        await advance(CT117E_M4_END_TIME_PS);
        expect(work).toEqual(CT117E_M4_EXPECTED.clear);
        expect(harness.workload()).toMatchObject(CT117E_M4_EXPECTED.final);
        expect(harness.runtime.getState()).toEqual({
          status: 'paused',
          simTime: CT117E_M4_END_TIME_PS,
        });
        expect(harness.diagnostics).toEqual([]);
        expect(harness.faults).toEqual([]);
        expect(harness.errors).toEqual([]);
        writeSync(
          1,
          `CT117E_TIER_PROFILE ${JSON.stringify({
            round,
            imageSha256,
            wallMs,
            threadMs: (thread.user + thread.system) / 1000,
            work,
            ...(trackEntry ? { entry } : {}),
          })}\n`,
        );
      } finally {
        await harness.dispose();
      }
    }
  },
  1_800_000,
);
