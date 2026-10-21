// Compile-only public scalar evaluation contracts; run by the package typecheck.
import {
  evaluateScalarInstruction,
  IRScalarEvaluationError,
  type InstructionNode,
  type IRScalarEvaluationErrorCode,
} from './index';

declare const instruction: InstructionNode;
declare const operands: readonly (boolean | number)[];
const value: boolean | number = evaluateScalarInstruction(instruction, operands);
const error = new IRScalarEvaluationError('division-by-zero', 'Integer divisor is zero');
const code: IRScalarEvaluationErrorCode = error.code;
const base: Error = error;
void [value, code, base];

// @ts-expect-error Evaluation consumes an existing node, not a second operation API.
evaluateScalarInstruction('int.add', [1, 2]);
// @ts-expect-error BigInts are private implementation details, not IR scalar values.
evaluateScalarInstruction(instruction, [1n]);
// @ts-expect-error No string coercion is permitted.
evaluateScalarInstruction(instruction, ['1']);
// @ts-expect-error An SSA handle is not its evaluated scalar value.
evaluateScalarInstruction(instruction, instruction.results);
// @ts-expect-error The union result must be narrowed before use as a number.
const numberOnly: number = evaluateScalarInstruction(instruction, operands);
void numberOnly;
// @ts-expect-error Error codes are a closed contract.
new IRScalarEvaluationError('type-mismatch', 'Static validation has a separate diagnostic type');
// @ts-expect-error Error codes cannot be reassigned.
error.code = 'invalid-operand';
