import { describe, expect, it } from 'vitest';
import { createLink, decodeDemoFrame, driveFrame, encodeDemoFrame } from './link-fixture.ts';

/**
 * 完整链路：发射端 mod 引脚 → carrier 输出通道/事件 → 测试夹具桥 → 现有接收头
 * setCarrier → 接收头 receiving → 夹具按接收端低脉冲宽度恢复字节。
 *
 * 这里使用的是测试文件定义的示例脉宽帧，不表示 ir-emitter 实现了某种红外协议。
 */

describe.each(['vs1838', 'cx20106a'] as const)('红外数据链路经 %s 恢复数据', (receiver) => {
  it('发送多字节数据后接收端恢复相同内容', async () => {
    const link = await createLink(receiver);

    try {
      const bytes = Uint8Array.from([0x00, 0xa5, 0xff, 0x3c]);
      const samples = driveFrame(link, encodeDemoFrame(bytes));

      expect(Array.from(decodeDemoFrame(samples))).toEqual(Array.from(bytes));
      expect(link.board.faults).toEqual([]);

      const carrierEvents = link.board.events
        .filter((event) => event.name === 'onDidCarrier')
        .map((event) => event.value);
      expect(carrierEvents.length).toBeGreaterThan(0);
      expect(carrierEvents[0]).toBe(false);
    } finally {
      link.board.dispose();
    }
  });

  it('前导/结尾长脉冲和 0/1 脉宽都能从接收端区分', async () => {
    const link = await createLink(receiver);

    try {
      // 0x80 是只有最高位为 1 的单字节，便于确认位序与 0/1 阈值。
      const bytes = Uint8Array.from([0x80, 0x7f]);
      const samples = driveFrame(link, encodeDemoFrame(bytes));

      expect(Array.from(decodeDemoFrame(samples))).toEqual(Array.from(bytes));
      expect(link.board.faults).toEqual([]);

      // 帧结束后接收头已释放，外部上拉把 OUT 拉高。
      expect(link.board.probe('rxProbe')).toBe(1);
    } finally {
      link.board.dispose();
    }
  });
});
