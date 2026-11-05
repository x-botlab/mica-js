import type { OperationIR, RegionIR } from '@mica-js/device-model';

export function isPollingInstruction(body: RegionIR, pc: number, pcName: string): boolean {
  const definitions = new Map<number, OperationIR>();
  const redirects: number[] = [];
  const visit = (region: RegionIR): boolean => {
    for (const operation of region.operations) {
      if ('result' in operation) definitions.set(operation.result, operation);
      switch (operation.kind) {
        case 'constant':
        case 'unary':
        case 'binary':
        case 'numeric':
        case 'field':
        case 'length':
        case 'index':
        case 'isNone':
        case 'nonNull':
        case 'optional':
        case 'local':
        case 'localRead':
        case 'localWrite':
        case 'memoryLength':
        case 'load8':
        case 'load16le':
        case 'load16be':
        case 'load32le':
        case 'load32be':
        case 'readSample':
        case 'yield':
          break;
        case 'read':
          if (operation.resource === 'derived' || operation.name === pcName) return false;
          break;
        case 'if':
          if (!visit(operation.yes) || (operation.no && !visit(operation.no))) return false;
          break;
        case 'select':
          if (!visit(operation.yes.body) || !visit(operation.no.body)) return false;
          break;
        case 'and':
        case 'or':
          if (!visit(operation.right.body)) return false;
          break;
        case 'match':
          if (
            operation.arms.some((arm) => !visit(arm.body)) ||
            (operation.otherwise && !visit(operation.otherwise))
          )
            return false;
          break;
        case 'redirect':
          redirects.push(operation.target);
          break;
        default:
          return false;
      }
    }
    return true;
  };
  if (!visit(body)) return false;
  return redirects.some((target) => {
    const definition = definitions.get(target);
    return (
      definition?.kind !== 'constant' ||
      (definition.constant.kind === 'number' && definition.constant.value === pc)
    );
  });
}
