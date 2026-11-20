import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import { types } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
import { decode, guard } from '@mica-js/stm32g431rbt6-core/decode';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';

/**
 * CPU 指令的专属 IR rig。
 *
 * 用真实的 `model.ddl` 建板，但把 JIT 换成「每个块只译码一条指令 + elapse 1 ps」。
 * 这样可以逐条检查寄存器/APSR/内存语义，又不依赖 GPIO 或完整固件。状态与内存通过
 * `Board` 内部实例视图读写，和现有 `polling.test.ts` 的做法一致。
 */

const MODEL_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'stm32g431rbt6',
  'src',
  'model.ddl',
);

let modelCache: Promise<DeviceIR> | undefined;

const model = (): Promise<DeviceIR> => {
  modelCache ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  });

  return modelCache;
};

export interface CpuRigOptions {
  /** 从 code 偏移 0 开始装载的指令/常量字节。 */
  readonly code: Uint8Array;
  /** 显式 logical code base；省略保持旧 Flash mask 行为。 */
  readonly codeBase?: number;
  /** 初始 sp；默认 0x20005800。 */
  readonly sp?: number;
  /** 初始 pc；默认 0。 */
  readonly pc?: number;
  /** 在第一次执行前写入的 state。 */
  readonly states?: Readonly<Record<string, number | boolean>>;
  /** 在第一次执行前写入的 sram 字节（从偏移 0 开始）。 */
  readonly sram?: Uint8Array;
  /** 在第一次执行前写入的 ccm 字节（从偏移 0 开始）。 */
  readonly ccm?: Uint8Array;
  /** 在第一次执行前写入的 sys 字节（SCB/VTOR/隐藏状态都在这里）。 */
  readonly sys?: Uint8Array;
  /** 强制按 IT 块内指令包装（测试用；真实批处理由 index.ts collectBatch 决定）。 */
  readonly conditional?: boolean;
  /** 翻译期入口寄存器常量；用于让静态 SRAM 访问走 `at` 快路径。 */
  readonly knownRegs?: readonly (number | undefined)[];
  /** 执行后端；默认 precise，便于逐条观察 state。 */
  readonly execution?: 'throughput' | 'precise';
}

interface InstanceView {
  readonly states: Map<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

interface RigMessage {
  readonly value: unknown;
}

interface DeviceContext {
  attachJit(options: {
    entry: string;
    code: string;
    pc: string;
    translate: JitTranslate;
    polling?: readonly unknown[];
  }): { dispose(): void };
  loadBytes(memory: string, data: Uint8Array, offset?: number): void;
}

export interface CpuRig {
  readonly states: Map<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly faults: readonly number[];
  readonly time: () => number;
  readonly direct: () => boolean;
  run(ps: number): void;
  state(name: string): unknown;
  setState(name: string, value: number | boolean): void;
  dispose(): void;
}

export async function createCpuRig(options: CpuRigOptions): Promise<CpuRig> {
  const device = await model();
  const faults: number[] = [];
  const machine: Machine = {
    clockFrequency: 16_000_000,
    cyclePs: 1,
    alternateDrivers: [],
    peripherals: [],
    interruptSources: [],
    profile: 'cpu-rig',
  };
  const translate: JitTranslate = ({ pc, code }, block) =>
    activateMachine(machine, () => {
      const length = Math.min(code.byteLength, options.code.byteLength);
      const instruction = decode(
        code,
        pc,
        options.knownRegs?.slice(),
        length,
        options.conditional === true,
        options.codeBase === undefined
          ? undefined
          : { base: options.codeBase, size: length },
      );
      const wrapped = options.conditional === true ? guard(instruction) : instruction;

      block.instruction({ pc, nextPc: (pc + instruction.size) >>> 0 }, (body) => {
        wrapped.emit(body, pc);
        body.elapse(body.constant(types.number, 1));
      });
      return block.finish();
    });

  const library = createDeviceLibrary([
    {
      id: 'cpu',
      model: device,
      create: (context) => {
        const scope = context as unknown as DeviceContext;

        scope.attachJit({ entry: 'cpu', code: 'code', pc: 'pc', translate });
        scope.loadBytes('code', options.code, 0);

        return {
          sync(batch: { readonly outputs: Readonly<Record<string, readonly RigMessage[]>> }) {
            for (const message of batch.outputs.fault ?? [])
              faults.push(message.value as number);
          },
          dispose() {},
        };
      },
    },
  ]);

  const board = createBoard(
    library,
    {
      instances: [{ id: 'cpu', type: 'cpu' }],
      nets: [],
    } as never,
    { execution: options.execution ?? 'precise' },
  );
  const instance = (
    board as unknown as { readonly instances: readonly InstanceView[] }
  ).instances[0]!;

  // 让 model 的 process start 先跑完（它会从 code[0..7] 取复位向量），随后覆盖为
  // 测试指定的 pc/sp；否则第一条指令会从代码字节被当成向量表的位置开始。
  board.runUntil(0);

  instance.states.set('pc', options.pc ?? 0);
  if (options.sp !== undefined) instance.states.set('sp', options.sp);
  if (options.states !== undefined)
    for (const [name, value] of Object.entries(options.states)) instance.states.set(name, value);
  if (options.sram !== undefined) instance.memories.get('sram')!.set(options.sram, 0);
  if (options.ccm !== undefined) instance.memories.get('ccm')!.set(options.ccm, 0);
  if (options.sys !== undefined) instance.memories.get('sys')!.set(options.sys, 0);

  return {
    states: instance.states,
    memories: instance.memories,
    faults,
    time: () => board.time,
    direct: () => {
      const jit = (board as unknown as { jits?: readonly { direct?: unknown }[] }).jits?.[0];

      return jit?.direct !== undefined;
    },
    run: (ps) => board.runUntil(board.time + ps),
    state: (name) => instance.states.get(name),
    setState: (name, value) => instance.states.set(name, value),
    dispose: () => board.dispose(),
  };
}

/** 小端写入 32 位字；测试构造 vector/栈帧用。 */
export function writeWord(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/** 小端读取 32 位字。 */
export function readWord(target: Uint8Array, offset: number): number {
  return (
    (target[offset] ?? 0) |
    ((target[offset + 1] ?? 0) << 8) |
    ((target[offset + 2] ?? 0) << 16) |
    ((target[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

/** 从字节数组构造 code；不足部分补零。 */
export function codeOf(bytes: readonly number[], length = 0x100): Uint8Array {
  const code = new Uint8Array(length);

  bytes.forEach((value, index) => {
    code[index] = value & 0xff;
  });
  return code;
}
