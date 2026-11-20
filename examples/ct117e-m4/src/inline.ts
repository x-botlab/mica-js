import type {
  ConstantIR,
  DeclarationIR,
  DeviceIR,
  OperationIR,
  RegionIR,
} from '@mica-js/sdk/model';
import { mapChildRegions, rewriteRegion, walkOperations } from './regions';

export const LCD_WIRE_COUNT = 20;
export const lcdLevelFunction = (wire: number): string => `fusedLevel${wire}`;

const HOT = new Set([
  'fusedWr',
  'fusedReadWindow',
  ...Array.from({ length: LCD_WIRE_COUNT }, (_, wire) => lcdLevelFunction(wire)),
  'writeCommand',
  'writeData',
  'dataBus',
  'readValue',
  'advanceAddress',
  'driveData',
  'releaseData',
  'boardLatch',
  'boardUpdateLeds',
  'u1_dataByte',
  'u1_bit',
]);

const OPERANDS = new Set([
  'value',
  'condition',
  'left',
  'right',
  'offset',
  'length',
  'initial',
  'duration',
]);

const indexes = new WeakMap<
  DeviceIR,
  {
    functions: Map<string, Extract<DeclarationIR, { kind: 'function' }>>;
    constants: Map<string, ConstantIR>;
  }
>();

function hotIndex(model: DeviceIR) {
  let index = indexes.get(model);
  if (index) return index;
  index = { functions: new Map(), constants: new Map() };
  for (const entry of model.declarations) {
    if (entry.kind === 'function' && HOT.has(entry.name)) index.functions.set(entry.name, entry);
    if (entry.kind === 'const') {
      const first = entry.value.body.operations[0];
      if (first?.kind === 'constant') index.constants.set(entry.name, first.constant);
    }
  }
  indexes.set(model, index);
  return index;
}

/** 把无环的内部总线热函数展开进生产 JIT IR；model 是同一份不变的生成声明。 */
export function inlineCalls(region: RegionIR, model: DeviceIR): RegionIR {
  const { functions, constants } = hotIndex(model);
  let result = 0,
    local = 0;
  let calls = false;
  walkOperations(region, (op) => {
    if ('result' in op) result = Math.max(result, op.result + 1);
    if ('local' in op) local = Math.max(local, op.local + 1);
    if ((op.kind === 'call' || op.kind === 'callValue') && HOT.has(op.name)) calls = true;
  });
  if (!calls) return region;
  const active = new Set<string>();
  const expand = (input: RegionIR): RegionIR => rewriteRegion(input, expandOp);
  function expandOp(op: OperationIR): OperationIR | OperationIR[] {
    if ((op.kind === 'call' || op.kind === 'callValue') && HOT.has(op.name)) {
      if (active.has(op.name)) throw new Error('Recursive fused hot function');
      const fn = functions.get(op.name);
      if (!fn || op.args.some((arg) => arg.kind !== 'value'))
        throw new Error('Invalid fused hot call');
      const ids = new Map<number, number>(),
        slots = new Map<number, number>();
      const id = (old: number): number => {
        let next = ids.get(old);
        if (next === undefined) {
          next = result++;
          ids.set(old, next);
        }
        return next;
      };
      const slot = (old: number): number => {
        let next = slots.get(old);
        if (next === undefined) {
          next = local++;
          slots.set(old, next);
        }
        return next;
      };
      const rename = (value: unknown, key = ''): unknown => {
        if (value === null || typeof value !== 'object') {
          if (typeof value !== 'number') return value;
          if (key === 'result' || OPERANDS.has(key)) return id(value);
          if (key === 'local') return slot(value);
          return value;
        }
        if (Array.isArray(value)) {
          const entries = [];
          for (const entry of value) {
            const renamed = typeof entry === 'number' && key === 'args' ? id(entry) : rename(entry);
            if (renamed !== undefined) entries.push(renamed);
          }
          return entries;
        }
        const node = value as OperationIR;
        if (node.kind === 'parameter') {
          const argument = op.args[node.index];
          if (argument?.kind !== 'value') throw new Error('Invalid fused argument');
          ids.set(node.result, argument.value);
          return undefined;
        }
        if (node.kind === 'read' && node.resource === 'const') {
          const constant = constants.get(node.name);
          if (!constant) throw new Error(`Nonliteral fused hot constant: ${node.name}`);
          return { kind: 'constant', result: id(node.result), type: node.type, constant };
        }
        const renamed: Record<string, unknown> = {};
        for (const field of Object.keys(value)) {
          const entry = (value as Record<string, unknown>)[field];
          renamed[field] =
            field === 'source' ||
            field === 'type' ||
            field === 'constant' ||
            field === 'memory' ||
            field === 'pin'
              ? entry
              : rename(entry, field);
        }
        return renamed;
      };
      let cloned = rename(fn.body) as RegionIR;
      const tail = cloned.operations.at(-1);
      const prefix: OperationIR[] = [];
      const suffix: OperationIR[] = [];
      if (op.kind === 'callValue') {
        if (tail?.kind !== 'returnValue')
          throw new Error('Fused hot value must return at its tail');
        const zero = result++,
          target = local++;
        prefix.push(
          {
            kind: 'constant',
            result: zero,
            type: op.type,
            constant: { kind: 'number', value: 0 },
          },
          { kind: 'local', local: target, type: op.type, initial: zero },
        );
        cloned = {
          ...cloned,
          operations: [
            ...cloned.operations.slice(0, -1),
            { kind: 'localWrite', local: target, value: tail.value },
          ],
        };
        suffix.push({ kind: 'localRead', result: op.result, local: target, type: op.type });
      } else if (tail?.kind === 'return')
        cloned = { ...cloned, operations: cloned.operations.slice(0, -1) };
      active.add(op.name);
      const expanded = expand(cloned);
      active.delete(op.name);
      return [...prefix, ...expanded.operations, ...suffix];
    }
    return mapChildRegions(op, expand);
  }
  return expand(region);
}
