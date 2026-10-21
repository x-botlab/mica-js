import {
  evaluateFloatInstruction,
  IRFloatEvaluationError,
  type FloatBits,
  type InstructionNode,
  type RuntimeScalar,
} from './index';

declare const instruction: InstructionNode;
const payload: FloatBits = { type: 'f64', bits: '0x7ff0000000001234' };
const operands: readonly RuntimeScalar[] = [payload, 1, true];
const evaluate: (
  instruction: InstructionNode,
  operands: readonly RuntimeScalar[],
) => RuntimeScalar = evaluateFloatInstruction;
evaluate(instruction, operands);
new IRFloatEvaluationError('integer-overflow', 'Out of range');

// @ts-expect-error FloatBits cannot carry an integer type.
const integerBits: FloatBits = { type: 'u32', bits: '0x00000000' };
void integerBits;
// @ts-expect-error Raw bits must use hexadecimal syntax.
const decimalBits: FloatBits = { type: 'f32', bits: '1234' };
void decimalBits;
// @ts-expect-error RuntimeScalar does not introduce bigint/u64 arithmetic.
evaluate(instruction, [1n]);
// @ts-expect-error Error codes are a closed public union.
new IRFloatEvaluationError('not-supported', 'Invalid code');
// @ts-expect-error Raw floating values are readonly.
payload.bits = '0x0000000000000000';
