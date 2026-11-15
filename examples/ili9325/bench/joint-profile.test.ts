import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Profiler } from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJointBoard, JOINT_440MS_EXPECTED, nonZeroGramPixels } from '../test/joint-harness';

interface ResourceCounters {
  readonly memoryResources: ReadonlyMap<string, { readonly version: number }>;
  readonly sampleResources: ReadonlyMap<string, { readonly version: number }>;
}

type Counter = Record<string, number>;
/** Generic host calls and bound-handle calls are deliberately separate. */
interface CountBucket {
  readonly generic: Counter;
  readonly bound: Counter;
  readonly publish: Counter;
  readonly commit: Counter;
}
interface CounterState {
  active: boolean;
  depth: number;
}
type HostLike = Record<string, (...args: unknown[]) => unknown>;
type HandleLike = Record<string, unknown>;
interface DirectFrameLike {
  host?: { publish?: (phase: string) => boolean };
}
interface DirectJitCounter {
  readonly direct?: { readonly frame: DirectFrameLike };
  readonly directStats?: {
    readonly directCompiles?: number;
    readonly directCalls?: number;
    readonly directFallbacks?: number;
  };
  readonly instance: {
    commitDirectState(layout: { readonly stateNames: readonly string[] }, index: number): void;
  };
}
type RecordCall = (
  scope: 'generic' | 'bound',
  method: string,
  resource: string,
  original: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: readonly unknown[],
) => unknown;

const emptyBucket = (): CountBucket => ({ generic: {}, bound: {}, publish: {}, commit: {} });

function genericMethodName(name: string): string {
  if (name === 'memoryLength') return 'length';
  if (name === 'copyBytes') return 'copy';
  return name;
}

function genericResource(name: string, args: readonly unknown[]): string {
  const at = (index: number): string => String(args[index]);

  switch (name) {
    case 'read':
      return `${at(0)}/${at(1)}`;
    case 'load':
    case 'store':
      return `${at(0)}/${at(1)}`;
    case 'write':
    case 'call':
    case 'send':
    case 'notify':
    case 'memoryLength':
    case 'copyBytes':
      return at(0);
    case 'now':
    case 'random':
    case 'assert':
      return '';
    default:
      return at(0);
  }
}

function summarize(section: Counter): {
  readonly total: number;
  readonly methods: Counter;
  readonly top: readonly (readonly [string, number])[];
} {
  const methods: Counter = {};
  let total = 0;
  for (const [key, count] of Object.entries(section)) {
    const method = key.slice(0, key.indexOf(':'));
    methods[method] = (methods[method] ?? 0) + count;
    total += count;
  }
  return {
    total,
    methods,
    top: Object.entries(section)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20),
  };
}

function makeRecorder(bucket: CountBucket, state: CounterState): RecordCall {
  return (scope, method, resource, original, thisArg, args) => {
    if (!state.active || state.depth > 0) return Reflect.apply(original, thisArg, args);
    state.depth += 1;
    try {
      const section = scope === 'generic' ? bucket.generic : bucket.bound;
      const key = `${method}:${resource}`;
      section[key] = (section[key] ?? 0) + 1;
      return Reflect.apply(original, thisArg, args);
    } finally {
      state.depth -= 1;
    }
  };
}

function wrapHandle(
  handle: HandleLike,
  spec: readonly [string, string],
  record: RecordCall,
): HandleLike {
  const resource = `${spec[0]}:${spec[1]}`;
  const wrapped: HandleLike = {};

  for (const [method, value] of Object.entries(handle)) {
    if (typeof value !== 'function') {
      wrapped[method] = value;
      continue;
    }
    wrapped[method] = (...args: unknown[]) =>
      record('bound', method, resource, value as (...args: unknown[]) => unknown, handle, args);
  }
  return Object.freeze(wrapped);
}

/** Install before the first run: synchronous runners bind their handles during initialization. */
function installCounters(instance: unknown, bucket: CountBucket, state: CounterState): void {
  const host = (instance as { readonly host: HostLike }).host;
  const record = makeRecorder(bucket, state);
  const originalBind = host.bind;

  if (typeof originalBind === 'function') {
    host.bind = function (this: HostLike, specs: unknown) {
      const handles = Reflect.apply(originalBind, this, [specs]) as readonly HandleLike[];
      const list = specs as readonly (readonly [string, string])[];

      return handles.map((handle, index) => wrapHandle(handle, list[index]!, record));
    };
  }

  for (const name of [
    'read',
    'write',
    'sample',
    'intent',
    'resistor',
    'memoryLength',
    'load',
    'store',
    'copyBytes',
    'send',
    'notify',
    'call',
    'now',
    'random',
    'assert',
  ]) {
    const original = host[name];

    if (typeof original !== 'function') continue;
    host[name] = function (this: HostLike, ...args: unknown[]) {
      return record(
        'generic',
        genericMethodName(name),
        genericResource(name, args),
        original,
        this,
        args,
      );
    };
  }
}

const mode = process.env.MICA_JOINT_PROFILE;

/**
 * Mutually exclusive stack groups; percentages describe the sampled thread, not process CPU.
 *
 * Group precedence is deliberately fixed: gc > fixtureFrames > electrical > boundary >
 * direct > outerScheduler > other. Every sample gets exactly one group.
 *
 * The boundary group includes the electrical/observation/reaction dispatcher. A stack that
 * reaches the model reaction body is split out as `lcdReaction`: the current synchronous
 * runner is entered through `runReaction`, while older generator bodies still show
 * `compiledBody`. Keep both names so profiles from either execution path remain comparable.
 *
 * `directGenerated` means the emitted PC/shard body itself. The runtime publication
 * checkpoint (`publishDirectFrame`, `commitDirectFrame`, `commitDirectState`, and the
 * generated `publish` bridge) is `directBridge`; boundary/electrical/reaction work below
 * that checkpoint keeps its own group because those checks precede the direct branch.
 */
function profileGroups(profile: Profiler.Profile): Record<string, number> {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();

  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const categories = new Map<number, string>();

  for (const node of profile.nodes) {
    const stack: Profiler.ProfileNode[] = [];
    let current: Profiler.ProfileNode | undefined = node;

    while (current !== undefined) {
      stack.push(current);
      current = nodes.get(parents.get(current.id)!);
    }
    const named = (name: string) => stack.some((entry) => entry.callFrame.functionName === name);
    let category: string;

    if (named('(garbage collector)')) category = 'gc';
    else if (named('assembleFrames')) category = 'fixtureFrames';
    else if (stack.some((entry) => entry.callFrame.url.endsWith('/src/electrical.ts')))
      category = 'electrical';
    else if (named('boundary'))
      category = named('compiledBody') || named('runReaction') ? 'lcdReaction' : 'boundary';
    else if (named('runDirect')) {
      const checkpoint =
        named('publishDirectFrame') ||
        named('commitDirectFrame') ||
        named('commitDirectState') ||
        stack.some(
          ({ callFrame }) =>
            callFrame.functionName === 'publish' && callFrame.url.endsWith('/runtime/jit.ts'),
        );
      const generated = stack.some(
        ({ callFrame }) =>
          !callFrame.url &&
          (callFrame.functionName === 'run' || callFrame.functionName.startsWith('stepShard')),
      );

      category = checkpoint || !generated ? 'directBridge' : 'directGenerated';
    } else if (named('runJit') || named('runUntil')) category = 'outerScheduler';
    else category = 'other';
    categories.set(node.id, category);
  }
  const counts: Record<string, number> = {};

  for (const id of profile.samples ?? []) {
    const category = categories.get(id)!;

    counts[category] = (counts[category] ?? 0) + 1;
  }
  const total = profile.samples?.length ?? 0;

  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => [
        category,
        total === 0 ? 0 : Number(((count * 100) / total).toFixed(2)),
      ]),
  );
}

/** Explicit diagnostic only: MICA_JOINT_PROFILE=cpu or counts. Never a timed perf round. */
describe.skipIf(mode !== 'cpu' && mode !== 'counts')('joint post-window profile', () => {
  it('measures only 220 → 440 ms with complete edges', async () => {
    const joint = await createJointBoard();
    const directory = mkdtempSync(join(tmpdir(), 'mica-joint-hotpath-'));
    const counts: Record<string, CountBucket> = {};
    const countStates: CounterState[] = [];
    const session = new Session();
    const countMode = mode === 'counts';
    let directJit: DirectJitCounter | undefined;
    let directFrame: DirectFrameLike | undefined;
    let directCompilesBefore: number | undefined;
    let directCallsBefore: number | undefined;
    let directFallbacksBefore: number | undefined;

    // Install before the first run: synchronous reaction runners bind their handles during
    // initialization, so wrapping only after 220 ms would miss the hot-window handles.
    if (countMode) {
      for (const [id, instance] of [
        ['mcu', joint.mcu],
        ['lcd', joint.lcd],
      ] as const) {
        const state: CounterState = { active: false, depth: 0 };
        const bucket = emptyBucket();

        countStates.push(state);
        counts[id] = bucket;
        installCounters(instance, bucket, state);
      }
    }

    try {
      joint.board.runUntil(0);
      joint.advanceTo(220_000_000_000);
      const mcuResources = joint.mcu as unknown as ResourceCounters;
      const periphBefore = mcuResources.memoryResources.get('periph')!.version;
      if (countMode) {
        const jit = (joint.board as unknown as { jits?: readonly DirectJitCounter[] }).jits?.[0];

        if (jit === undefined || jit.direct?.frame.host?.publish === undefined)
          throw new Error('counts mode requires a stable direct publish checkpoint');

        const frame = jit.direct!.frame;
        const originalPublish = frame.host!.publish!;
        const originalCommit = jit.instance.commitDirectState;

        directJit = jit;
        directFrame = frame;
        directCompilesBefore = jit.directStats?.directCompiles;
        directCallsBefore = jit.directStats?.directCalls;
        directFallbacksBefore = jit.directStats?.directFallbacks;

        frame.host!.publish = (phase) => {
          if (countStates[0]!.active)
            counts.mcu!.publish[phase] = (counts.mcu!.publish[phase] ?? 0) + 1;
          return originalPublish(phase);
        };
        jit.instance.commitDirectState = function (
          this: DirectJitCounter['instance'],
          layout,
          index,
        ) {
          if (countStates[0]!.active) {
            const name = layout.stateNames[index]!;

            counts.mcu!.commit[name] = (counts.mcu!.commit[name] ?? 0) + 1;
          }
          return Reflect.apply(originalCommit, this, [layout, index]) as void;
        };
        for (const state of countStates) state.active = true;
      } else {
        session.connect();
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 100 });
        await session.post('Profiler.start');
      }
      const cpu = process.cpuUsage();
      const wall = performance.now();
      joint.advanceTo(440_000_000_000);
      const wallMs = performance.now() - wall;
      const usage = process.cpuUsage(cpu);
      const cpuMs = (usage.user + usage.system) / 1000;
      if (countMode) {
        for (const state of countStates) state.active = false;
        writeFileSync(join(directory, 'calls.json'), JSON.stringify(counts, null, 2));
        for (const [id, entries] of Object.entries(counts)) {
          const stats = id === 'mcu' ? directJit?.directStats : undefined;
          const direct =
            stats === undefined
              ? undefined
              : {
                  calls: (stats.directCalls ?? 0) - (directCallsBefore ?? 0),
                  fallbacks: (stats.directFallbacks ?? 0) - (directFallbacksBefore ?? 0),
                  compiles: (stats.directCompiles ?? 0) - (directCompilesBefore ?? 0),
                };

          console.log(
            'HOT_CALLS',
            JSON.stringify({
              id,
              generic: summarize(entries.generic),
              bound: summarize(entries.bound),
              publish: entries.publish,
              commit: entries.commit,
              ...(direct === undefined ? {} : { direct }),
            }),
          );
        }

        // A stable post window must not rebuild the direct program: the wrapped frame and
        // host publish checkpoint would otherwise cover only part of the measured window.
        expect(directJit?.directStats?.directCompiles).toBe(directCompilesBefore);
        expect(directJit?.direct?.frame).toBe(directFrame);
      } else {
        const { profile } = await session.post('Profiler.stop');
        writeFileSync(join(directory, 'post.cpuprofile'), JSON.stringify(profile));
        const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
        const self = new Map<number, number>();
        for (const id of profile.samples ?? []) self.set(id, (self.get(id) ?? 0) + 1);
        const samples = profile.samples?.length ?? 0;
        const top = [...self]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 35)
          .map(([id, hits]) => {
            const frame = nodes.get(id)!.callFrame;
            return {
              name: frame.functionName,
              url: frame.url,
              line: frame.lineNumber + 1,
              percent: Number(((hits * 100) / samples).toFixed(2)),
            };
          });
        const summary = { samples, groups: profileGroups(profile), top };

        writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
        console.log('HOT_PROFILE', JSON.stringify(summary));
      }
      expect(joint.errors).toEqual([]);
      expect(joint.faults).toEqual([]);
      const internal = joint.lcd as unknown as ResourceCounters;
      expect(internal.memoryResources.get('gram')!.version).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(internal.sampleResources.get('WR')!.version).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(nonZeroGramPixels(joint.lcd.memories.get('gram')!)).toBe(
        JOINT_440MS_EXPECTED.nonZeroPixels,
      );
      const result = {
        directory,
        mode,
        cpuMs,
        wallMs,
        mcuPeriphChanges: mcuResources.memoryResources.get('periph')!.version - periphBefore,
      };
      writeFileSync(join(directory, 'window.json'), JSON.stringify(result, null, 2));
      console.log('HOT_WINDOW', JSON.stringify(result));
    } finally {
      session.disconnect();
      joint.dispose();
    }
  }, 900_000);
});
