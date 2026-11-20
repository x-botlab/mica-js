import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR, JitInstructionBuilder, Value } from '@mica-js/sdk/model';
import { compileDDL } from '@mica-js/sdk/ddl';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';
import { timerCaptureGateDescriptors } from '@mica-js/stm32g431rbt6-core/tim';
import type { TimerCaptureGateDescriptor } from '@mica-js/stm32g431rbt6-core/tim';
import { LOCAL_CAPTURE_PINS } from '../../../stm32g431rbt6-core/scripts/render-capture-gates';

/**
 * TIM capture FIFO fn-unit rig。
 *
 * 这是 **fn unit**，不是生产 adapter E2E：直接编译生产 `model.ddl`，用测试 JIT 指令调用
 * 生产 `mcuReset`/`pushCapture`，不注册或替换 `PERIPHERALS`，不 mock profile。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const TEST_PC = 0x100;
const RESET_PC = 0x200;
const STOP_PC = 0x300;
const EDGE_TIME_PS = 5_000_000_000;
const CORE = 4_294_967_296;

let modelCache: Promise<DeviceIR> | undefined;

export function captureFifoModel(): Promise<DeviceIR> {
  modelCache ??= compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  });

  return modelCache;
}

const number = (b: JitInstructionBuilder, value: number) => b.constant(types.number, value);
const bool = (b: JitInstructionBuilder, value: boolean) => b.constant(types.bool, value);

function setupDescriptors(): readonly TimerCaptureGateDescriptor[] {
  return LOCAL_CAPTURE_PINS.map((pinName) => {
    const descriptor = timerCaptureGateDescriptors().find(
      (candidate) => candidate.pinName === pinName,
    );

    if (descriptor === undefined) throw new Error(`missing capture descriptor for ${pinName}`);

    return descriptor;
  });
}

/** 用 descriptor 字段配置 RCC/TIM/GPIO；不复制位域常量到测试。 */
function configureGate(
  b: JitInstructionBuilder,
  descriptors: readonly TimerCaptureGateDescriptor[],
): void {
  const enables = new Map<number, number>();
  const resets = new Set<number>();
  const stateValues = new Map<string, number>();

  for (const descriptor of descriptors) {
    for (const gate of [descriptor.gpioClockGate, descriptor.timerClockGate]) {
      enables.set(gate.enable, (enables.get(gate.enable) ?? 0) | ((1 << gate.bit) >>> 0));
      if (gate.reset >= 0) resets.add(gate.reset);
    }

    stateValues.set(
      descriptor.moderState,
      (stateValues.get(descriptor.moderState) ?? 0) | ((2 << descriptor.moderShift) >>> 0),
    );
    stateValues.set(
      descriptor.afrState,
      (stateValues.get(descriptor.afrState) ?? 0) | ((descriptor.af << descriptor.afrShift) >>> 0),
    );

    b.store32le(
      'tim',
      number(b, descriptor.timerMemoryOffset + descriptor.cr1Offset),
      number(b, 1),
    );
    b.store32le(
      'tim',
      number(b, descriptor.timerMemoryOffset + descriptor.ccmrOffset),
      number(b, (1 << descriptor.ccxsShift) >>> 0),
    );
    b.store32le(
      'tim',
      number(b, descriptor.timerMemoryOffset + descriptor.ccerOffset),
      number(b, (1 << descriptor.ccerShift) >>> 0),
    );
  }

  for (const [offset, value] of enables) b.store32le('periph', number(b, offset), number(b, value));
  for (const offset of resets) b.store32le('periph', number(b, offset), number(b, 0));
  for (const [name, value] of stateValues) b.writeState(name, number(b, value));
}

function proofStore(b: JitInstructionBuilder, offset: number, value: Value<number>): void {
  b.store32le('sram', number(b, offset), value);
}

function snapshot(b: JitInstructionBuilder, base: number): void {
  proofStore(b, base + 0x00, b.readState('captureHead', types.number));
  proofStore(b, base + 0x04, b.readState('captureTail', types.number));
  proofStore(b, base + 0x08, b.readState('capturePending', types.number));
  proofStore(b, base + 0x0c, b.readState('captureOverflow', types.number));
  proofStore(b, base + 0x10, b.readState('captureResume', types.number));
  proofStore(b, base + 0x14, b.readState('serviceMask', types.number));
  proofStore(b, base + 0x18, b.readState('faultPc', types.number));
  proofStore(
    b,
    base + 0x1c,
    b.select(
      types.number,
      b.readState('halted', types.bool),
      (yes) => yes.constant(types.number, 1),
      (no) => no.constant(types.number, 0),
    ),
  );
}

function setupBlock(model: DeviceIR, descriptors: readonly TimerCaptureGateDescriptor[]): BlockIR {
  const builder = createJitBlockBuilder({ device: model });

  builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
    const b = asBody(body);

    b.call('mcuReset');
    // 门控未配置：这次 push 必须不入队。
    b.call('pushCapture', number(b, 0), bool(b, true));
    b.store32le('sram', number(b, 0x1100), b.readState('captureHead', types.number));
    b.store32le('sram', number(b, 0x1104), b.readState('captureTail', types.number));
    b.store32le('sram', number(b, 0x1108), b.readState('capturePending', types.number));
    configureGate(b, descriptors);
    b.redirect(number(b, TEST_PC), number(b, EDGE_TIME_PS));
  });

  return builder.finish();
}

function loopBlock(model: DeviceIR): BlockIR {
  const builder = createJitBlockBuilder({ device: model });

  builder.instruction({ pc: TEST_PC, nextPc: TEST_PC }, (body) => {
    const b = asBody(body);

    b.if(
      b.notEqual(types.number, b.readState('captureOverflow', types.number), number(b, 0)),
      (done) => {
        const scope = asBody(done);

        // overflow/halted 后多次 push 必须完全 no-op。
        scope.call('pushCapture', number(scope, 0), bool(scope, true));
        scope.call('pushCapture', number(scope, 1), bool(scope, false));
        scope.call('pushCapture', number(scope, 0), bool(scope, false));
        scope.store32le('sram', number(scope, 0x1110), scope.readState('pc', types.number));
        scope.store32le(
          'sram',
          number(scope, 0x1114),
          scope.readState('captureResume', types.number),
        );
        scope.store32le(
          'sram',
          number(scope, 0x1118),
          scope.readState('captureTail', types.number),
        );
        scope.store32le(
          'sram',
          number(scope, 0x111c),
          scope.readState('captureOverflow', types.number),
        );
        scope.redirect(number(scope, RESET_PC));
      },
      (push) => {
        const scope = asBody(push);
        const pinId = scope.bitAnd(scope.readState('captureTail', types.number), number(scope, 1));

        scope.call('pushCapture', pinId, scope.equal(types.number, pinId, number(scope, 0)));
        scope.writeState('pc', number(scope, TEST_PC));
      },
    );
  });

  return builder.finish();
}

function resetBlock(model: DeviceIR, descriptors: readonly TimerCaptureGateDescriptor[]): BlockIR {
  const builder = createJitBlockBuilder({ device: model });

  builder.instruction({ pc: RESET_PC, nextPc: RESET_PC }, (body) => {
    const b = asBody(body);
    const hash = b.local(types.number, number(b, 0));
    const at = b.local(types.number, number(b, 0));

    snapshot(b, 0x1000);
    b.while(
      (test) => test.lessThan(test.getLocal(at), test.constant(types.number, 0x400)),
      (loop) => {
        const scope = asBody(loop);
        const byte = scope.load8('captureFifo', scope.getLocal(at));

        scope.setLocal(
          hash,
          scope.remainder(
            scope.add(scope.multiply(scope.getLocal(hash), scope.constant(types.number, 33)), byte),
            scope.constant(types.number, CORE),
          ),
        );
        scope.setLocal(at, scope.add(scope.getLocal(at), scope.constant(types.number, 1)));
      },
    );
    proofStore(b, 0x1020, b.getLocal(hash));

    b.call('mcuReset');
    snapshot(b, 0x1040);
    configureGate(b, descriptors);
    b.writeState('pc', number(b, RESET_PC));
    b.call('pushCapture', number(b, 0), bool(b, true));
    b.writeState('pc', number(b, RESET_PC));
    b.redirect(number(b, STOP_PC));
  });

  return builder.finish();
}

function stopBlock(model: DeviceIR): BlockIR {
  const builder = createJitBlockBuilder({ device: model });

  builder.instruction({ pc: STOP_PC, nextPc: STOP_PC }, (body) => body.stop());

  return builder.finish();
}

export interface CaptureFifoRig {
  readonly faults: readonly number[];
  readonly errors: readonly string[];
  readonly states: ReadonlyMap<string, unknown>;
  memory(name: string): Uint8Array;
  dispose(): void;
}

export async function createCaptureFifoRig(): Promise<CaptureFifoRig> {
  const model = await captureFifoModel();
  const descriptors = setupDescriptors();
  const blocks = new Map<number, BlockIR>([
    [0, setupBlock(model, descriptors)],
    [TEST_PC, loopBlock(model)],
    [RESET_PC, resetBlock(model, descriptors)],
    [STOP_PC, stopBlock(model)],
  ]);
  const faults: number[] = [];
  const errors: string[] = [];

  const board = createBoard(
    createDeviceLibrary([
      {
        id: 'mcu',
        model,
        create: ((context: {
          attachJit(options: {
            entry: string;
            code: string;
            pc: string;
            translate: (input: { readonly pc: number }) => BlockIR;
          }): void;
          loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
        }) => {
          context.attachJit({
            entry: 'capture',
            code: 'code',
            pc: 'pc',
            translate: ({ pc }) => {
              const block = blocks.get(pc);

              if (block === undefined)
                throw new Error(`unexpected capture fn-unit pc 0x${pc.toString(16)}`);

              return block;
            },
          });
          context.loadBytes('code', new Uint8Array(0x400));

          return {
            sync(batch: {
              readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
            }) {
              for (const message of batch.outputs.fault ?? []) faults.push(message.value as number);
            },
            dispose() {},
          };
        }) as never,
      },
    ] as never),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } }],
      nets: [],
    } as never,
    { execution: 'precise' },
  );

  const errorsSubscription = board.onDidError((error) => errors.push(error.message));

  // 让生产 process start 先跑完（code 全零 -> pc=0），再进入 setup block。
  board.runUntil(0);
  board.runUntil(EDGE_TIME_PS + 1_000_000_000);

  const instance = (
    board as unknown as {
      readonly instances?: readonly {
        readonly states: ReadonlyMap<string, unknown>;
        readonly memories: ReadonlyMap<string, Uint8Array>;
      }[];
    }
  ).instances?.[0];

  return {
    faults,
    errors,
    states: instance?.states ?? new Map(),
    memory: (name) => instance?.memories.get(name) ?? new Uint8Array(),
    dispose: () => {
      errorsSubscription.dispose();
      board.dispose();
    },
  };
}

export const CAPTURE_FIFO_RIG = {
  EDGE_TIME_PS,
  CORE,
  TEST_PC,
  RESET_PC,
  STOP_PC,
} as const;
