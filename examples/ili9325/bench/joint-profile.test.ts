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

const mode = process.env.MICA_JOINT_PROFILE;

/** Mutually exclusive stack groups; percentages describe the sampled thread, not process CPU. */
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
    else if (named('boundary')) category = named('compiledBody') ? 'lcdReaction' : 'boundary';
    else if (named('runDirect'))
      category = stack.some(
        ({ callFrame }) =>
          !callFrame.url &&
          (callFrame.functionName === 'run' || callFrame.functionName.startsWith('stepShard')),
      )
        ? 'directGenerated'
        : 'directBridge';
    else if (named('runJit') || named('runUntil')) category = 'outerScheduler';
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
    const counts: Record<string, Record<string, number>> = {};
    const session = new Session();
    const countMode = mode === 'counts';
    try {
      joint.board.runUntil(0);
      joint.advanceTo(220_000_000_000);
      const mcuResources = joint.mcu as unknown as ResourceCounters;
      const periphBefore = mcuResources.memoryResources.get('periph')!.version;
      if (countMode) {
        for (const [id, instance] of [
          ['mcu', joint.mcu],
          ['lcd', joint.lcd],
        ] as const) {
          const host = (
            instance as unknown as { host: Record<string, (...args: unknown[]) => unknown> }
          ).host;
          const totals: Record<string, number> = (counts[id] = {});
          for (const name of [
            'read',
            'write',
            'sample',
            'intent',
            'resistor',
            'load',
            'store',
            'call',
          ]) {
            const original = host[name]!;
            host[name] = (...args) => {
              const resource = name === 'read' ? args[1] : args[0];
              const key = `${name}:${String(resource)}`;
              totals[key] = (totals[key] ?? 0) + 1;
              return original(...args);
            };
          }
        }
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
        writeFileSync(join(directory, 'calls.json'), JSON.stringify(counts, null, 2));
        for (const [id, entries] of Object.entries(counts)) {
          const methods: Record<string, number> = {};
          for (const [key, total] of Object.entries(entries)) {
            const name = key.split(':')[0]!;
            methods[name] = (methods[name] ?? 0) + total;
          }
          console.log(
            'HOT_CALLS',
            JSON.stringify({
              id,
              methods,
              top: Object.entries(entries)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20),
            }),
          );
        }
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
