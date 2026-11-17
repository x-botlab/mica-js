import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import { types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { decode, guard } from '@mica-js/stm32g431rbt6-core/decode';
import type { CodeBytes, Instruction } from '@mica-js/stm32g431rbt6-core/decode';
import { decodeVfp32, isVfpEncoding } from '@mica-js/stm32g431rbt6-core/fpu';
import { FPU_ACTIVE, FPU_FPSCR, FPU_S_BASE } from '@mica-js/stm32g431rbt6-core/fpu-layout';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { SCB_STATE } from '@mica-js/stm32g431rbt6-core/layout';

/**
 * FPU 专属 IR rig：真实 model.ddl + 真实 JIT。
 *
 * CPU owner 的 thumb32 hook 落地前，VFP 由 `decodeVfp32` 直接进入 JIT；非 VFP 仍走
 * 生产 `decode`。这样验证的是同一条 IR/总线/执行器，而不是纯 JS 模拟器。
 */

const MODEL_PATH = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src', 'model.ddl');
const SYSCFG_CPACR = SCB_STATE + 0x88;

let modelCache: Promise<DeviceIR> | undefined;

const model = (): Promise<DeviceIR> => {
  modelCache ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  });

  return modelCache;
};

export interface FpuRigOptions {
  readonly code: Uint8Array;
  readonly sp?: number;
  readonly pc?: number;
  readonly sram?: Uint8Array;
  readonly sys?: Uint8Array;
  readonly states?: Readonly<Record<string, number | boolean>>;
  readonly cpacr?: number;
  readonly knownRegs?: readonly (number | undefined)[];
  readonly sRegisters?: Readonly<Record<number, number>>;
  readonly fpscr?: number;
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

export interface FpuRig {
  readonly states: Map<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly faults: readonly number[];
  readonly direct: () => boolean;
  run(ps: number): void;
  state(name: string): unknown;
  setState(name: string, value: number | boolean): void;
  readS(index: number): number;
  writeS(index: number, value: number): void;
  readFpscr(): number;
  writeFpscr(value: number): void;
  fpuActive(): boolean;
  writeWord(address: number, value: number): void;
  readWord(address: number): number;
  dispose(): void;
}

const sizeAt = (code: CodeBytes, offset: number): number =>
  ((code[offset & 0x1ffff] ?? 0) | ((code[(offset + 1) & 0x1ffff] ?? 0) << 8)) >= 0xe800 ? 4 : 2;

function itRemainingAt(code: CodeBytes, pc: number): number {
  let remaining = 0;

  for (let back = 2; back <= 18; back += 2) {
    const start = (pc - back) >>> 0;
    const h1 = (code[start & 0x1ffff] ?? 0) | ((code[(start + 1) & 0x1ffff] ?? 0) << 8);

    if ((h1 & 0xff00) !== 0xbf00) continue;
    const mask = h1 & 0xf;

    if (mask === 0 || ((h1 >> 4) & 0xf) === 0xf) continue;
    let count = 1;

    while (count < 4 && ((mask << count) & 0xf) !== 0) count += 1;
    let cursor = (start + 2) >>> 0;

    for (let index = 0; index < count; index += 1) {
      if (cursor === pc) {
        remaining = Math.max(remaining, count - index);
        break;
      }
      if (cursor > pc) break;
      cursor = (cursor + sizeAt(code, cursor)) >>> 0;
    }
  }

  return remaining;
}

export async function createFpuRig(options: FpuRigOptions): Promise<FpuRig> {
  const device = await model();
  const faults: number[] = [];
  const machine: Machine = {
    clockFrequency: 16_000_000,
    cyclePs: 1,
    alternateDrivers: [],
    peripherals: [],
    interruptSources: [],
    profile: 'fpu-rig',
  };
  const blockCache = new Map<number, BlockIR>();
  const knownRegs = options.knownRegs === undefined ? undefined : [...options.knownRegs];
  const translate: JitTranslate = ({ pc, code }, block) => {
    const cached = blockCache.get(pc);

    if (cached !== undefined) return cached;

    const finished = activateMachine(machine, () => {
      const h1 = (code[pc & 0x1ffff] ?? 0) | ((code[(pc + 1) & 0x1ffff] ?? 0) << 8);
      const h2 =
        h1 >= 0xe800 ? (code[(pc + 2) & 0x1ffff] ?? 0) | ((code[(pc + 3) & 0x1ffff] ?? 0) << 8) : 0;
      let instruction: Instruction;

      if (h1 >= 0xe800 && isVfpEncoding(h1, h2)) {
        const decoded = decodeVfp32(h1, h2, pc, code, code.byteLength, knownRegs);

        instruction = {
          size: 4,
          cycles: decoded.cycles,
          endsBatch: decoded.terminates === true || decoded.boundaryAfter === true,
          mayService: decoded.mayService,
          ...(decoded.dynamicMemory === undefined ? {} : { dynamicMemory: decoded.dynamicMemory }),
          ...(decoded.boundaryAfter === undefined ? {} : { boundaryAfter: decoded.boundaryAfter }),
          ...(decoded.terminates === undefined ? {} : { terminates: decoded.terminates }),
          itCount: 0,
          emit: decoded.emit,
        };
      } else
        instruction = {
          ...decode(code, pc, knownRegs, code.byteLength),
          itCount: 0,
        };

      if (itRemainingAt(code, pc) > 0) instruction = guard(instruction);

      block.instruction({ pc, nextPc: (pc + instruction.size) >>> 0 }, (body) => {
        instruction.emit(body, pc);
        body.elapse(body.constant(types.number, 1));
      });
      return block.finish();
    });

    blockCache.set(pc, finished);

    return finished;
  };

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
      instances: [{ id: 'cpu', type: 'cpu' }],
      nets: [],
    } as never,
    { execution: options.execution ?? 'precise' },
  );
  const instance = (board as unknown as { readonly instances: readonly InstanceView[] })
    .instances[0]!;

  board.runUntil(0);
  instance.states.set('pc', options.pc ?? 0);
  if (options.sp !== undefined) instance.states.set('sp', options.sp);
  if (options.states !== undefined)
    for (const [name, value] of Object.entries(options.states)) instance.states.set(name, value);
  if (options.sram !== undefined) instance.memories.get('sram')!.set(options.sram, 0);

  const sys = new Uint8Array(0x200);
  if (options.sys !== undefined) sys.set(options.sys.subarray(0, 0x200));
  const cpacr = options.cpacr ?? 0x00f00000;

  sys[SYSCFG_CPACR] = cpacr & 0xff;
  sys[SYSCFG_CPACR + 1] = (cpacr >>> 8) & 0xff;
  sys[SYSCFG_CPACR + 2] = (cpacr >>> 16) & 0xff;
  sys[SYSCFG_CPACR + 3] = (cpacr >>> 24) & 0xff;
  instance.memories.get('sys')!.set(sys, 0);

  const sysMemory = instance.memories.get('sys')!;
  const periphMemory = instance.memories.get('periph')!;
  const writeBytes = (target: Uint8Array, address: number, value: number): void => {
    for (let byte = 0; byte < 4; byte += 1) target[address + byte] = (value >>> (byte * 8)) & 0xff;
  };
  const readBytes = (target: Uint8Array, address: number): number =>
    ((target[address] ?? 0) |
      ((target[address + 1] ?? 0) << 8) |
      ((target[address + 2] ?? 0) << 16) |
      ((target[address + 3] ?? 0) << 24)) >>>
    0;

  if (options.sRegisters !== undefined)
    for (const [index, value] of Object.entries(options.sRegisters))
      writeBytes(periphMemory, FPU_S_BASE + (Number(index) & 31) * 4, value);
  if (options.fpscr !== undefined) writeBytes(periphMemory, FPU_FPSCR, options.fpscr);

  return {
    states: instance.states,
    memories: instance.memories,
    faults,
    direct: () => {
      const jit = (board as unknown as { jits?: readonly { direct?: unknown }[] }).jits?.[0];

      return jit?.direct !== undefined;
    },
    run: (ps) => board.runUntil(board.time + ps),
    state: (name) => instance.states.get(name),
    setState: (name, value) => instance.states.set(name, value),
    readS: (index) => readBytes(periphMemory, FPU_S_BASE + (index & 31) * 4),
    writeS: (index, value) => writeBytes(periphMemory, FPU_S_BASE + (index & 31) * 4, value),
    readFpscr: () => readBytes(periphMemory, FPU_FPSCR),
    writeFpscr: (value) => writeBytes(periphMemory, FPU_FPSCR, value),
    fpuActive: () => readBytes(periphMemory, FPU_ACTIVE) !== 0,
    writeWord: (address, value) => writeBytes(sysMemory, address, value),
    readWord: (address) => readBytes(sysMemory, address),
    dispose: () => board.dispose(),
  };
}

export function codeOf(bytes: readonly number[], length = 0x100): Uint8Array {
  const code = new Uint8Array(length);

  bytes.forEach((value, index) => {
    code[index] = value & 0xff;
  });
  return code;
}

export function f32(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);

  view.setFloat32(0, value, false);

  return view.getUint32(0, false);
}

export function fromF32(bits: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);

  view.setUint32(0, bits >>> 0, false);

  return view.getFloat32(0, false);
}
