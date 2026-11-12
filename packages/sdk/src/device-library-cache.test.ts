import { describe, expect, it, vi } from 'vitest';

/**
 * 校验缓存位于 `validateDeviceIR` 内部，装载入口每次都会调用它，因此「校验次数」只能通过
 * 产出物计数：真正完成一次校验才会得到一份新的冻结快照，命中的调用返回同一份快照。
 */
const calls = vi.hoisted(() => ({ attempts: [] as unknown[], snapshots: [] as unknown[] }));

vi.mock('@mica-js/device-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mica-js/device-model')>();
  return {
    ...actual,
    validateDeviceIR(input: unknown) {
      calls.attempts.push(input);
      const result = actual.validateDeviceIR(input);
      calls.snapshots.push(result);
      return result;
    },
  };
});

const { createDeviceLibrary } = await import('@mica-js/simulator');

const model = (): never => ({ kind: 'device', name: 'Node', declarations: [] }) as never;
const create = () => ({ sync: () => {}, dispose: () => {} });
const reset = () => {
  calls.attempts.length = 0;
  calls.snapshots.length = 0;
};

describe('device library validation cache', () => {
  it('同一 model 对象被重复装载时只校验一次', () => {
    const definition = model();
    reset();

    const first = createDeviceLibrary([{ id: 'node', model: definition, create }]);
    const second = createDeviceLibrary([{ id: 'node', model: definition, create }]);

    expect(calls.attempts).toHaveLength(2);
    expect(calls.attempts[0]).toBe(definition);
    expect(calls.snapshots).toHaveLength(2);
    expect(new Set(calls.snapshots).size).toBe(1);
    expect(second).not.toBe(first);
  });

  it('非法 model 每次装载都重新校验并报同样的错', () => {
    const invalid = { kind: 'device', name: 'Node' } as never;
    reset();
    const messages: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        createDeviceLibrary([{ id: 'node', model: invalid, create }]);
        messages.push('no error');
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(calls.attempts).toHaveLength(2);
    expect(calls.snapshots).toEqual([]);
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toContain('declarations');
  });
});
