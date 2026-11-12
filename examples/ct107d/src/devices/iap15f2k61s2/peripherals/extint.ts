import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  SFR_INT_CLKO,
  SFR_IE,
  SFR_TCON,
  asBody,
  latchBitIsSet,
  number,
  periph8,
  sfrBitIsSet,
  setPeriph8,
  setSfrBit,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import type { InterruptSource } from '../kernel/interrupt';
import { EXTINT_BASE } from './layout';
import { pinName } from './ports';
import type { Peripheral } from './types';

/**
 * 外部中断 INT0–INT4。
 *
 * INT0/INT1 由 TCON.IT0/IT1 选择「仅下降沿」或「上升沿和下降沿均可」；INT2/INT3/INT4
 * 只能下降沿。请求标志：INT0/INT1 用 TCON.IE0/IE1（响应时硬件清除），INT2–INT4 手册
 * 未给出可见标志位，用 `periph` 内部锁存。边沿检测保留上一采样值；首个边界建立基线，
 * 不伪造上电沿。
 */

interface EdgeInput {
  readonly id: string;
  readonly port: number;
  readonly bit: number;
}

const EDGE_INPUTS: readonly EdgeInput[] = [
  { id: 'int0', port: 3, bit: 2 },
  { id: 'int1', port: 3, bit: 3 },
  { id: 'int2', port: 3, bit: 6 },
  { id: 'int3', port: 3, bit: 7 },
  { id: 'int4', port: 3, bit: 0 },
];

const TCON_IT0 = 0;
const TCON_IE0 = 1;
const TCON_IT1 = 2;
const TCON_IE1 = 3;

const LEVEL = (index: number): number => EXTINT_BASE + index;
const PENDING = (index: number): number => EXTINT_BASE + 5 + index;
const INITIALIZED = EXTINT_BASE + 8;

function levelBit(b: Body, input: EdgeInput): Value<number> {
  const high = b.equal(
    types.logic,
    b.field(b.readSample(pinName(input.port, input.bit)), 'level'),
    b.constant(types.logic, types.logic.members.high),
  );

  return b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.constant(types.number, 0),
  );
}

function edgeTrigger(
  b: Body,
  last: Value<number>,
  current: Value<number>,
  edgeOnly: Value<boolean>,
): { falling: Value<boolean>; trigger: Value<boolean> } {
  const falling = b.and(b.equal(types.number, last, number(b, 1)), (inner) =>
    inner.equal(types.number, current, number(asBody(inner), 0)),
  );
  const rising = b.and(b.equal(types.number, last, number(b, 0)), (inner) =>
    inner.equal(types.number, current, number(asBody(inner), 1)),
  );
  const anyEdge = b.or(falling, () => rising);

  return {
    falling,
    trigger: b.select(
      types.bool,
      edgeOnly,
      () => falling,
      () => anyEdge,
    ),
  };
}

function sources(): readonly InterruptSource[] {
  return [
    {
      id: 'int0',
      vector: IRQ_VECTORS.int0,
      query: 0,
      priority: { register: 'IP', bit: 0 },
      enabled: (b) => sfrBitIsSet(b, SFR_IE, 0),
      pending: (b) => sfrBitIsSet(b, SFR_TCON, TCON_IE0),
      acknowledge: (b) => setSfrBit(b, SFR_TCON, TCON_IE0, false),
    },
    {
      id: 'int1',
      vector: IRQ_VECTORS.int1,
      query: 2,
      priority: { register: 'IP', bit: 2 },
      enabled: (b) => sfrBitIsSet(b, SFR_IE, 2),
      pending: (b) => sfrBitIsSet(b, SFR_TCON, TCON_IE1),
      acknowledge: (b) => setSfrBit(b, SFR_TCON, TCON_IE1, false),
    },
    {
      id: 'int2',
      vector: IRQ_VECTORS.int2,
      query: 10,
      enabled: (b) => sfrBitIsSet(b, SFR_INT_CLKO, 4),
      pending: (b) => b.notEqual(types.number, periph8(b, PENDING(0)), number(b, 0)),
      acknowledge: (b) => setPeriph8(b, PENDING(0), 0),
    },
    {
      id: 'int3',
      vector: IRQ_VECTORS.int3,
      query: 11,
      enabled: (b) => sfrBitIsSet(b, SFR_INT_CLKO, 5),
      pending: (b) => b.notEqual(types.number, periph8(b, PENDING(1)), number(b, 0)),
      acknowledge: (b) => setPeriph8(b, PENDING(1), 0),
    },
    {
      id: 'int4',
      vector: IRQ_VECTORS.int4,
      query: 16,
      enabled: (b) => sfrBitIsSet(b, SFR_INT_CLKO, 6),
      pending: (b) => b.notEqual(types.number, periph8(b, PENDING(2)), number(b, 0)),
      acknowledge: (b) => setPeriph8(b, PENDING(2), 0),
    },
  ];
}

export function createExtint(): Peripheral {
  return {
    id: 'extint',
    writes: [SFR_TCON, SFR_INT_CLKO],
    onWrite(b) {
      markIrqDirty(b);
    },
    /** 任一边沿输入使能、或还没建立首个采样基线时才需要推进。 */
    active(b) {
      return b.or(b.notEqual(types.number, periph8(b, INITIALIZED), number(b, 0)), (inner) => {
        const s = asBody(inner);

        return s.or(latchBitIsSet(s, SFR_IE, 0), (next) =>
          asBody(next).or(latchBitIsSet(asBody(next), SFR_IE, 2), (more) => {
            const t = asBody(more);

            return t.or(latchBitIsSet(t, SFR_INT_CLKO, 4), (deeper) => {
              const u = asBody(deeper);

              return u.or(latchBitIsSet(u, SFR_INT_CLKO, 5), (last) =>
                latchBitIsSet(asBody(last), SFR_INT_CLKO, 6),
              );
            });
          }),
        );
      });
    },
    advance(b) {
      const initialized = b.notEqual(types.number, periph8(b, INITIALIZED), number(b, 0));

      b.if(
        b.not(initialized),
        (first) => {
          for (const [index, input] of EDGE_INPUTS.entries())
            setPeriph8(first, LEVEL(index), levelBit(first, input));

          setPeriph8(first, INITIALIZED, 1);
        },
        (ready) => {
          for (const [index, input] of EDGE_INPUTS.entries()) {
            // 未使能的输入不采样：边沿检测只对真的会响应中断的脚有意义。
            const enabled =
              input.id === 'int0'
                ? sfrBitIsSet(ready, SFR_IE, 0)
                : input.id === 'int1'
                  ? sfrBitIsSet(ready, SFR_IE, 2)
                  : sfrBitIsSet(ready, SFR_INT_CLKO, 4 + (index - 2));

            ready.if(enabled, (watching) => {
              const last = periph8(watching, LEVEL(index));
              const current = levelBit(watching, input);

              if (input.id === 'int0' || input.id === 'int1') {
                const line = input.id === 'int0' ? TCON_IT0 : TCON_IT1;
                const flag = input.id === 'int0' ? TCON_IE0 : TCON_IE1;
                const { trigger } = edgeTrigger(
                  watching,
                  last,
                  current,
                  sfrBitIsSet(watching, SFR_TCON, line),
                );

                setPeriph8(watching, LEVEL(index), current);
                watching.if(trigger, (hit) => {
                  setSfrBit(hit, SFR_TCON, flag, true);
                  markIrqDirty(hit);
                });
              } else {
                const { falling } = edgeTrigger(
                  watching,
                  last,
                  current,
                  watching.constant(types.bool, true),
                );

                setPeriph8(watching, LEVEL(index), current);
                watching.if(falling, (hit) => {
                  setPeriph8(hit, PENDING(index - 2), 1);
                  markIrqDirty(hit);
                });
              }
            });
          }
        },
      );
    },
    interrupts: sources(),
  };
}

/** 外部中断输入的引脚名，供测试与文档使用。 */
export const externalInterruptPins: readonly string[] = EDGE_INPUTS.map((input) =>
  pinName(input.port, input.bit),
);
