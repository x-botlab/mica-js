/**
 * Value representation analysis for MIR (J5, using the J4 D/U lattice).
 *
 * - `bool` values stay JavaScript booleans and integers stay numbers in their
 *   scalar range (`'bool'` / `'int'`).
 * - Floating values are either `D` (a JS number holding canonical bits) or
 *   `U` (`number | FloatBits`; objects preserve exact non-canonical bits).
 *
 * Sources that always canonicalize to `D` are float constants, arithmetic,
 * conversions and `event.now`. Function parameters, calls, loads, executor
 * results and bitcasts start at `U`. Block parameters and `select` join their
 * inputs (`D ⊔ D = D`, everything else `U`) and are solved to a fixed point.
 */
import { isFloatType, isIntegerType } from '../runtime';
import { blockEdges } from './cfg';
import { Op } from './mir';
import type { MFunction, MInst, Rep, ValueId } from './mir';
import type { FunctionSummary } from './effects';

/** Join the representation lattice; `undefined` is the bottom element. */
export function joinReps(left: Rep | undefined, right: Rep | undefined): Rep | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left === right ? left : 'U';
}

function isFloatValue(fn: MFunction, id: ValueId): boolean {
  return isFloatType(fn.values[id]!.type);
}

function resultIndex(inst: MInst, id: ValueId): number {
  return inst.results.indexOf(id);
}

/** Representation fixed by the instruction itself, or `undefined` for a join point. */
function sourceRep(
  inst: MInst,
  valueId: ValueId,
  summaries: ReadonlyMap<number, FunctionSummary> | undefined,
): Rep | undefined {
  switch (inst.op) {
    case Op.Const:
      return inst.constRep ?? 'D';
    case Op.FloatAdd:
    case Op.FloatSub:
    case Op.FloatMul:
    case Op.FloatDiv:
    case Op.FloatFma:
    case Op.ConvertIntToFloat:
    case Op.ConvertFloat:
    case Op.EventNow:
      return 'D';
    case Op.Select:
      return undefined;
    case Op.Call: {
      const summary = summaries?.get(inst.refs[0] ?? -1);
      return summary?.resultReps[resultIndex(inst, valueId)] ?? 'U';
    }
    default:
      // Loads, executor results, bitcasts from integers and any unknown source.
      return 'U';
  }
}

/**
 * Analyze every value of one function and write the result back into
 * `MValue.rep`. `summaries` supplies `call` result representations; without it
 * call results are conservatively `U`.
 */
export function analyzeRepresentation(
  fn: MFunction,
  summaries?: ReadonlyMap<number, FunctionSummary>,
): Map<ValueId, Rep> {
  const reps: (Rep | undefined)[] = new Array<Rep | undefined>(fn.values.length);
  for (const value of fn.values) {
    if (value.type === 'bool') {
      reps[value.id] = 'bool';
    } else if (isIntegerType(value.type)) {
      reps[value.id] = 'int';
    } else if ('insts' in value.def) {
      // Block parameter: the entry block receives the function arguments.
      reps[value.id] = value.def.id === 0 ? 'U' : undefined;
    } else {
      reps[value.id] = sourceRep(value.def, value.id, summaries);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of fn.blocks) {
      if (block.id !== 0) {
        const incoming: (Rep | undefined)[] = block.params.map(() => undefined);
        for (const pred of fn.blocks) {
          for (const edge of blockEdges(pred.term)) {
            if (edge.target !== block.id) continue;
            edge.args.forEach((arg, index) => {
              if (index >= incoming.length) return;
              incoming[index] = joinReps(incoming[index], reps[arg]);
            });
          }
        }
        block.params.forEach((param, index) => {
          if (!isFloatValue(fn, param)) return;
          const next = joinReps(reps[param], incoming[index]);
          if (next !== undefined && next !== reps[param]) {
            reps[param] = next;
            changed = true;
          }
        });
      }
      for (const inst of block.insts) {
        if (inst.op !== Op.Select) continue;
        const value = inst.results[0];
        if (value === undefined || !isFloatValue(fn, value)) continue;
        const left = inst.args[1];
        const right = inst.args[2];
        const next = joinReps(
          left === undefined ? undefined : reps[left],
          right === undefined ? undefined : reps[right],
        );
        if (next !== undefined && next !== reps[value]) {
          reps[value] = next;
          changed = true;
        }
      }
    }
  }

  const result = new Map<ValueId, Rep>();
  for (const value of fn.values) {
    const rep = reps[value.id] ?? 'U';
    value.rep = rep;
    result.set(value.id, rep);
  }
  return result;
}
