import { types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder, Value } from '@mica-js/sdk/model';
import { machine } from './machine';

/**
 * 内核共用的取值与访存辅助。
 *
 * 这一层只描述数据通路：所有操作在翻译期展开成常量地址，生成的 IR 不携带译码逻辑。
 * SFR 读写在 `sfr-hooks` 处转交给外设注册的钩子，端口与定时器因此能改写「锁存器」语义。
 */

export type Body = JitInstructionBuilder;

/** 惰性分支回调拿到的是更窄的计算视图；内核辅助只需要两者共有的取值与控制流能力。 */
export const asBody = (compute: unknown): Body => compute as Body;

export const CODE = 'code';
export const IRAM = 'iram';
export const SFR = 'sfr';
export const XRAM = 'xram';
export const PERIPH = 'periph';
export const FLASH = 'flash';
export const CLOCK = 'clockPs';

/** SFR 地址：锁存器下标等于地址低 7 位。 */
export const SFR_P0 = 0x80;
export const SFR_SP = 0x81;
export const SFR_DPL = 0x82;
export const SFR_DPH = 0x83;
export const SFR_PCON = 0x87;
export const SFR_TCON = 0x88;
export const SFR_TMOD = 0x89;
export const SFR_TL0 = 0x8a;
export const SFR_TL1 = 0x8b;
export const SFR_TH0 = 0x8c;
export const SFR_TH1 = 0x8d;
export const SFR_AUXR = 0x8e;
export const SFR_INT_CLKO = 0x8f;
export const SFR_P1 = 0x90;
export const SFR_P1M1 = 0x91;
export const SFR_P1M0 = 0x92;
export const SFR_P0M1 = 0x93;
export const SFR_P0M0 = 0x94;
export const SFR_P2M1 = 0x95;
export const SFR_P2M0 = 0x96;
export const SFR_CLK_DIV = 0x97;
export const SFR_SCON = 0x98;
export const SFR_SBUF = 0x99;
export const SFR_S2CON = 0x9a;
export const SFR_S2BUF = 0x9b;
export const SFR_P1ASF = 0x9d;
export const SFR_P2 = 0xa0;
export const SFR_BUS_SPEED = 0xa1;
export const SFR_P_SW1 = 0xa2;
export const SFR_IE = 0xa8;
export const SFR_SADDR = 0xa9;
export const SFR_WKTCL = 0xaa;
export const SFR_WKTCH = 0xab;
export const SFR_P3 = 0xb0;
export const SFR_P3M1 = 0xb1;
export const SFR_P3M0 = 0xb2;
export const SFR_P4M1 = 0xb3;
export const SFR_P4M0 = 0xb4;
export const SFR_IP2 = 0xb5;
export const SFR_IP2H = 0xb6;
export const SFR_IPH = 0xb7;
export const SFR_IP = 0xb8;
export const SFR_SADEN = 0xb9;
export const SFR_P_SW2 = 0xba;
export const SFR_ADC_CONTR = 0xbc;
export const SFR_ADC_RES = 0xbd;
export const SFR_ADC_RESL = 0xbe;
export const SFR_P4 = 0xc0;
export const SFR_WDT_CONTR = 0xc1;
export const SFR_IAP_DATA = 0xc2;
export const SFR_IAP_ADDRH = 0xc3;
export const SFR_IAP_ADDRL = 0xc4;
export const SFR_IAP_CMD = 0xc5;
export const SFR_IAP_TRIG = 0xc6;
export const SFR_IAP_CONTR = 0xc7;
export const SFR_PSW = 0xd0;
export const SFR_T2H = 0xd6;
export const SFR_T2L = 0xd7;
export const SFR_CCON = 0xd8;
export const SFR_CMOD = 0xd9;
export const SFR_CCAPM0 = 0xda;
export const SFR_CCAPM1 = 0xdb;
export const SFR_CCAPM2 = 0xdc;
export const SFR_ACC = 0xe0;
export const SFR_CL = 0xe9;
export const SFR_CCAP0L = 0xea;
export const SFR_CCAP1L = 0xeb;
export const SFR_CCAP2L = 0xec;
export const SFR_B = 0xf0;
export const SFR_PCA_PWM0 = 0xf2;
export const SFR_PCA_PWM1 = 0xf3;
export const SFR_PCA_PWM2 = 0xf4;
export const SFR_CH = 0xf9;
export const SFR_CCAP0H = 0xfa;
export const SFR_CCAP1H = 0xfb;
export const SFR_CCAP2H = 0xfc;

export const PSW_CY = 0x80;
export const PSW_AC = 0x40;
export const PSW_OV = 0x04;
export const PSW_P = 0x01;
export const PSW_REGISTER_BANK = 0x18;

export const CODE_MASK = 0xffff;
export const XRAM_MASK = 0x6ff;
export const LOW_RAM_SIZE = 0x80;

export const number = (b: Body, value: number): Value<number> => b.constant(types.number, value);

/** 一个系统时钟周期的整数皮秒数（当前实例）。 */
export const cyclePicoseconds = (): number => machine().cyclePs;

/** 把经过的仿真时间换算成系统时钟数（向下取整）。 */
export const toCycles = (b: Body, elapsedPs: Value<number>): Value<number> =>
  b.floor(b.divide(elapsedPs, number(b, machine().cyclePs)));

export const boolean = (b: Body, value: boolean): Value<boolean> => b.constant(types.bool, value);

/** 取低 8 位：IR 的 `number` 是 binary64，字节语义要自己截断。 */
export const byte = (b: Body, value: Value<number> | number): Value<number> =>
  b.bitAnd(typeof value === 'number' ? number(b, value) : value, number(b, 0xff));

export const readSfr = (b: Body, address: number): Value<number> => machine().sfr.read(b, address);

export const writeSfr = (b: Body, address: number, value: Value<number>): void => {
  machine().sfr.write(b, address & 0xff, value);
};

/** SFR 锁存器原值：不经过读钩子（读-改-写指令用）。 */
export const readSfrLatch = (b: Body, address: number): Value<number> =>
  b.load8(SFR, number(b, address & 0x7f));

/** 读 SFR 的单个位，返回 0/1。 */
export const readSfrBit = (b: Body, address: number, bit: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(readSfr(b, address), number(b, bit)), number(b, 1));

/**
 * 读 SFR 锁存器的单个位（不触发读钩子）。
 *
 * 外设判断自己的控制位、以及「活动门控」都用这条路径：它们只关心软件写入的控制位，
 * 不需要读引脚语义，也不应该触发读之前的同步推进。
 */
export const latchBitIsSet = (b: Body, address: number, bit: number): Value<boolean> =>
  b.equal(
    types.number,
    b.bitAnd(b.shiftRightUnsigned(readSfrLatch(b, address), number(b, bit)), number(b, 1)),
    number(b, 1),
  );

export const sfrBitIsSet = (b: Body, address: number, bit: number): Value<boolean> =>
  b.equal(types.number, readSfrBit(b, address, bit), number(b, 1));

/** 把 SFR 的一个位改成 `one`，其余位保持。 */
export const writeSfrBit = (b: Body, address: number, bit: number, one: Value<boolean>): void => {
  const mask = 1 << bit;
  const current = readSfr(b, address);
  const set = b.bitOr(current, number(b, mask));
  const clear = b.bitAnd(current, number(b, 0xff & ~mask));

  writeSfr(
    b,
    address,
    b.select(
      types.number,
      one,
      () => set,
      () => clear,
    ),
  );
};

/** 直接把 SFR 的某个位写成常量。 */
export const setSfrBit = (b: Body, address: number, bit: number, value: boolean): void => {
  const mask = 1 << bit;
  const current = readSfr(b, address);

  writeSfr(
    b,
    address,
    value ? b.bitOr(current, number(b, mask)) : b.bitAnd(current, number(b, 0xff & ~mask)),
  );
};

export const periph8 = (b: Body, offset: number): Value<number> =>
  b.load8(PERIPH, number(b, offset));

export const setPeriph8 = (b: Body, offset: number, value: Value<number> | number): void => {
  b.store8(PERIPH, number(b, offset), byte(b, value));
};

export const periph16 = (b: Body, offset: number): Value<number> =>
  b.load16le(PERIPH, number(b, offset));

export const setPeriph16 = (b: Body, offset: number, value: Value<number>): void => {
  b.store16le(PERIPH, number(b, offset), b.bitAnd(value, number(b, 0xffff)));
};

export const periph32 = (b: Body, offset: number): Value<number> =>
  b.load32le(PERIPH, number(b, offset));

export const setPeriph32 = (b: Body, offset: number, value: Value<number>): void => {
  b.store32le(PERIPH, number(b, offset), value);
};

/** 内部 RAM 或 SFR 的锁存器读取：不经过端口引脚语义。 */
export const readLatch = (b: Body, address: number): Value<number> =>
  address < LOW_RAM_SIZE ? b.load8(IRAM, number(b, address)) : readSfrLatch(b, address);

export const readAcc = (b: Body): Value<number> => readSfr(b, SFR_ACC);

export const readPsw = (b: Body): Value<number> => readSfr(b, SFR_PSW);

/** A 的奇偶位：P=1 表示 A 里 1 的个数是奇数。 */
export const parityOf = (b: Body, value: Value<number>): Value<number> => {
  let folded = value;

  folded = b.bitXor(folded, b.shiftRightUnsigned(folded, number(b, 4)));
  folded = b.bitXor(folded, b.shiftRightUnsigned(folded, number(b, 2)));
  folded = b.bitXor(folded, b.shiftRightUnsigned(folded, number(b, 1)));

  return b.bitAnd(folded, number(b, 1));
};

/** 写 A，并按 8051 语义同步 PSW.P。 */
export const writeAcc = (b: Body, value: Value<number>): void => {
  const result = byte(b, value);

  writeSfr(b, SFR_ACC, result);
  writeSfr(
    b,
    SFR_PSW,
    b.bitOr(b.bitAnd(readPsw(b), number(b, 0xff & ~PSW_P)), parityOf(b, result)),
  );
};

export const carryIs = (b: Body): Value<boolean> =>
  b.equal(types.number, b.bitAnd(readPsw(b), number(b, PSW_CY)), number(b, PSW_CY));

/** PSW.CY 的 0/1 值：ADDC/SUBB/RRC/RLC 的进位输入。 */
export const carryValue = (b: Body): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(readPsw(b), number(b, 7)), number(b, 1));

export const setCarry = (b: Body, value: Value<boolean>): void => {
  const psw = readPsw(b);
  const set = b.bitOr(psw, number(b, PSW_CY));
  const clear = b.bitAnd(psw, number(b, 0x7f));

  writeSfr(
    b,
    SFR_PSW,
    b.select(
      types.number,
      value,
      () => set,
      () => clear,
    ),
  );
};

/** 一次写齐 CY/AC/OV：P、F0 与寄存器组选择位保持。 */
export const writeFlags = (
  b: Body,
  carry: Value<boolean>,
  auxiliary: Value<boolean>,
  overflow: Value<boolean>,
): void => {
  const kept = b.bitAnd(readPsw(b), number(b, 0x39));
  const zero = number(b, 0);
  const carryBit = number(b, PSW_CY);
  const auxiliaryBit = number(b, PSW_AC);
  const overflowBit = number(b, PSW_OV);
  const withCarry = b.bitOr(
    kept,
    b.select(
      types.number,
      carry,
      () => carryBit,
      () => zero,
    ),
  );
  const withAuxiliary = b.bitOr(
    withCarry,
    b.select(
      types.number,
      auxiliary,
      () => auxiliaryBit,
      () => zero,
    ),
  );

  writeSfr(
    b,
    SFR_PSW,
    b.bitOr(
      withAuxiliary,
      b.select(
        types.number,
        overflow,
        () => overflowBit,
        () => zero,
      ),
    ),
  );
};

export const readDptr = (b: Body): Value<number> =>
  b.bitOr(b.shiftLeft(readSfr(b, SFR_DPH), number(b, 8)), readSfr(b, SFR_DPL));

export const writeDptr = (b: Body, value: Value<number>): void => {
  writeSfr(b, SFR_DPL, b.bitAnd(value, number(b, 0xff)));
  writeSfr(b, SFR_DPH, b.bitAnd(b.shiftRightUnsigned(value, number(b, 8)), number(b, 0xff)));
};

/** 当前寄存器组里 Rn 的内部 RAM 下标。 */
export const registerIndex = (b: Body, register: number): Value<number> =>
  b.bitOr(b.bitAnd(readPsw(b), number(b, PSW_REGISTER_BANK)), number(b, register));

/** @Ri 指向的内部 RAM 地址：寄存器里存的是地址。 */
export const indirectIndex = (b: Body, register: number): Value<number> =>
  b.load8(IRAM, registerIndex(b, register));

export const readRegister = (b: Body, register: number): Value<number> =>
  b.load8(IRAM, registerIndex(b, register));

export const writeRegister = (b: Body, register: number, value: Value<number>): void => {
  b.store8(IRAM, registerIndex(b, register), byte(b, value));
};

export const readIndirect = (b: Body, register: number): Value<number> =>
  b.load8(IRAM, indirectIndex(b, register));

export const writeIndirect = (b: Body, register: number, value: Value<number>): void => {
  b.store8(IRAM, indirectIndex(b, register), byte(b, value));
};

const PORT_LATCH_ADDRESSES: ReadonlySet<number> = new Set([0x80, 0x90, 0xa0, 0xb0]);

/** 直接地址读：低于 80H 读内部 RAM；P0–P3 读引脚电平；其余读 SFR 锁存器。 */
export const readDirect = (b: Body, address: number): Value<number> => {
  if (address < LOW_RAM_SIZE) return b.load8(IRAM, number(b, address));

  return PORT_LATCH_ADDRESSES.has(address)
    ? machine().ports.readPort(b, (address >> 4) & 0x03)
    : readSfr(b, address);
};

/** 写直接地址：内部 RAM 或 SFR；SFR 写入后触发对应外设钩子。 */
export const writeDirect = (b: Body, address: number, value: Value<number>): void => {
  if (address < LOW_RAM_SIZE) {
    b.store8(IRAM, number(b, address), byte(b, value));

    return;
  }

  writeSfr(b, address, value);
};

/**
 * 位地址换算成字节地址：00H–7FH 是位寻址 RAM（20H–2FH），80H 以上是位寻址 SFR。
 * 位号固定为地址低 3 位。
 */
export const bitByteAddress = (address: number): number =>
  address < LOW_RAM_SIZE ? 0x20 + (address >> 3) : address & 0xf8;

/** 位地址：先换算到字节，再取该字节的对应位。 */
export const readBit = (b: Body, address: number): Value<number> => {
  const byteAddress = bitByteAddress(address);
  const bit = address & 0x07;

  if (PORT_LATCH_ADDRESSES.has(byteAddress))
    return machine().ports.readPin(b, (byteAddress >> 4) & 0x03, bit);

  return b.bitAnd(b.shiftRightUnsigned(readDirect(b, byteAddress), number(b, bit)), number(b, 1));
};

export const bitIsSet = (b: Body, address: number): Value<boolean> =>
  b.equal(types.number, readBit(b, address), number(b, 1));

/** 位操作里读-改-写的另一半：读锁存器而不是引脚。 */
export const latchedBitIsSet = (b: Body, address: number): Value<boolean> =>
  b.equal(
    types.number,
    b.bitAnd(
      b.shiftRightUnsigned(readLatch(b, bitByteAddress(address)), number(b, address & 0x07)),
      number(b, 1),
    ),
    number(b, 1),
  );

/** 位写：读-改-写锁存器（不读引脚）。 */
export const writeBit = (b: Body, address: number, one: Value<boolean>): void => {
  const byteAddress = bitByteAddress(address);
  const mask = 1 << (address & 0x07);
  const current = readLatch(b, byteAddress);
  const set = b.bitOr(current, number(b, mask));
  const clear = b.bitAnd(current, number(b, 0xff & ~mask));

  writeDirect(
    b,
    byteAddress,
    b.select(
      types.number,
      one,
      () => set,
      () => clear,
    ),
  );
};

export const pushByte = (b: Body, value: Value<number>): void => {
  const sp = byte(b, b.add(readSfr(b, SFR_SP), number(b, 1)));

  writeSfr(b, SFR_SP, sp);
  b.store8(IRAM, sp, byte(b, value));
};

/** 调用压栈：8051 先压返回地址低字节，再压高字节。 */
export const pushReturnAddress = (b: Body, address: number): void => {
  pushByte(b, number(b, address & 0xff));
  pushByte(b, number(b, (address >> 8) & 0xff));
};

/** 返回地址由运行时给出（节拍服务块）时的压栈。 */
export const pushAddressValue = (b: Body, address: Value<number>): void => {
  const low = byte(b, address);
  const high = byte(b, b.shiftRightUnsigned(address, number(b, 8)));

  pushByte(b, low);
  pushByte(b, high);
};

export const popByte = (b: Body): Value<number> => {
  const sp = readSfr(b, SFR_SP);
  const value = b.load8(IRAM, sp);

  writeSfr(b, SFR_SP, byte(b, b.subtract(sp, number(b, 1))));

  return value;
};

export const jumpTo = (b: Body, target: number): void => {
  b.writeState('pc', number(b, target & CODE_MASK));
};

/** 目标由运行时算出（RET、JMP @A+DPTR）时先掩到 16 位再写 PC。 */
export const jumpToValue = (b: Body, target: Value<number>): void => {
  b.writeState('pc', b.bitAnd(target, number(b, CODE_MASK)));
};

/** 条件跳转：条件成立时改写 PC，否则保持运行时已经写入的顺序后继。 */
export const jumpWhen = (b: Body, condition: Value<boolean>, target: number): void => {
  b.if(condition, (branch) => {
    branch.writeState('pc', branch.constant(types.number, target & CODE_MASK));
  });
};

/**
 * MOVX 访问：AUXR.EXTRAM=1 时禁止访问片内扩展 RAM，改走外部总线。
 * 本器件不建模外部数据总线，读出为全 1、写入被忽略。
 */
export const readXram = (b: Body, address: Value<number>): Value<number> =>
  b.select(
    types.number,
    sfrBitIsSet(b, SFR_AUXR, 1),
    (inner) => inner.constant(types.number, 0xff),
    (inner) => inner.load8(XRAM, address),
  );

export const writeXram = (b: Body, address: Value<number>, value: Value<number>): void => {
  b.if(b.not(sfrBitIsSet(b, SFR_AUXR, 1)), (allowed) => {
    allowed.store8(XRAM, address, byte(allowed, value));
  });
};
