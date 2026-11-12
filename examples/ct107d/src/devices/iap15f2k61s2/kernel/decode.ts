import { types } from '@mica-js/sdk/model';
import type { JitTranslateInput } from '@mica-js/sdk/device';
import {
  CODE,
  CODE_MASK,
  XRAM_MASK,
  SFR_B,
  bitIsSet,
  byte,
  boolean,
  carryIs,
  carryValue,
  indirectIndex,
  jumpTo,
  jumpToValue,
  jumpWhen,
  latchedBitIsSet,
  number,
  popByte,
  pushByte,
  pushReturnAddress,
  readAcc,
  readDirect,
  readDptr,
  readIndirect,
  readLatch,
  readRegister,
  readSfr,
  readXram,
  setCarry,
  writeAcc,
  writeBit,
  writeDirect,
  writeFlags,
  writeSfr,
  writeDptr,
  writeIndirect,
  writeRegister,
  writeXram,
} from './ir';
import type { Body } from './ir';
import { emitAlu, emitDecimalAdjust } from './alu';
import { instructionCycles } from './cycles';
import { reti } from './interrupt';

interface Instruction {
  /** 指令字节数：决定顺序后继地址。 */
  readonly size: number;
  /** STC15 1T 内核执行该指令所需的系统时钟数。 */
  readonly cycles: number;
  readonly emit: (b: Body) => void;
}

const makeStep =
  (opcode: number) =>
  (size: number, emit: (b: Body) => void): Instruction => ({
    size,
    cycles: instructionCycles(opcode),
    emit,
  });

const noOperation = (opcode: number): Instruction => ({
  size: 1,
  cycles: instructionCycles(opcode),
  emit: () => {},
});

/** 相对寻址的 8 位有符号偏移。 */
const signedOffset = (value: number): number => (value < 0x80 ? value : value - 0x100);

/**
 * 按 PC 处的字节解码一条指令。
 *
 * 操作数与目标都在这里算成常量：生成的 IR 只描述数据通路，不携带译码逻辑。
 */
export const decode = (code: JitTranslateInput['code'], pc: number): Instruction => {
  const at = (offset: number): number => code[offset & CODE_MASK] ?? 0;
  const opcode = at(pc);
  const step = makeStep(opcode);
  const immediate = at(pc + 1);
  const second = at(pc + 2);
  const address16 = (immediate << 8) | second;
  const relative = (pc + 2 + signedOffset(immediate)) & CODE_MASK;
  const pageTarget = (((pc + 2) & 0xf800) | ((opcode & 0xe0) << 3) | immediate) & CODE_MASK;
  const aluGroup = opcode & 0xf0;
  const aluForm = opcode & 0x0f;

  // AJMP / ACALL：页内跳转与调用。
  switch (opcode & 0x1f) {
    case 0x01:
      return step(2, (b) => jumpTo(b, pageTarget));

    case 0x11:
      return step(2, (b) => {
        pushReturnAddress(b, (pc + 2) & CODE_MASK);
        jumpTo(b, pageTarget);
      });
  }

  // ADD / ADDC / ORL / ANL / XRL / SUBB 的 A 与源操作数组。
  if (
    aluForm >= 0x04 &&
    (aluGroup === 0x20 ||
      aluGroup === 0x30 ||
      aluGroup === 0x40 ||
      aluGroup === 0x50 ||
      aluGroup === 0x60 ||
      aluGroup === 0x90)
  ) {
    switch (aluForm) {
      case 0x04:
        return step(2, (b) => emitAlu(b, aluGroup, number(b, immediate)));

      case 0x05:
        return step(2, (b) => emitAlu(b, aluGroup, readDirect(b, immediate)));

      case 0x06:
      case 0x07:
        return step(1, (b) => emitAlu(b, aluGroup, readIndirect(b, aluForm & 1)));

      default:
        return step(1, (b) => emitAlu(b, aluGroup, readRegister(b, aluForm & 7)));
    }
  }

  switch (opcode) {
    case 0x00:
    case 0xa5:
      return noOperation(opcode);

    case 0x02:
      return step(3, (b) => jumpTo(b, address16));

    case 0x12:
      return step(3, (b) => {
        pushReturnAddress(b, (pc + 3) & CODE_MASK);
        jumpTo(b, address16);
      });

    case 0x03:
      return step(1, (b) => {
        const value = readAcc(b);

        writeAcc(
          b,
          b.bitOr(b.shiftRightUnsigned(value, number(b, 1)), b.shiftLeft(value, number(b, 7))),
        );
      });

    case 0x04:
      return step(1, (b) => writeAcc(b, b.add(readAcc(b), number(b, 1))));

    case 0x05:
      return step(2, (b) =>
        writeDirect(b, immediate, b.add(readLatch(b, immediate), number(b, 1))),
      );

    case 0x06:
    case 0x07:
      return step(1, (b) => {
        const register = opcode & 1;

        writeIndirect(b, register, b.add(readIndirect(b, register), number(b, 1)));
      });

    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x0e:
    case 0x0f:
      return step(1, (b) => {
        const register = opcode & 7;

        writeRegister(b, register, b.add(readRegister(b, register), number(b, 1)));
      });

    case 0x10:
      // JBC：位为 1 时清位并跳转；清位是读-改-写。
      return step(3, (b) => {
        const set = bitIsSet(b, immediate);

        writeBit(b, immediate, boolean(b, false));
        jumpWhen(b, set, (pc + 3 + signedOffset(second)) & CODE_MASK);
      });

    case 0x13:
      return step(1, (b) => {
        const value = readAcc(b);
        const carry = carryValue(b);

        writeAcc(
          b,
          b.bitOr(b.shiftRightUnsigned(value, number(b, 1)), b.shiftLeft(carry, number(b, 7))),
        );
        setCarry(b, b.equal(types.number, b.bitAnd(value, number(b, 1)), number(b, 1)));
      });

    case 0x14:
      return step(1, (b) => writeAcc(b, b.subtract(readAcc(b), number(b, 1))));

    case 0x15:
      return step(2, (b) =>
        writeDirect(b, immediate, b.subtract(readLatch(b, immediate), number(b, 1))),
      );

    case 0x16:
    case 0x17:
      return step(1, (b) => {
        const register = opcode & 1;

        writeIndirect(b, register, b.subtract(readIndirect(b, register), number(b, 1)));
      });

    case 0x18:
    case 0x19:
    case 0x1a:
    case 0x1b:
    case 0x1c:
    case 0x1d:
    case 0x1e:
    case 0x1f:
      return step(1, (b) => {
        const register = opcode & 7;

        writeRegister(b, register, b.subtract(readRegister(b, register), number(b, 1)));
      });

    case 0x20:
      return step(3, (b) =>
        jumpWhen(b, bitIsSet(b, immediate), (pc + 3 + signedOffset(second)) & CODE_MASK),
      );

    case 0x22:
      return step(1, (b) => {
        const high = popByte(b);
        const low = popByte(b);

        jumpToValue(b, b.bitOr(b.shiftLeft(high, number(b, 8)), low));
      });

    case 0x32:
      return step(1, (b) => reti(b));

    case 0x23:
      return step(1, (b) => {
        const value = readAcc(b);

        writeAcc(
          b,
          b.bitOr(b.shiftLeft(value, number(b, 1)), b.shiftRightUnsigned(value, number(b, 7))),
        );
      });

    case 0x30:
      return step(3, (b) =>
        jumpWhen(b, b.not(bitIsSet(b, immediate)), (pc + 3 + signedOffset(second)) & CODE_MASK),
      );

    case 0x33:
      return step(1, (b) => {
        const value = readAcc(b);
        const carry = carryValue(b);

        writeAcc(b, b.bitOr(b.shiftLeft(value, number(b, 1)), carry));
        setCarry(b, b.equal(types.number, b.bitAnd(value, number(b, 0x80)), number(b, 0x80)));
      });

    case 0x40:
      return step(2, (b) => jumpWhen(b, carryIs(b), relative));

    case 0x42:
      return step(2, (b) =>
        writeDirect(b, immediate, b.bitOr(readLatch(b, immediate), readAcc(b))),
      );

    case 0x43:
      return step(3, (b) =>
        writeDirect(b, immediate, b.bitOr(readLatch(b, immediate), number(b, second))),
      );

    case 0x50:
      return step(2, (b) => jumpWhen(b, b.not(carryIs(b)), relative));

    case 0x52:
      return step(2, (b) =>
        writeDirect(b, immediate, b.bitAnd(readLatch(b, immediate), readAcc(b))),
      );

    case 0x53:
      return step(3, (b) =>
        writeDirect(b, immediate, b.bitAnd(readLatch(b, immediate), number(b, second))),
      );

    case 0x60:
      return step(2, (b) => jumpWhen(b, b.equal(types.number, readAcc(b), number(b, 0)), relative));

    case 0x62:
      return step(2, (b) =>
        writeDirect(b, immediate, b.bitXor(readLatch(b, immediate), readAcc(b))),
      );

    case 0x63:
      return step(3, (b) =>
        writeDirect(b, immediate, b.bitXor(readLatch(b, immediate), number(b, second))),
      );

    case 0x70:
      return step(2, (b) =>
        jumpWhen(b, b.notEqual(types.number, readAcc(b), number(b, 0)), relative),
      );

    case 0x72:
      return step(2, (b) => {
        const bit = bitIsSet(b, immediate);

        setCarry(
          b,
          b.or(carryIs(b), () => bit),
        );
      });

    case 0x73:
      return step(1, (b) => jumpToValue(b, b.add(readAcc(b), readDptr(b))));

    case 0x74:
      return step(2, (b) => writeAcc(b, number(b, immediate)));

    case 0x75:
      return step(3, (b) => writeDirect(b, immediate, number(b, second)));

    case 0x76:
    case 0x77:
      return step(2, (b) => writeIndirect(b, opcode & 1, number(b, immediate)));

    case 0x78:
    case 0x79:
    case 0x7a:
    case 0x7b:
    case 0x7c:
    case 0x7d:
    case 0x7e:
    case 0x7f:
      return step(2, (b) => writeRegister(b, opcode & 7, number(b, immediate)));

    case 0x80:
      return step(2, (b) => jumpTo(b, relative));

    case 0x82:
      return step(2, (b) => {
        const bit = bitIsSet(b, immediate);

        setCarry(
          b,
          b.and(carryIs(b), () => bit),
        );
      });

    case 0x83:
      // MOVC A,@A+PC：基准是取完指令之后的 PC。
      return step(1, (b) => {
        const offset = b.bitAnd(
          b.add(readAcc(b), number(b, (pc + 1) & CODE_MASK)),
          number(b, CODE_MASK),
        );

        writeAcc(b, b.load8(CODE, offset));
      });

    case 0x84:
      return step(1, (b) => {
        const dividend = readAcc(b);
        const divisor = readSfr(b, SFR_B);
        const zero = b.equal(types.number, divisor, number(b, 0));
        const quotient = b.floor(b.divide(dividend, divisor));
        const remainder = b.remainder(dividend, divisor);

        // 除数为 0 时 OV=1，A/B 保持原值（手册里是未定义，这里选最不意外的行为）。
        writeAcc(
          b,
          b.select(
            types.number,
            zero,
            () => dividend,
            () => quotient,
          ),
        );
        writeSfr(
          b,
          SFR_B,
          b.select(
            types.number,
            zero,
            () => divisor,
            () => remainder,
          ),
        );
        writeFlags(b, boolean(b, false), boolean(b, false), zero);
      });

    case 0x85:
      return step(3, (b) => writeDirect(b, second, readDirect(b, immediate)));

    case 0x86:
    case 0x87:
      return step(2, (b) => writeDirect(b, immediate, readIndirect(b, opcode & 1)));

    case 0x88:
    case 0x89:
    case 0x8a:
    case 0x8b:
    case 0x8c:
    case 0x8d:
    case 0x8e:
    case 0x8f:
      return step(2, (b) => writeDirect(b, immediate, readRegister(b, opcode & 7)));

    case 0x90:
      return step(3, (b) => writeDptr(b, number(b, address16)));

    case 0x92:
      return step(2, (b) => writeBit(b, immediate, carryIs(b)));

    case 0x93:
      return step(1, (b) => {
        const offset = b.bitAnd(b.add(readAcc(b), readDptr(b)), number(b, CODE_MASK));

        writeAcc(b, b.load8(CODE, offset));
      });

    case 0xa0:
      return step(2, (b) => {
        const inverted = b.not(bitIsSet(b, immediate));

        setCarry(
          b,
          b.or(carryIs(b), () => inverted),
        );
      });

    case 0xa2:
      return step(2, (b) => setCarry(b, bitIsSet(b, immediate)));

    case 0xa3:
      return step(1, (b) => writeDptr(b, b.add(readDptr(b), number(b, 1))));

    case 0xa4:
      return step(1, (b) => {
        const product = b.multiply(readAcc(b), readSfr(b, SFR_B));
        const high = b.bitAnd(b.shiftRightUnsigned(product, number(b, 8)), number(b, 0xff));

        writeAcc(b, b.bitAnd(product, number(b, 0xff)));
        writeSfr(b, SFR_B, high);
        writeFlags(
          b,
          boolean(b, false),
          boolean(b, false),
          b.notEqual(types.number, high, number(b, 0)),
        );
      });

    case 0xa6:
    case 0xa7:
      return step(2, (b) => writeIndirect(b, opcode & 1, readDirect(b, immediate)));

    case 0xa8:
    case 0xa9:
    case 0xaa:
    case 0xab:
    case 0xac:
    case 0xad:
    case 0xae:
    case 0xaf:
      return step(2, (b) => writeRegister(b, opcode & 7, readDirect(b, immediate)));

    case 0xb0:
      return step(2, (b) => {
        const inverted = b.not(bitIsSet(b, immediate));

        setCarry(
          b,
          b.and(carryIs(b), () => inverted),
        );
      });

    case 0xb2:
      return step(2, (b) => writeBit(b, immediate, b.not(latchedBitIsSet(b, immediate))));

    case 0xb3:
      return step(1, (b) => setCarry(b, b.not(carryIs(b))));

    case 0xb4:
    case 0xb5:
    case 0xb6:
    case 0xb7:
    case 0xb8:
    case 0xb9:
    case 0xba:
    case 0xbb:
    case 0xbc:
    case 0xbd:
    case 0xbe:
    case 0xbf:
      return step(3, (b) => {
        const left =
          opcode === 0xb4 || opcode === 0xb5
            ? readAcc(b)
            : opcode <= 0xb7
              ? readIndirect(b, opcode & 1)
              : readRegister(b, opcode & 7);
        const right =
          opcode === 0xb4 || opcode >= 0xb6 ? number(b, immediate) : readDirect(b, immediate);
        const target = (pc + 3 + signedOffset(second)) & CODE_MASK;

        setCarry(b, b.lessThan(left, right));
        jumpWhen(b, b.notEqual(types.number, left, right), target);
      });

    case 0xc0:
      return step(2, (b) => pushByte(b, readDirect(b, immediate)));

    case 0xc2:
      return step(2, (b) => writeBit(b, immediate, boolean(b, false)));

    case 0xc3:
      return step(1, (b) => setCarry(b, boolean(b, false)));

    case 0xc4:
      return step(1, (b) => {
        const value = readAcc(b);

        writeAcc(
          b,
          b.bitOr(b.shiftLeft(value, number(b, 4)), b.shiftRightUnsigned(value, number(b, 4))),
        );
      });

    case 0xc5:
      return step(2, (b) => {
        const other = readLatch(b, immediate);
        const acc = readAcc(b);

        writeAcc(b, other);
        writeDirect(b, immediate, acc);
      });

    case 0xc6:
    case 0xc7:
      return step(1, (b) => {
        const register = opcode & 1;
        const other = readIndirect(b, register);
        const acc = readAcc(b);

        writeAcc(b, other);
        writeIndirect(b, register, acc);
      });

    case 0xc8:
    case 0xc9:
    case 0xca:
    case 0xcb:
    case 0xcc:
    case 0xcd:
    case 0xce:
    case 0xcf:
      return step(1, (b) => {
        const register = opcode & 7;
        const other = readRegister(b, register);
        const acc = readAcc(b);

        writeAcc(b, other);
        writeRegister(b, register, acc);
      });

    case 0xd0:
      return step(2, (b) => writeDirect(b, immediate, popByte(b)));

    case 0xd2:
      return step(2, (b) => writeBit(b, immediate, boolean(b, true)));

    case 0xd3:
      return step(1, (b) => setCarry(b, boolean(b, true)));

    case 0xd4:
      return step(1, (b) => emitDecimalAdjust(b));

    case 0xd5:
      return step(3, (b) => {
        const value = byte(b, b.subtract(readLatch(b, immediate), number(b, 1)));

        jumpWhen(
          b,
          b.notEqual(types.number, value, number(b, 0)),
          (pc + 3 + signedOffset(second)) & CODE_MASK,
        );
        writeDirect(b, immediate, value);
      });

    case 0xd6:
    case 0xd7:
      return step(1, (b) => {
        const register = opcode & 1;
        const other = readIndirect(b, register);
        const acc = readAcc(b);

        writeAcc(b, b.bitOr(b.bitAnd(acc, number(b, 0xf0)), b.bitAnd(other, number(b, 0x0f))));
        writeIndirect(
          b,
          register,
          b.bitOr(b.bitAnd(other, number(b, 0xf0)), b.bitAnd(acc, number(b, 0x0f))),
        );
      });

    case 0xd8:
    case 0xd9:
    case 0xda:
    case 0xdb:
    case 0xdc:
    case 0xdd:
    case 0xde:
    case 0xdf:
      return step(2, (b) => {
        const register = opcode & 7;
        const value = byte(b, b.subtract(readRegister(b, register), number(b, 1)));

        jumpWhen(b, b.notEqual(types.number, value, number(b, 0)), relative);
        writeRegister(b, register, value);
      });

    case 0xe0:
      return step(1, (b) => {
        const address = b.bitAnd(readDptr(b), number(b, XRAM_MASK));

        writeAcc(b, readXram(b, address));
      });

    case 0xe2:
    case 0xe3:
      return step(1, (b) => {
        const address = b.bitAnd(indirectIndex(b, opcode & 1), number(b, 0xff));

        writeAcc(b, readXram(b, address));
      });

    case 0xe4:
      return step(1, (b) => writeAcc(b, number(b, 0)));

    case 0xe5:
      return step(2, (b) => writeAcc(b, readDirect(b, immediate)));

    case 0xe6:
    case 0xe7:
      return step(1, (b) => writeAcc(b, readIndirect(b, opcode & 1)));

    case 0xe8:
    case 0xe9:
    case 0xea:
    case 0xeb:
    case 0xec:
    case 0xed:
    case 0xee:
    case 0xef:
      return step(1, (b) => writeAcc(b, readRegister(b, opcode & 7)));

    case 0xf0:
      return step(1, (b) => {
        writeXram(b, b.bitAnd(readDptr(b), number(b, XRAM_MASK)), readAcc(b));
      });

    case 0xf2:
    case 0xf3:
      return step(1, (b) => {
        writeXram(b, b.bitAnd(indirectIndex(b, opcode & 1), number(b, 0xff)), readAcc(b));
      });

    case 0xf4:
      return step(1, (b) => writeAcc(b, b.bitXor(readAcc(b), number(b, 0xff))));

    case 0xf5:
      return step(2, (b) => writeDirect(b, immediate, readAcc(b)));

    case 0xf6:
    case 0xf7:
      return step(1, (b) => writeIndirect(b, opcode & 1, readAcc(b)));

    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfd:
    case 0xfe:
    case 0xff:
      return step(1, (b) => writeRegister(b, opcode & 7, readAcc(b)));

    default:
      // 保留操作码按 NOP 处理，与固件里的空字节一致。
      return noOperation(opcode);
  }
};
