// Register the test-only board observer before importing the fused runtime.
import { observeBoard } from './board-observer';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { timePs } from '@mica-js/core';
import { createHeadlessRuntime } from '@mica-js/sdk/fused';
import { createDirectoryRegistry, readDirectoryPackage } from '@mica-js/sdk/fused/node';
import type { RuntimeDiagnostic } from '@mica-js/sdk/fused';

export const CT117E_M4_DEVICE_ID = 'example:ct117e-m4';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = 'lcd-test';
const ARTIFACT = new URL('../dist/', import.meta.url);
const ROOT = fileURLToPath(ARTIFACT);

export const CT117E_M4_TIME_QUANTUM_PS = 200_000_000;
export const CT117E_M4_MID_TIME_PS = 220_000_000_000;
export const CT117E_M4_END_TIME_PS = 440_000_000_000;
export const CT117E_M4_CLEAR_START_PS = 360_000_000_000;
export const CT117E_M4_CLEAR_END_PS = 390_000_000_000;

/** `HAL_06_LCD.hex` 的固定工作量，与分立 LCD 总线 oracle 对账。 */
export const CT117E_M4_EXPECTED = Object.freeze({
  midpoint: Object.freeze({ wrChanges: 80, gramStores: 0, frames: 0, nonZeroPixels: 0 }),
  clear: Object.freeze({ wrChanges: 104_338, gramStores: 52_169, frames: 2 }),
  final: Object.freeze({
    wrChanges: 157_338,
    gramStores: 77_351,
    frames: 3,
    nonZeroPixels: 76_800,
  }),
});

export interface Workload {
  readonly timePs: number;
  readonly wrChanges: number;
  readonly gramStores: number;
  readonly frames: number;
  readonly framePixels: number;
  readonly nonZeroPixels: number;
}

export function lcdWorkDelta(before: Workload, after: Workload) {
  return {
    wrChanges: after.wrChanges - before.wrChanges,
    gramStores: after.gramStores - before.gramStores,
    frames: after.frames - before.frames,
  };
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function sameFrames(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return (
    left.length === right.length && left.every((frame, index) => sameBytes(frame, right[index]!))
  );
}

interface HarnessOptions {
  /** 原始 Intel HEX，交由融合宿主解码。 */
  readonly hex: Uint8Array;
  readonly stepPs?: number;
  /** 额外读取模型原始 frameInfo 时间，仅用于与分立 oracle 对账。 */
  readonly captureFrameTimes?: boolean;
}

let artifactPromise: ReturnType<typeof readDirectoryPackage> | undefined;

/** 通过正式 registry、program loader、模型客户端和事件运行发布包。 */
export async function createHarness({
  hex,
  stepPs = CT117E_M4_TIME_QUANTUM_PS,
  captureFrameTimes = false,
}: HarnessOptions) {
  const { lock } = await (artifactPromise ??= readDirectoryPackage(ROOT));
  if (lock.id !== CT117E_M4_DEVICE_ID) throw new Error(`Unexpected package ${lock.id}`);

  const frames: Uint8Array[] = [];
  const frameTimes: number[] = [];
  const deliveryTimes: number[] = [];
  const faults: number[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const { runtime, board, instance } = await observeBoard(() =>
    createHeadlessRuntime({
      document: {
        version: 2,
        dependencies: { [lock.id]: { version: lock.version, integrity: lock.integrity } },
        instances: [
          {
            id: INSTANCE_ID,
            device: lock.id,
            designator: 'U1',
            placement: { x: 0, y: 0, rotation: 0 },
            properties: { firmware: { mode: 'project', projectId: PROJECT_ID } },
          },
        ],
        nodes: [],
        wires: [],
        labels: [],
        references: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            target: { kind: 'pin', instance: INSTANCE_ID, pin: 'VDD1' },
            voltage: 3.3,
            symbol: 'power',
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            target: { kind: 'pin', instance: INSTANCE_ID, pin: 'VSS1' },
            voltage: 0,
            symbol: 'ground',
          },
        ],
      },
      registry: createDirectoryRegistry({ [lock.id]: ROOT }),
      loadModule: async (_files, path) => import(new URL(path, ARTIFACT).href),
      step: timePs(stepPs),
      programs: {
        projects: {
          async resolve(projectId, target) {
            if (
              projectId !== PROJECT_ID ||
              target.deviceId !== lock.id ||
              target.property !== 'firmware' ||
              target.loader !== 'memory'
            )
              throw new Error(`Unexpected firmware target ${projectId}/${target.deviceId}`);
            return { kind: 'memory', format: 'hex', data: hex };
          },
        },
      },
      onDiagnostic: (entry) => diagnostics.push(entry),
      onModelEvent: ({ event, payload }) => {
        if (event === 'onDidFramebuffer' && payload.value instanceof Uint8Array) {
          frames.push(payload.value);
          deliveryTimes.push(payload.simTime);
        } else if (event === 'onDidFault' && typeof payload.value === 'number') {
          faults.push(payload.value);
        }
      },
    }),
  );

  const errors: string[] = [];
  const subscription = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));
  if (captureFrameTimes) {
    const sync = instance.adapter.sync;
    instance.adapter.sync = function (batch) {
      const { frameInfo } = batch.outputs as { frameInfo: readonly { time: number }[] };
      for (const info of frameInfo) frameTimes.push(info.time);
      sync.call(this, batch);
    };
  }

  const state = (name: string): unknown => {
    if (!instance.states.has(name)) throw new Error(`Missing state ${name}`);
    return instance.states.get(name);
  };
  const memory = (name: string): Uint8Array => {
    const bytes = instance.memories.get(name);
    if (bytes === undefined) throw new Error(`Missing memory ${name}`);
    return bytes;
  };

  return {
    runtime,
    instance,
    frames,
    frameTimes,
    deliveryTimes,
    diagnostics,
    errors,
    faults,
    state,
    memory,
    async framebuffer(): Promise<Uint8Array> {
      const result = await runtime.getModel(INSTANCE_ID).methods['getFramebuffer']!(null);
      if (!(result instanceof Uint8Array)) throw new TypeError('Expected framebuffer bytes');
      return result;
    },
    workload(): Workload {
      const wrChanges = state('fusedWrChanges');
      const gramStores = state('fusedGramStores');
      if (typeof wrChanges !== 'number' || typeof gramStores !== 'number')
        throw new Error('Expected numeric LCD counters');

      let framePixels = 0;
      for (const frame of frames) {
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const pixels = view.getUint16(4, true) * view.getUint16(6, true);
        if (frame.length !== 8 + pixels * 2) throw new Error('Unexpected framebuffer length');
        framePixels += pixels;
      }

      const gram = memory('gram');
      const view = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);
      let nonZeroPixels = 0;
      for (let at = 0; at < gram.length; at += 2)
        if (view.getUint16(at, true) !== 0) nonZeroPixels += 1;

      return {
        timePs: runtime.getState().simTime,
        wrChanges,
        gramStores,
        frames: frames.length,
        framePixels,
        nonZeroPixels,
      };
    },
    async advanceTo(targetPs: number): Promise<void> {
      const from = runtime.getState().simTime;
      const steps = (timePs(targetPs) - from) / stepPs;
      if (!Number.isSafeInteger(steps) || steps < 0)
        throw new Error(`Cannot reach ${targetPs} ps from ${from} ps in ${stepPs} ps steps`);
      for (let index = 0; index < steps; index++) await runtime.step();
      if (runtime.getState().simTime !== targetPs)
        throw new Error(`Fused runtime did not reach ${targetPs} ps`);
    },
    async dispose(): Promise<void> {
      try {
        await runtime.dispose();
      } finally {
        subscription.dispose();
      }
    },
  };
}
