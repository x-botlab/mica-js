import type { BlockIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { driveCode } from '../shared/drive-code.mjs';
import { MCU_PIN } from './nets';

/**
 * Lower MCU pin accesses into the fused board's internal net storage.
 *
 * The 8051 translator is reused unchanged. Its blocks still speak in `readSample` /
 * `writeIntent` / `resistor`; this pass replaces those with:
 * - `load8(fusedPins, drive)` for digital levels and voltages,
 * - `store8(fusedMcuDrives, pin, level)` for pin intents,
 * - one `fusedSeq` increment per block that changed a pin.
 *
 * The original translator's block cache stays authoritative; fused blocks are cached
 * separately by object identity so the standalone MCU device is not polluted.
 */
const fusedBlocks = new WeakMap<BlockIR, BlockIR>();

function mcuPin(name: string): { readonly net: number; readonly drive: number } {
  const pin = MCU_PIN[name as keyof typeof MCU_PIN];
  if (pin === undefined) throw new Error(`Fused MCU has no pin ${name}`);
  return pin;
}

function isLogicType(value: Record<string, unknown>): boolean {
  return value.kind === 'enum' && value.name === 'Logic' && !Object.hasOwn(value, 'member');
}

export function fuseBlock(block: BlockIR): BlockIR {
  const cached = fusedBlocks.get(block);
  if (cached !== undefined) return cached;

  let next = 0;
  let nextLocal = 0;
  let needsFusion = false;
  const constants = new Map<number, number>();
  const scan = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const op = value as OperationIR;
    if (op.kind === 'readSample' || op.kind === 'writeIntent' || op.kind === 'resistor')
      needsFusion = true;
    if (op.kind === 'constant' && op.constant.kind === 'number')
      constants.set(op.result, op.constant.value);
    if ('result' in value && typeof value.result === 'number')
      next = Math.max(next, value.result + 1);
    if ('local' in value && typeof value.local === 'number')
      nextLocal = Math.max(nextLocal, value.local + 1);
    for (const entry of Object.values(value)) scan(entry);
  };
  scan(block);
  if (!needsFusion) {
    fusedBlocks.set(block, block);
    return block;
  }

  const id = (): number => next++;
  const constant = (result: number, value: number): OperationIR => ({
    kind: 'constant',
    result,
    type: { kind: 'number' },
    constant: { kind: 'number', value },
  });
  const loadPin = (result: number, net: number): OperationIR[] => {
    const offset = id();
    return [
      constant(offset, net),
      {
        kind: 'load8',
        result,
        type: { kind: 'number' },
        memory: { kind: 'memory', name: 'fusedPins' },
        offset,
      },
    ];
  };

  let wroteDrive = false;
  let dirtyLocal: number | undefined;
  let dirtyPrefix: OperationIR[] = [];
  const voltageResults = new Set<number>();
  const boolConstant = (result: number, value: boolean): OperationIR => ({
    kind: 'constant',
    result,
    type: { kind: 'bool' },
    constant: { kind: 'bool', value },
  });
  const transform = (value: unknown, samples: Map<number, string>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.flatMap((entry) => {
        const result = transform(entry, samples);
        return result === undefined ? [] : Array.isArray(result) ? result : [result];
      });
    const op = value as OperationIR;
    if (op.kind === 'readSample') {
      if (op.pin.kind !== 'pin') throw new Error('Fused MCU requires a static pin sample');
      samples.set(op.result, op.pin.name);
      return undefined;
    }
    if (op.kind === 'field' && samples.has(op.value)) {
      const pin = samples.get(op.value)!;
      if (op.field === 'level') {
        if (pin === 'VCC') return constant(op.result, 1);
        if (pin === 'GND') return constant(op.result, 0);
        return loadPin(op.result, mcuPin(pin).drive);
      }
      if (op.field === 'voltage') {
        voltageResults.add(op.result);
        if (pin === 'VCC') return constant(op.result, 5);
        if (pin === 'GND') return constant(op.result, 0);
        const loaded = id();
        const unknown = id();
        const five = id();
        const zero = id();
        const scaled = id();
        const isUnknown = id();
        return [
          ...loadPin(loaded, mcuPin(pin).drive),
          constant(unknown, 2),
          constant(five, 5),
          constant(zero, 0),
          {
            kind: 'binary',
            operator: 'multiply',
            left: loaded,
            right: five,
            result: scaled,
            type: { kind: 'number' },
          },
          {
            kind: 'binary',
            operator: 'equal',
            left: loaded,
            right: unknown,
            result: isUnknown,
            type: { kind: 'bool' },
          },
          {
            kind: 'select',
            condition: isUnknown,
            type: { kind: 'number' },
            result: op.result,
            yes: {
              type: { kind: 'number' },
              body: { operations: [{ kind: 'yield', value: zero }] },
            },
            no: {
              type: { kind: 'number' },
              body: { operations: [{ kind: 'yield', value: scaled }] },
            },
          },
        ];
      }
      throw new Error(`Fused MCU does not support sample.${op.field}`);
    }
    if (op.kind === 'resistor') {
      if (op.to.kind !== 'pin') throw new Error('Fused MCU resistor must target a rail');
      if (op.to.name !== 'VCC' && op.to.name !== 'GND')
        throw new Error(`Fused MCU resistor target ${op.to.name} is not a rail`);
      const resistance = constants.get(op.resistance);
      if (resistance === undefined)
        throw new Error('Fused MCU resistor resistance must be a constant');
      return constant(op.result, driveCode(resistance, op.to.name, 'Fused MCU resistor'));
    }
    if (op.kind === 'combineIntents') {
      if (op.values.length > 0) throw new Error('Fused MCU does not support parallel intents');
      return constant(op.result, 4);
    }
    if (op.kind === 'writeIntent') {
      if (op.pin.kind !== 'pin') throw new Error('Fused MCU write requires a static pin');
      wroteDrive = true;
      if (dirtyLocal === undefined) {
        dirtyLocal = nextLocal++;
        const initial = id();
        dirtyPrefix = [
          boolConstant(initial, false),
          { kind: 'local', local: dirtyLocal, type: { kind: 'bool' }, initial },
        ];
      }
      const offset = id();
      const old = id();
      const condition = id();
      const truth = id();
      return [
        constant(offset, mcuPin(op.pin.name).drive),
        {
          kind: 'load8',
          result: old,
          type: { kind: 'number' },
          memory: { kind: 'memory', name: 'fusedMcuDrives' },
          offset,
        },
        {
          kind: 'binary',
          operator: 'notEqual',
          left: old,
          right: op.value,
          result: condition,
          type: { kind: 'bool' },
        },
        {
          kind: 'if',
          condition,
          yes: {
            operations: [
              {
                kind: 'store8',
                memory: { kind: 'memory', name: 'fusedMcuDrives' },
                offset,
                value: op.value,
              },
              boolConstant(truth, true),
              {
                kind: 'localWrite',
                local: dirtyLocal,
                value: truth,
              },
            ],
          },
        },
      ];
    }
    if (op.kind === 'isNone' && voltageResults.has(op.value)) return boolConstant(op.result, false);
    if (op.kind === 'nonNull' && voltageResults.has(op.value)) {
      const zero = id();
      return [
        constant(zero, 0),
        {
          kind: 'binary',
          operator: 'add',
          left: op.value,
          right: zero,
          result: op.result,
          type: { kind: 'number' },
        },
      ];
    }
    if (op.kind === 'constant' && op.constant.kind === 'enum' && op.constant.name === 'Logic') {
      return {
        ...op,
        type: { kind: 'number' },
        constant: {
          kind: 'number',
          value: op.constant.member === 'high' ? 1 : op.constant.member === 'low' ? 0 : 2,
        },
      };
    }
    // Type descriptors and intent values.
    if (
      'kind' in value &&
      (value.kind === 'intent' || isLogicType(value as Record<string, unknown>))
    )
      return { kind: 'number' };
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        ['source', 'memory', 'pin'].includes(key) ? entry : transform(entry, samples),
      ]),
    );
  };

  const instruction = (entry: BlockIR['instructions'][number]): BlockIR['instructions'][number] => {
    wroteDrive = false;
    dirtyLocal = undefined;
    dirtyPrefix = [];
    const body = transform(entry.body, new Map()) as RegionIR;
    if (!wroteDrive) return { ...entry, body };
    // The 8051 translator puts `elapse` before its service/prologue tail, so the pin
    // write barrier must be inserted before the first top-level elapse, not at the end.
    const at = body.operations.findIndex((operation) => operation.kind === 'elapse');
    if (at < 0) throw new Error(`Fused MCU instruction has no elapse (pc ${entry.pc})`);
    if (dirtyLocal === undefined) return { ...entry, body };
    const dirty = id();
    const read = id();
    const one = id();
    const sum = id();
    return {
      ...entry,
      body: {
        ...body,
        operations: [
          ...dirtyPrefix,
          ...body.operations.slice(0, at),
          { kind: 'localRead', local: dirtyLocal, result: dirty, type: { kind: 'bool' } },
          {
            kind: 'if',
            condition: dirty,
            yes: {
              operations: [
                {
                  kind: 'read',
                  resource: 'state',
                  name: 'fusedSeq',
                  result: read,
                  type: { kind: 'number' },
                },
                constant(one, 1),
                {
                  kind: 'binary',
                  operator: 'add',
                  left: read,
                  right: one,
                  result: sum,
                  type: { kind: 'number' },
                },
                { kind: 'write', resource: 'state', name: 'fusedSeq', value: sum },
              ],
            },
          },
          ...body.operations.slice(at),
        ],
      },
    };
  };

  const fused: BlockIR = {
    ...block,
    instructions: block.instructions.map(instruction),
  };
  fusedBlocks.set(block, fused);
  return fused;
}
