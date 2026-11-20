import { vi } from 'vitest';
import type { Board, DeviceAdapter } from '@mica-js/simulator';

interface DeviceInstanceState {
  readonly jits: readonly unknown[];
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly adapter: DeviceAdapter;
}

const observer = vi.hoisted(() => ({ boards: undefined as Board[] | undefined }));

// The fused SDK intentionally hides the simulator board. Keep a reference for assertions and
// opt-in diagnostics only. The actual board, model factory and scheduling are not replaced.
vi.mock(import('@mica-js/simulator'), async (importOriginal) => {
  const simulator = await importOriginal();
  return {
    ...simulator,
    createBoard(...args: Parameters<typeof simulator.createBoard>) {
      const board = simulator.createBoard(...args);
      observer.boards?.push(board);
      return board;
    },
  };
});

export async function observeBoard<T extends { dispose(): Promise<void> }>(
  create: () => Promise<T>,
): Promise<{ runtime: T; board: Board; instance: DeviceInstanceState }> {
  if (observer.boards !== undefined) throw new Error('Board observation must run serially');

  const boards: Board[] = [];
  observer.boards = boards;
  try {
    const runtime = await create();
    const instances = (boards[0] as (Board & { instances: DeviceInstanceState[] }) | undefined)
      ?.instances;
    if (boards.length !== 1 || instances?.length !== 1 || instances[0]!.jits.length !== 1) {
      await runtime.dispose();
      throw new Error(
        `Expected one board, instance and JIT; got ${boards.length}, ` +
          `${instances?.length ?? 0}, ${instances?.[0]?.jits.length ?? 0}`,
      );
    }
    return { runtime, board: boards[0]!, instance: instances[0]! };
  } finally {
    observer.boards = undefined;
  }
}
