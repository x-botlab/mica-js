import type { OperationIR, RegionIR, ValueRegionIR, ValueTypeIR } from '@mica-js/sdk/model';

/** Visit executable children only; immutable operand and metadata objects aren't regions. */
export function mapChildRegions(
  op: OperationIR,
  region: (body: RegionIR) => RegionIR,
  type?: (value: ValueTypeIR) => ValueTypeIR,
): OperationIR {
  const valueRegion = (input: ValueRegionIR): ValueRegionIR => {
    const body = region(input.body);
    const mapped = type ? type(input.type) : input.type;
    return body === input.body && mapped === input.type ? input : { ...input, body, type: mapped };
  };
  switch (op.kind) {
    case 'if': {
      const yes = region(op.yes);
      const no = op.no && region(op.no);
      return yes === op.yes && no === op.no ? op : { ...op, yes, ...(no && { no }) };
    }
    case 'match': {
      let arms: (typeof op.arms)[number][] | undefined;
      for (const [index, arm] of op.arms.entries()) {
        const body = region(arm.body);
        if (body !== arm.body) (arms ??= op.arms.slice())[index] = { ...arm, body };
      }
      const otherwise = op.otherwise && region(op.otherwise);
      return arms || otherwise !== op.otherwise
        ? { ...op, arms: arms ?? op.arms, ...(otherwise && { otherwise }) }
        : op;
    }
    case 'while': {
      const test = valueRegion(op.test);
      const body = region(op.body);
      return body === op.body && test === op.test ? op : { ...op, test, body };
    }
    case 'loop': {
      const body = region(op.body);
      return body === op.body ? op : { ...op, body };
    }
    case 'and':
    case 'or': {
      const right = valueRegion(op.right);
      return right === op.right ? op : { ...op, right };
    }
    case 'select': {
      const yes = valueRegion(op.yes);
      const no = valueRegion(op.no);
      return yes === op.yes && no === op.no ? op : { ...op, yes, no };
    }
    case 'assert': {
      const message = op.message && valueRegion(op.message);
      return message === undefined || message === op.message ? op : { ...op, message };
    }
    default:
      return op;
  }
}

export function walkOperations(body: RegionIR, visit: (op: OperationIR) => void): void {
  function walk(region: RegionIR): RegionIR {
    for (const op of region.operations) {
      visit(op);
      mapChildRegions(op, walk);
    }
    return region;
  }
  walk(body);
}

export function rewriteRegion(
  body: RegionIR,
  rewrite: (op: OperationIR) => OperationIR | OperationIR[] | undefined,
): RegionIR {
  const original = body.operations;
  let operations: OperationIR[] | undefined;
  for (let index = 0; index < original.length; index++) {
    const op = original[index]!;
    const mapped = rewrite(op);
    if (!operations && mapped === op) continue;
    operations ??= original.slice(0, index);
    if (Array.isArray(mapped)) operations.push(...mapped);
    else if (mapped) operations.push(mapped);
  }
  return operations ? { ...body, operations } : body;
}
