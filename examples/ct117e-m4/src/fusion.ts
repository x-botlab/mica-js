import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { inlineCalls } from './inline';

/** Fixed CT117E wiring, internal to one device; no inter-device electrical nets. */
export const FUSED_WIRES = [
  ...Array.from({ length: 16 }, (_, bit) => `PC${bit}`),
  'PB5',
  'PB8',
  'PB9',
  'PA8',
  'PD2',
  'PA0',
  'PB0',
  'PB1',
  'PB2',
  'PB6',
  'PB7',
  'PB12',
  'PB14',
  'PB15',
  'PA15',
  'PB4',
] as const;

type FusedWireName = (typeof FUSED_WIRES)[number];
type FusedWireAlias = Lowercase<FusedWireName>;
type FusedWireControl = 'wr' | 'rs' | 'cs' | 'rd';

/**
 * 命名别名只从上面的唯一索引源派生；控制线的语义别名也用 `indexOf` 定位，
 * 不再维护第二份 0–31 数字表。热路径仍按数字比较，不做名称查找。
 */
export const FUSED_WIRE = Object.freeze({
  ...Object.fromEntries(FUSED_WIRES.map((name, index) => [name.toLowerCase(), index] as const)),
  wr: FUSED_WIRES.indexOf('PB5'),
  rs: FUSED_WIRES.indexOf('PB8'),
  cs: FUSED_WIRES.indexOf('PB9'),
  rd: FUSED_WIRES.indexOf('PA8'),
}) as Readonly<Record<FusedWireAlias | FusedWireControl, number>>;

const FUSED_WIRE_INDEX = new Map<string, number>(
  FUSED_WIRES.map((name, index) => [name, index] as const),
);

/** `fusedStatus`/`fusedVoltage` 的保留编码；与 model.ddl 中的分支一致。 */
const SAMPLE_FLOATING = -1;
const SAMPLE_VDDA = -2;
const SAMPLE_VREFP = -3;
const SAMPLE_VBAT = -4;

function sampleWire(name: string): number {
  if (name === 'VDDA') return SAMPLE_VDDA;
  if (name === 'VREFP') return SAMPLE_VREFP;
  if (name === 'VBAT') return SAMPLE_VBAT;
  // 板上未接出的 ADC 通道保持浮空；不要退化成确定 0 V。
  return FUSED_WIRE_INDEX.get(name) ?? SAMPLE_FLOATING;
}

export const FUSED_FRAME_PC = 0x20050;
const frameBuilder = createJitBlockBuilder();
frameBuilder.instruction({ pc: FUSED_FRAME_PC, nextPc: FUSED_FRAME_PC }, (b) => {
  b.writeState(
    'frameSeq',
    b.add(b.readState('frameSeq', types.number), b.constant(types.number, 1)),
  );
  b.writeState('pc', b.readState('fusedFrameResume', types.number));
  b.elapse(b.readState('fusedFrameDelay', types.number));
});
export const FUSED_FRAME_BLOCK = frameBuilder.finish();

const fusedBlocks = new WeakMap<BlockIR, BlockIR>();

/**
 * GPIO's actual mode/pull/open-drain selection stays in the original translator. Only the
 * final resistor-to-rail intent is lowered to an ideal internal digital level. This device
 * has fixed 3.3 V power and one bus master; analog contention is outside its contract.
 */
export function fuseBlock(block: BlockIR, model: DeviceIR): BlockIR {
  const cached = fusedBlocks.get(block);
  if (cached) return cached;
  let next = 0;
  let needsFusion = false;
  const scan = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const op = value as OperationIR;
    if (
      op.kind === 'writeIntent' ||
      (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1')
    )
      needsFusion = true;
    if ('result' in value && typeof value.result === 'number')
      next = Math.max(next, value.result + 1);
    for (const entry of Object.values(value)) scan(entry);
  };
  scan(block);
  if (!needsFusion) {
    fusedBlocks.set(block, block);
    return block;
  }
  let touched = new Set<number>();
  const sampleLocals = new Map<number, number>();
  const transform = (value: unknown, samples: Map<number, number>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.flatMap((entry) => {
        const result = transform(entry, samples);
        return result === undefined ? [] : Array.isArray(result) ? result : [result];
      });
    const op = value as OperationIR;
    if (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1') {
      samples.set(op.result, sampleWire(op.pin.name));
      return undefined;
    }
    // `sample` 是核心 ADC 的局部快照；fused 用线号代替整个 sample 值。
    if (op.kind === 'local' && op.type.kind === 'sample') {
      const wire = samples.get(op.initial);
      if (wire === undefined)
        throw new Error('Fused analog samples must come from a pin or supply read');
      sampleLocals.set(op.local, wire);
      return undefined;
    }
    if (op.kind === 'localRead' && sampleLocals.has(op.local)) {
      samples.set(op.result, sampleLocals.get(op.local)!);
      return undefined;
    }
    if (op.kind === 'localWrite' && sampleLocals.has(op.local))
      throw new Error('Fused analog sample locals are immutable');
    if (op.kind === 'field' && samples.has(op.value)) {
      const wire = samples.get(op.value)!;
      const wireValue = next++;
      const constant: OperationIR = {
        kind: 'constant',
        result: wireValue,
        type: { kind: 'number' },
        constant: { kind: 'number', value: wire },
      };
      if (op.field === 'level')
        return [
          constant,
          {
            kind: 'callValue',
            // PC0–PC15 保持原 `fusedLevel` 的短路径；追加线才进入板载器件电平。
            name: wire >= 0 && wire < 20 ? 'fusedLevel' : 'fusedDeviceLevel',
            pure: false,
            result: op.result,
            type: { kind: 'number' },
            args: [{ kind: 'value', value: wireValue }],
          },
        ];
      if (op.field === 'status')
        return [
          constant,
          {
            kind: 'callValue',
            name: 'fusedStatus',
            pure: false,
            result: op.result,
            type: op.type,
            args: [{ kind: 'value', value: wireValue }],
          },
        ];
      if (op.field === 'voltage') {
        const voltage = next++;
        return [
          constant,
          {
            kind: 'callValue',
            name: 'fusedVoltage',
            pure: false,
            result: voltage,
            type: { kind: 'number' },
            args: [{ kind: 'value', value: wireValue }],
          },
          { kind: 'optional', result: op.result, type: op.type, value: voltage },
        ];
      }
      throw new Error(`Fused sample field ${op.field} is not supported`);
    }
    if (op.kind === 'resistor') {
      if (op.to.kind !== 'pin' || !['VDD1', 'VSS1'].includes(op.to.name))
        throw new Error('Fused GPIO intent must refer to a supply rail');
      return {
        kind: 'constant',
        result: op.result,
        type: { kind: 'number' },
        constant: { kind: 'number', value: op.to.name === 'VDD1' ? 1 : 0 },
      };
    }
    if (op.kind === 'combineIntents') {
      if (op.values.length)
        throw new Error('Fused GPIO does not support parallel internal drivers');
      return {
        kind: 'constant',
        result: op.result,
        type: { kind: 'number' },
        constant: { kind: 'number', value: -1 },
      };
    }
    if (op.kind === 'writeIntent') {
      if (op.pin.kind !== 'pin') throw new Error('Fused GPIO requires a static pin');
      const index = FUSED_WIRE_INDEX.get(op.pin.name);
      if (index === undefined) return undefined;
      touched.add(index);
      return { kind: 'write', resource: 'state', name: `fusedWire${index}`, value: op.value };
    }
    if (
      'kind' in value &&
      (value.kind === 'intent' ||
        (value.kind === 'enum' &&
          'name' in value &&
          value.name === 'Logic' &&
          !('member' in value)))
    )
      return { kind: 'number' };
    if (op.kind === 'constant' && op.constant.kind === 'enum' && op.constant.name === 'Logic')
      return {
        ...op,
        type: { kind: 'number' },
        constant: {
          kind: 'number',
          value: op.constant.member === 'high' ? 1 : op.constant.member === 'low' ? 0 : -1,
        },
      };
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, transform(entry, samples)]),
    );
  };
  const result: BlockIR = {
    ...block,
    instructions: block.instructions.map((instruction) => {
      touched = new Set();
      const transformed = transform(instruction.body, new Map()) as RegionIR;
      const last = transformed.operations.at(-1);
      if (last?.kind !== 'elapse') throw new Error('Fused MCU must end in elapse');
      const prefix: OperationIR[] = [];
      const suffix: OperationIR[] = [];
      let beforeWr: number | undefined;
      let beforePd2: number | undefined;
      if (touched.has(FUSED_WIRE.wr)) {
        beforeWr = next++;
        prefix.push({
          kind: 'read',
          resource: 'state',
          name: `fusedWire${FUSED_WIRE.wr}`,
          result: beforeWr,
          type: { kind: 'number' },
        });
      }
      if (touched.has(FUSED_WIRE.pd2)) {
        beforePd2 = next++;
        prefix.push({
          kind: 'read',
          resource: 'state',
          name: `fusedWire${FUSED_WIRE.pd2}`,
          result: beforePd2,
          type: { kind: 'number' },
        });
      }
      // 同一次 MCU 写只触发组回调：WR 完成 LCD 周期，PD2 推进 573 锁存。
      // I²C/555 接入时在这里按 PB6/PB7、PA15/PB4 组追加回调，不逐针回调。
      if (beforeWr !== undefined)
        suffix.push({
          kind: 'call',
          name: 'fusedWr',
          pure: false,
          args: [{ kind: 'value', value: beforeWr }],
        });
      if (beforePd2 !== undefined)
        suffix.push({
          kind: 'call',
          name: 'fusedLatch',
          pure: false,
          args: [{ kind: 'value', value: beforePd2 }],
        });
      if (touched.has(FUSED_WIRE.cs) || touched.has(FUSED_WIRE.rd))
        suffix.push({ kind: 'call', name: 'fusedReadWindow', pure: false, args: [] });
      if (touched.has(25) || touched.has(26))
        suffix.push({ kind: 'call', name: 'fusedI2c', pure: false, args: [] });
      // 时长表达式可能是 single-instruction 块的乘法结果，不能假定只有
      // constant/localRead；保留它原来的位置，后缀回调仍紧挨 elapse 之前。
      const expanded = inlineCalls(
        {
          operations: [...prefix, ...transformed.operations.slice(0, -1), ...suffix, last],
        },
        model,
      );
      let requestsFrame = false;
      const inspect = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (
          'kind' in value &&
          value.kind === 'write' &&
          'name' in value &&
          value.name === 'fusedFramePending'
        )
          requestsFrame = true;
        Object.values(value).forEach(inspect);
      };
      inspect(expanded);
      if (!requestsFrame) return { ...instruction, body: expanded };
      const tail = expanded.operations.at(-1);
      if (tail?.kind !== 'elapse') throw new Error('Fused MCU must end in elapse');
      scan(expanded);
      const pending = next++,
        zero = next++,
        delay = next++,
        resume = next++,
        pc = next++,
        no = next++;
      return {
        ...instruction,
        body: {
          operations: [
            ...expanded.operations.slice(0, -1),
            {
              kind: 'read',
              resource: 'state',
              name: 'fusedFramePending',
              type: { kind: 'bool' },
              result: pending,
            },
            {
              kind: 'constant',
              type: { kind: 'number' },
              constant: { kind: 'number', value: 0 },
              result: zero,
            },
            {
              kind: 'select',
              condition: pending,
              type: { kind: 'number' },
              result: delay,
              yes: {
                type: { kind: 'number' },
                body: { operations: [{ kind: 'yield', value: zero }] },
              },
              no: {
                type: { kind: 'number' },
                body: { operations: [{ kind: 'yield', value: tail.duration }] },
              },
            },
            {
              kind: 'if',
              condition: pending,
              yes: {
                operations: [
                  {
                    kind: 'write',
                    resource: 'state',
                    name: 'fusedFrameDelay',
                    value: tail.duration,
                  },
                  {
                    kind: 'read',
                    resource: 'state',
                    name: 'pc',
                    type: { kind: 'number' },
                    result: resume,
                  },
                  { kind: 'write', resource: 'state', name: 'fusedFrameResume', value: resume },
                  {
                    kind: 'constant',
                    type: { kind: 'number' },
                    constant: { kind: 'number', value: FUSED_FRAME_PC },
                    result: pc,
                  },
                  { kind: 'write', resource: 'state', name: 'pc', value: pc },
                  {
                    kind: 'constant',
                    type: { kind: 'bool' },
                    constant: { kind: 'bool', value: false },
                    result: no,
                  },
                  { kind: 'write', resource: 'state', name: 'fusedFramePending', value: no },
                ],
              },
            },
            { kind: 'elapse', duration: delay },
          ],
        },
      };
    }),
  };
  fusedBlocks.set(block, result);
  return result;
}
