import type { DeviceIR, OperationIR, RegionIR } from '@mica-js/sdk/model';

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

/** 把无环的内部总线热函数展开进生产 JIT IR；展开结果只引用 model 中已有的声明。 */
export function inlineCalls(region: RegionIR, model: DeviceIR): RegionIR {
  const functions = new Map(
    model.declarations.flatMap((d) => (d.kind === 'function' ? [[d.name, d] as const] : [])),
  );
  const constants = new Map(
    model.declarations.flatMap((d) => {
      if (d.kind !== 'const') return [];
      const first = d.value.body.operations[0];
      return first?.kind === 'constant' ? [[d.name, first.constant] as const] : [];
    }),
  );
  let result = 0,
    local = 0;
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('result' in value && typeof value.result === 'number')
      result = Math.max(result, value.result + 1);
    if ('local' in value && typeof value.local === 'number')
      local = Math.max(local, value.local + 1);
    Object.values(value).forEach(scan);
  };
  scan(region);
  const expand = (input: RegionIR, active = new Set<string>()): RegionIR => ({
    ...input,
    operations: input.operations.flatMap((op): OperationIR[] => {
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
          if (Array.isArray(value))
            return value.flatMap((entry) => {
              const renamed =
                typeof entry === 'number' && key === 'args' ? id(entry) : rename(entry);
              return renamed === undefined ? [] : [renamed];
            });
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
          return Object.fromEntries(
            Object.entries(value).map(([field, entry]) => [
              field,
              ['source', 'type', 'constant', 'memory', 'pin'].includes(field)
                ? entry
                : rename(entry, field),
            ]),
          );
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
        const nested = new Set(active);
        nested.add(op.name);
        return [...prefix, ...expand(cloned, nested).operations, ...suffix];
      }
      const visit = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return value;
        if ('operations' in value) return expand(value as RegionIR, active);
        if (Array.isArray(value)) return value.map(visit);
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
      };
      return [visit(op) as OperationIR];
    }),
  });
  return expand(region);
}
