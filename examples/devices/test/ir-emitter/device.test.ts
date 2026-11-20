import { describe, expect, it } from 'vitest';
import { readMetadata } from '../harness.ts';
import {
  carrierEvents,
  createEmitterFixture as fixture,
  isCarrier,
  setCarrier,
  setSource,
} from './fixture.ts';

/**
 * 红外发射端的数字侧行为：mod 引脚、宿主 setCarrier、供电门控与事件去重。
 *
 * 两个测试源分别驱动 VCC 和 mod；源的 level=1/0 表示拉高/拉低，2 表示释放。
 * 不涉及任何光电或电流量。
 */

describe('ir-emitter', () => {
  it('清单声明 mod/VCC/GND 三根引脚、宿主方法与载波事件', () => {
    const metadata = readMetadata('ir-emitter');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['gnd', 'mod', 'vcc']);
    expect(metadata.model.methods.setCarrier).toBeDefined();
    expect(metadata.model.methods.isCarrier).toBeDefined();
    expect(metadata.model.events.onDidCarrier).toMatchObject({ type: 'boolean' });
  });

  it('上电后 mod 高电平产生载波，低电平撤销', async () => {
    const board = await fixture();

    try {
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'vccDrv', true);
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'modDrv', true);
      expect(isCarrier(board)).toBe(true);

      setSource(board, 'modDrv', false);
      expect(isCarrier(board)).toBe(false);
      expect(carrierEvents(board)).toEqual([false, true, false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('宿主 setCarrier 与 mod 引脚是逻辑或，重复请求不重复发事件', async () => {
    const board = await fixture();

    try {
      setSource(board, 'vccDrv', true);
      setCarrier(board, true);
      expect(isCarrier(board)).toBe(true);
      setCarrier(board, true);
      expect(carrierEvents(board)).toEqual([false, true]);

      // mod 仍为低时，宿主撤销请求才真正撤销载波。
      setCarrier(board, false);
      expect(isCarrier(board)).toBe(false);

      // mod 为高时，宿主请求不能把载波关掉；撤销宿主请求后仍由 mod 保持。
      setSource(board, 'modDrv', true);
      setCarrier(board, true);
      setCarrier(board, false);
      expect(isCarrier(board)).toBe(true);
      setSource(board, 'modDrv', false);
      expect(isCarrier(board)).toBe(false);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('VCC 掉电时载波强制为假，恢复供电后按当前调制恢复', async () => {
    const board = await fixture();

    try {
      setSource(board, 'vccDrv', true);
      setSource(board, 'modDrv', true);
      expect(isCarrier(board)).toBe(true);

      setSource(board, 'vccDrv', false);
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'vccDrv', true);
      expect(isCarrier(board)).toBe(true);
      expect(carrierEvents(board)).toEqual([false, true, false, true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('宿主请求保留跨掉电状态，恢复供电后重新生效', async () => {
    const board = await fixture();

    try {
      setSource(board, 'vccDrv', true);
      setCarrier(board, true);
      expect(isCarrier(board)).toBe(true);

      setSource(board, 'vccDrv', false);
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'vccDrv', true);
      expect(isCarrier(board)).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
