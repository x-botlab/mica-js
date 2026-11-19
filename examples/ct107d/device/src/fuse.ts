import type { BlockIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { driveCode } from '../shared/drive-code.mjs';
import {
  DIRTY_GROUP_MEMORY,
  PIN_DIRTY_MEMORY,
  dirtyGroup,
  driveMemoryName,
  pinMemoryName,
} from '../shared/dirty-protocol.mjs';
import { MCU_DIRTY_TRIGGERS, MCU_IMPACT, MCU_PIN } from './nets';

/**
 * Lower MCU pin accesses into the fused board's internal net storage.
 *
 * The 8051 translator is reused unchanged. Its blocks still speak in `readSample` /
 * `writeIntent` / `resistor`; this pass replaces those with:
 * - `load8(fusedPinN, 0)` for digital levels and voltages,
 * - `store8(fusedDriveN, 0, level)` for pin intents,
 * - one `fusedSeq` increment per instruction that changed a pin.
 *
 * Every pin owns its mirror and drive resource, so changing one pin cannot
 * invalidate derived observers of unrelated pins.
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
  const loadPin = (result: number, drive: number): OperationIR[] => {
    const offset = id();
    return [
      constant(offset, 0),
      {
        kind: 'load8',
        result,
        type: { kind: 'number' },
        memory: { kind: 'memory', name: pinMemoryName(drive) },
        offset,
      },
    ];
  };

  let wroteDrive = false;
  let dirtyLocal: number | undefined;
  let dirtyPrefix: OperationIR[] = [];
  interface DirtyMarker {
    readonly local: number;
    readonly emit: () => OperationIR[];
  }
  let markers = new Map<string, DirtyMarker>();
  let markerTruth: number | undefined;
  let markerOne: number | undefined;
  const truthValue = (): number => {
    if (markerTruth === undefined) {
      markerTruth = id();
      dirtyPrefix.push(boolConstant(markerTruth, true));
    }
    return markerTruth;
  };
  const dirtyFlagValue = (): number => {
    if (markerOne === undefined) {
      markerOne = id();
      dirtyPrefix.push(constant(markerOne, 1));
    }
    return markerOne;
  };
  const markerFor = (key: string, emit: () => OperationIR[]): DirtyMarker => {
    const cached = markers.get(key);
    if (cached !== undefined) return cached;
    const local = nextLocal++;
    const initial = id();
    dirtyPrefix.push(boolConstant(initial, false), {
      kind: 'local',
      local,
      type: { kind: 'bool' },
      initial,
    });
    const marker = { local, emit };
    markers.set(key, marker);
    return marker;
  };
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
      // A drive change can move its own net and every alias that consumes it. The
      // generator resolves those edges statically; only the mirrored MCU pins are
      // marked, so the next fusedSeq refresh does not rescan all 40 nets.
      const drive = mcuPin(op.pin.name).drive;
      const impact = MCU_IMPACT[op.pin.name];
      if (impact === undefined || impact.length === 0)
        throw new Error(`Fused MCU has no pin impact for ${op.pin.name}`);
      const offset = id();
      const old = id();
      const condition = id();
      // One instruction can write several pins. Merge their markers through
      // per-instruction locals so the commit stores each dirty bit, group summary and
      // observable flag once even when the pins overlap.
      const marks: OperationIR[] = [];
      const mark = (key: string, emit: () => OperationIR[]): void => {
        const marker = markerFor(key, emit);
        marks.push({ kind: 'localWrite', local: marker.local, value: truthValue() });
      };
      for (const target of impact)
        mark(`drive:${target}`, () => {
          const markOffset = id();
          return [
            constant(markOffset, target),
            {
              kind: 'store8',
              memory: { kind: 'memory', name: PIN_DIRTY_MEMORY },
              offset: markOffset,
              value: dirtyFlagValue(),
            },
          ];
        });
      // The generated model gates its refresh on the same summary bytes, so a JIT
      // drive change must always raise the group of every pin it marks.
      for (const group of [...new Set(impact.map(dirtyGroup))].sort((left, right) => left - right))
        mark(`group:${group}`, () => {
          const markOffset = id();
          return [
            constant(markOffset, group),
            {
              kind: 'store8',
              memory: { kind: 'memory', name: DIRTY_GROUP_MEMORY },
              offset: markOffset,
              value: dirtyFlagValue(),
            },
          ];
        });
      // A row/column pin can move the button closure without changing a mirror that
      // the generated diff would notice first. The generator resolves the observable
      // edges statically, so the same instruction raises exactly those flags once.
      for (const state of MCU_DIRTY_TRIGGERS[op.pin.name] ?? [])
        mark(`state:${state}`, () => [
          { kind: 'write', resource: 'state', name: state, value: truthValue() },
        ]);
      return [
        constant(offset, 0),
        {
          kind: 'load8',
          result: old,
          type: { kind: 'number' },
          memory: { kind: 'memory', name: driveMemoryName(drive) },
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
                memory: { kind: 'memory', name: driveMemoryName(drive) },
                offset,
                value: op.value,
              },
              ...marks,
              {
                kind: 'localWrite',
                local: dirtyLocal,
                value: truthValue(),
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
    markers = new Map();
    markerTruth = undefined;
    markerOne = undefined;
    const body = transform(entry.body, new Map()) as RegionIR;
    if (!wroteDrive || dirtyLocal === undefined) return { ...entry, body };

    /**
     * A drive change only becomes visible to the rest of the board when `fusedSeq`
     * changes. The 8051 translator can end an instruction through `elapse`, a normal
     * `redirect`, or a redirect nested inside an IRQ-take branch; all of them are
     * reachable before the top-level service `elapse`. Insert a changed-only commit
     * immediately before every block-exiting operation in every reachable region.
     * `dirty` is cleared after the commit, so one path cannot bump twice for the same
     * drive change, while a later write in the same instruction can still commit again.
     */
    const dirtyLocalId = dirtyLocal;
    const commit = (): OperationIR[] => {
      const dirty = id();
      const read = id();
      const one = id();
      const sum = id();
      const clean = id();
      const markerOps: OperationIR[] = [];

      // Publish the merged dirty markers before the sequence bump: the refresh
      // process reads them after `fusedSeq` changes. Clearing each local keeps a
      // later write in the same instruction visible, while one path marks once.
      for (const marker of markers.values()) {
        const pending = id();
        const marked = id();
        markerOps.push(
          { kind: 'localRead', local: marker.local, result: pending, type: { kind: 'bool' } },
          {
            kind: 'if',
            condition: pending,
            yes: {
              operations: [
                ...marker.emit(),
                boolConstant(marked, false),
                { kind: 'localWrite', local: marker.local, value: marked },
              ],
            },
          },
        );
      }

      return [
        ...markerOps,
        { kind: 'localRead', local: dirtyLocalId, result: dirty, type: { kind: 'bool' } },
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
              boolConstant(clean, false),
              { kind: 'localWrite', local: dirtyLocalId, value: clean },
            ],
          },
        },
      ];
    };
    const exits = new Set<OperationIR['kind']>([
      'elapse',
      'redirect',
      'stop',
      'wait',
      'waitUntil',
      'return',
      'returnValue',
    ]);
    const mapRegion = (region: RegionIR): RegionIR => ({
      ...region,
      operations: region.operations.flatMap((operation) => [
        ...(exits.has(operation.kind) ? commit() : []),
        mapOperation(operation),
      ]),
    });
    const mapOperation = (operation: OperationIR): OperationIR => {
      switch (operation.kind) {
        case 'if':
          return {
            ...operation,
            yes: mapRegion(operation.yes),
            ...(operation.no === undefined ? {} : { no: mapRegion(operation.no) }),
          };
        case 'match':
          return {
            ...operation,
            arms: operation.arms.map((arm) => ({ ...arm, body: mapRegion(arm.body) })),
            ...(operation.otherwise === undefined
              ? {}
              : { otherwise: mapRegion(operation.otherwise) }),
          };
        case 'while':
          return { ...operation, body: mapRegion(operation.body) };
        case 'loop':
          return { ...operation, body: mapRegion(operation.body) };
        default:
          return operation;
      }
    };
    const mapped = mapRegion(body);

    return {
      ...entry,
      body: { ...mapped, operations: [...dirtyPrefix, ...mapped.operations] },
    };
  };

  const fused: BlockIR = {
    ...block,
    instructions: block.instructions.map(instruction),
  };
  fusedBlocks.set(block, fused);
  return fused;
}
