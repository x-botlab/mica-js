import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import { types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { decode, guard } from '@mica-js/stm32g431rbt6-core/decode';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { PERIPHERALS } from '@mica-js/stm32g431rbt6-core/peripherals';

/**
 * 动态多寄存器 STM 的专属 JIT rig。
 *
 * 与 cpu-rig 一样使用真实 `model.ddl` 与真实 core decode/emit，但允许把多条指令
 * 合成一个 JIT 块（复现 adapter 的 collectBatch 结果），并在执行前直接写状态/内存。
 * 这样既能检查 translator 生成的真实 IR 规模，也能检查逐 word 的 CPU/内存语义。
 */

const MODEL_PATH = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src', 'model.ddl');

let modelCache: Promise<DeviceIR> | undefined;

const model = (): Promise<DeviceIR> => {
  modelCache ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  });

  return modelCache;
};

export interface DynamicStmRigOptions {
  readonly code: Uint8Array;
  /** 块内第一条指令的地址；默认 0。 */
  readonly pc?: number;
  /** 块内要顺序译码的指令条数；IT 指令自身的 itCount 会把后续指令按 guard 包装。 */
  readonly count: number;
  readonly states?: Readonly<Record<string, number | boolean>>;
  readonly sram?: Uint8Array;
  readonly ccm?: Uint8Array;
  readonly sys?: Uint8Array;
  readonly generic?: Uint8Array;
  readonly knownRegs?: readonly (number | undefined)[];
}

export interface DynamicStmRig {
  readonly states: Map<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly faults: readonly number[];
  readonly time: () => number;
  /** 成功 translate 后的真实 BlockIR；用于结构规模断言。 */
  block(): BlockIR | undefined;
  memory(name: string): Uint8Array;
  run(ps: number): void;
  state(name: string): unknown;
  dispose(): void;
}

interface InstanceView {
  readonly states: Map<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

interface RigMessage {
  readonly value: unknown;
}

interface DeviceContext {
  attachJit(options: { entry: string; code: string; pc: string; translate: JitTranslate }): {
    dispose(): void;
  };
  loadBytes(memory: string, data: Uint8Array, offset?: number): void;
}

export async function createDynamicStmRig(options: DynamicStmRigOptions): Promise<DynamicStmRig> {
  const device = await model();
  const faults: number[] = [];
  let translated: BlockIR | undefined;
  const machine: Machine = {
    clockFrequency: 16_000_000,
    cyclePs: 1,
    alternateDrivers: [],
    peripherals: [...PERIPHERALS],
    interruptSources: PERIPHERALS.flatMap((peripheral) => peripheral.interrupts ?? []),
    profile: 'stm-dynamic-rig',
  };
  const translate: JitTranslate = (input, block) => {
    void input;
    return activateMachine(machine, () => {
      const start = options.pc ?? 0;
      const regs = options.knownRegs?.slice() ?? Array<number | undefined>(16).fill(undefined);
      let cursor = start;
      let itRemaining = 0;

      block.instruction({ pc: start, nextPc: start }, (body) => {
        for (let index = 0; index < options.count; index += 1) {
          const decoded = decode(
            options.code,
            cursor,
            regs,
            options.code.byteLength,
            itRemaining > 0,
          );
          const instruction = itRemaining > 0 ? guard(decoded) : decoded;

          instruction.emit(body, cursor);
          if (itRemaining > 0) itRemaining -= 1;
          if (decoded.itCount > 0) itRemaining = decoded.itCount;
          cursor = (cursor + decoded.size) >>> 0;
        }
        body.elapse(body.constant(types.number, 1));
      });

      const finished = block.finish();

      translated = finished;
      return finished;
    });
  };

  const library = createDeviceLibrary([
    {
      id: 'stm',
      model: device,
      create: (context) => {
        const scope = context as unknown as DeviceContext;

        scope.attachJit({ entry: 'stm', code: 'code', pc: 'pc', translate });
        scope.loadBytes('code', options.code, 0);

        return {
          sync(batch: { readonly outputs: Readonly<Record<string, readonly RigMessage[]>> }) {
            for (const message of batch.outputs.fault ?? []) faults.push(message.value as number);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = createBoard(
    library,
    {
      instances: [{ id: 'stm', type: 'stm' }],
      nets: [],
    } as never,
    { execution: 'precise' },
  );
  const instance = (board as unknown as { readonly instances: readonly InstanceView[] })
    .instances[0]!;

  board.runUntil(0);
  instance.states.set('pc', options.pc ?? 0);
  if (options.states !== undefined)
    for (const [name, value] of Object.entries(options.states)) instance.states.set(name, value);
  if (options.sram !== undefined) instance.memories.get('sram')!.set(options.sram, 0);
  if (options.ccm !== undefined) instance.memories.get('ccm')!.set(options.ccm, 0);
  if (options.sys !== undefined) instance.memories.get('sys')!.set(options.sys, 0);
  if (options.generic !== undefined) instance.memories.get('generic')!.set(options.generic, 0);

  return {
    states: instance.states,
    memories: instance.memories,
    faults,
    time: () => board.time,
    block: () => translated,
    memory: (name) => {
      const bytes = instance.memories.get(name);

      if (bytes === undefined) throw new Error(`stm-dynamic-rig: unknown memory ${name}`);

      return bytes;
    },
    run: (ps) => board.runUntil(board.time + ps),
    state: (name) => instance.states.get(name),
    dispose: () => board.dispose(),
  };
}

/** 小端读取 32 位字。 */
export function readWord(target: Uint8Array, offset: number): number {
  return (
    ((target[offset] ?? 0) |
      ((target[offset + 1] ?? 0) << 8) |
      ((target[offset + 2] ?? 0) << 16) |
      ((target[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
