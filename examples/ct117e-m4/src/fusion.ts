import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR, OperationIR, RegionIR, ValueTypeIR } from '@mica-js/sdk/model';
import { inlineCalls, LCD_WIRE_COUNT, lcdLevelFunction } from './inline';
import { BOARD_WIRES, FUSED_WIRES } from './board-wires';
import { mapChildRegions, rewriteRegion, walkOperations } from './regions';

const VREFP = -3;
const VDDA = -2;
const sampleWire = (name: string) =>
  name === 'VREFP' ? VREFP : name === 'VDDA' ? VDDA : FUSED_WIRES.indexOf(name);
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

function lowerType(type: ValueTypeIR): ValueTypeIR {
  if (type.kind === 'intent' || (type.kind === 'enum' && type.name === 'Logic'))
    return { kind: 'number' };
  if (type.kind === 'optional') {
    const inner = lowerType(type.inner);
    if (inner !== type.inner && inner.kind !== 'optional') return { ...type, inner };
  }
  return type;
}

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
  for (const { body } of block.instructions) {
    walkOperations(body, (op) => {
      if (
        op.kind === 'writeIntent' ||
        (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1')
      )
        needsFusion = true;
      if ('result' in op) next = Math.max(next, op.result + 1);
    });
  }
  if (!needsFusion) {
    fusedBlocks.set(block, block);
    return block;
  }
  function transform(input: RegionIR, touched: Set<number>): RegionIR {
    const samples = new Map<number, number>();
    const sampleLocals = new Map<number, number>();
    const region = (body: RegionIR): RegionIR => rewriteRegion(body, lower);
    function lower(op: OperationIR): OperationIR | OperationIR[] | undefined {
      if (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1') {
        samples.set(op.result, sampleWire(op.pin.name));
        return undefined;
      }
      if (op.kind === 'local' && op.type.kind === 'sample' && samples.has(op.initial)) {
        sampleLocals.set(op.local, samples.get(op.initial)!);
        return undefined;
      }
      if (op.kind === 'localRead' && sampleLocals.has(op.local)) {
        samples.set(op.result, sampleLocals.get(op.local)!);
        return undefined;
      }
      if (op.kind === 'localWrite' && sampleLocals.has(op.local))
        throw new Error('Fused sample locals must be immutable');
      if (op.kind === 'field' && samples.has(op.value)) {
        const wire = samples.get(op.value)!;
        const lcdLevel = op.field === 'level' && wire >= 0 && wire < LCD_WIRE_COUNT;
        const result = op.field === 'voltage' ? next++ : op.result;
        const name =
          op.field === 'level'
            ? lcdLevel
              ? lcdLevelFunction(wire)
              : 'boardLevel'
            : op.field === 'voltage'
              ? 'boardAnalog'
              : op.field === 'status'
                ? 'boardAnalogStatus'
                : undefined;
        if (name === undefined) throw new Error(`Unsupported fused sample field ${op.field}`);
        const field: OperationIR[] = [];
        const args = [];
        if (!lcdLevel) {
          const pin = next++;
          field.push({
            kind: 'constant',
            result: pin,
            type: { kind: 'number' },
            constant: { kind: 'number', value: wire },
          });
          args.push({ kind: 'value' as const, value: pin });
        }
        field.push({
          kind: 'callValue',
          name,
          pure: name === 'boardAnalogStatus',
          result,
          type: op.field === 'status' ? op.type : { kind: 'number' },
          args,
        });
        if (op.field === 'voltage')
          field.push({ kind: 'optional', result: op.result, type: op.type, value: result });
        return field;
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
      if (op.kind === 'constant' && op.constant.kind === 'enum' && op.constant.name === 'Logic')
        return {
          ...op,
          type: { kind: 'number' },
          constant: {
            kind: 'number',
            value: op.constant.member === 'high' ? 1 : op.constant.member === 'low' ? 0 : -1,
          },
        };
      const mapped = mapChildRegions(op, region, lowerType);
      if ('type' in mapped) {
        const type = lowerType(mapped.type);
        if (type !== mapped.type) return { ...mapped, type };
      }
      return mapped;
    }
    return region(input);
  }
  const result: BlockIR = {
    ...block,
    instructions: block.instructions.map((instruction) => {
      const touched = new Set<number>();
      const transformed = transform(instruction.body, touched);
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
      if (touched.has(BOARD_WIRES.I2C_SCL) || touched.has(BOARD_WIRES.I2C_SDA)) {
        suffix.push({ kind: 'call', name: 'boardI2c', pure: false, args: [] });
      }
      if (
        touched.has(BOARD_WIRES.LED_LE) ||
        BOARD_WIRES.LED_DATA.some((wire) => touched.has(wire)) ||
        touched.has(18) ||
        touched.has(19)
      ) {
        const oldLe = next++;
        prefix.push({
          kind: 'read',
          resource: 'state',
          name: `fusedWire${BOARD_WIRES.LED_LE}`,
          result: oldLe,
          type: { kind: 'number' },
        });
        suffix.push({
          kind: 'call',
          name: 'boardLatch',
          pure: false,
          args: [{ kind: 'value', value: oldLe }],
        });
      }
      const expanded = inlineCalls(
        {
          operations: [...prefix, ...transformed.operations.slice(0, -1), ...suffix, last],
        },
        model,
      );
      let requestsFrame = false;
      let expandedNext = next;
      walkOperations(expanded, (op) => {
        if (op.kind === 'write' && op.name === 'fusedFramePending') requestsFrame = true;
        if ('result' in op) expandedNext = Math.max(expandedNext, op.result + 1);
      });
      if (!requestsFrame) return { ...instruction, body: expanded };
      const tail = expanded.operations.at(-1);
      if (tail?.kind !== 'elapse') throw new Error('Fused MCU must end in elapse');
      next = expandedNext;
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
