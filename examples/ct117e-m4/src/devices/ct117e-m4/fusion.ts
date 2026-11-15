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
] as const;
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
  const transform = (value: unknown, samples: Map<number, string>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.flatMap((entry) => {
        const result = transform(entry, samples);
        return result === undefined ? [] : Array.isArray(result) ? result : [result];
      });
    const op = value as OperationIR;
    if (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1') {
      samples.set(op.result, op.pin.name);
      return undefined;
    }
    if (op.kind === 'field' && samples.has(op.value)) {
      if (op.field !== 'level') throw new Error('Fused GPIO only supports digital samples');
      const pin = next++;
      return [
        {
          kind: 'constant',
          result: pin,
          type: { kind: 'number' },
          constant: { kind: 'number', value: FUSED_WIRES.indexOf(samples.get(op.value)!) },
        },
        {
          kind: 'callValue',
          name: 'fusedLevel',
          pure: false,
          result: op.result,
          type: { kind: 'number' },
          args: [{ kind: 'value', value: pin }],
        },
      ];
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
      const index = FUSED_WIRES.indexOf(op.pin.name);
      if (index < 0) return undefined;
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
      const before = next++;
      const prefix: OperationIR[] = touched.has(16)
        ? [
            {
              kind: 'read',
              resource: 'state',
              name: 'fusedWire16',
              result: before,
              type: { kind: 'number' },
            },
          ]
        : [];
      const suffix: OperationIR[] = [];
      if (touched.has(16))
        suffix.push({
          kind: 'call',
          name: 'fusedWr',
          pure: false,
          args: [{ kind: 'value', value: before }],
        });
      if (touched.has(18) || touched.has(19))
        suffix.push({ kind: 'call', name: 'fusedReadWindow', pure: false, args: [] });
      const duration = transformed.operations.find(
        (op) => 'result' in op && op.result === last.duration,
      );
      if (!duration || !['constant', 'localRead'].includes(duration.kind))
        throw new Error('Unexpected MCU duration shape');
      const expanded = inlineCalls(
        {
          operations: [
            ...prefix,
            ...transformed.operations.slice(0, -1).filter((op) => op !== duration),
            ...suffix,
            duration,
            last,
          ],
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
