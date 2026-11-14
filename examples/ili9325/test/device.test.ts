import { afterEach, describe, expect, it } from 'vitest';
import {
  GRAM_HEIGHT,
  GRAM_WIDTH,
  PANEL_HEIGHT,
  PANEL_WIDTH,
  circuit,
  compose,
  pixel,
} from './harness';

/**
 * 器件级用例：总线时序、寄存器、地址推进、面板映射与合帧发布。
 *
 * 每个用例都通过真实的 DDL 总线主设备驱动 ILI9325，断言端口载荷而不是内部状态，
 * 因此同时覆盖了电气求解、同步反应与通道投递。
 */

const boards: Awaited<ReturnType<typeof circuit>>[] = [];

async function board(options: Parameters<typeof circuit>[0] = {}) {
  const value = await circuit(options);

  boards.push(value);

  return value;
}

afterEach(() => {
  for (const value of boards.splice(0)) value.dispose();
});

/** 设置 GRAM 地址计数器（R20h / R21h）。 */
function setCursor(value: Awaited<ReturnType<typeof circuit>>, x: number, y: number): void {
  value.command(0x20);
  value.data(x);
  value.command(0x21);
  value.data(y);
}

/** 设置窗口（R50h–R53h）。 */
function setWindow(
  value: Awaited<ReturnType<typeof circuit>>,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  value.command(0x50);
  value.data(x0);
  value.command(0x51);
  value.data(x1);
  value.command(0x52);
  value.data(y0);
  value.command(0x53);
  value.data(y1);
}

/**
 * 参考 BSP（`HAL_06_LCD/Src/lcd.c` 的 `REG_932X_Init`）的关键寄存器序列：
 * R03h 先 0x1030 再 0x1018、R20h/R21h 清零、R50h–R53h 全屏、R07h 开显示。
 * 省略了电源与 gamma 等对显示内容没有影响的写入。
 */
function initBsp(value: Awaited<ReturnType<typeof circuit>>): void {
  value.command(0x03);
  value.data(0x1030);
  value.command(0x20);
  value.data(0);
  value.command(0x21);
  value.data(0);
  setWindow(value, 0, GRAM_WIDTH - 1, 0, GRAM_HEIGHT - 1);
  value.command(0x03);
  value.data(0x1018);
  value.command(0x07);
  value.data(0x0173);
}

describe('ILI9325', () => {
  it('复位后读回器件码 0x9325 与地址计数器', async () => {
    const value = await board();

    value.read();
    value.drain();
    expect(value.reads).toEqual([0x9325]);

    setCursor(value, 5, 7);
    value.command(0x20);
    value.read();
    value.command(0x21);
    value.read();
    value.drain();
    expect(value.reads.slice(1)).toEqual([5, 7]);
    expect(value.faults).toEqual([]);
  });

  it('默认入口模式按 X 递增填满面板，整屏一帧一条像素体', async () => {
    const value = await board();

    value.command(0x22);
    value.data(0xf800, PANEL_WIDTH * PANEL_HEIGHT);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.faults).toEqual([]);
    expect(value.frames).toHaveLength(1);
    expect(value.stats.infos).toBe(1);
    // 整行覆盖 → 一次 copyBytes，不按行拆分。
    expect(value.stats.rows).toBe(1);

    const frame = value.frames[0]!;

    expect(frame).toMatchObject({
      x: 0,
      y: 0,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });
    expect(frame.pixels).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
    expect(frame.pixels.every((entry) => entry === 0xf800)).toBe(true);
  });

  it('GRAM 坐标映射到面板：X 是行，Y 从右向左', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0x1234);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    // 单像素矩形在内存中连续，仍是一条像素体。
    expect(value.frames).toHaveLength(1);
    expect(value.frames[0]).toMatchObject({ x: 319, y: 0, width: 1, height: 1 });

    const first = compose(value.frames, 0xffff);

    expect(pixel(first, 319, 0)).toBe(0x1234);

    setCursor(value, 5, 319);
    value.command(0x22);
    value.data(0x5678);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(2);
    expect(value.frames[1]).toMatchObject({ x: 0, y: 5, width: 1, height: 1 });

    const second = compose(value.frames, 0xffff);

    expect(pixel(second, 0, 5)).toBe(0x5678);
    expect(pixel(second, 319, 0)).toBe(0x1234);
  });

  it('窗口内按 X 递增并在边界回卷到下一行', async () => {
    const value = await board({ refreshRate: 240 });

    setWindow(value, 10, 19, 20, 29);
    setCursor(value, 10, 20);
    value.command(0x22);
    value.data(0x0101, 100);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.frames).toHaveLength(1);

    const frame = value.frames[0]!;

    // 面板列 = 319 - GRAM Y：Y 20..29 → 面板 x 290..299；面板行 = GRAM X 10..19。
    expect(frame).toMatchObject({ x: 290, y: 10, width: 10, height: 10 });

    const panel = compose(value.frames, 0xffff);

    for (let row = 10; row < 20; row += 1)
      for (let column = 290; column < 300; column += 1)
        expect(pixel(panel, column, row)).toBe(0x0101);
    expect(pixel(panel, 289, 10)).toBe(0xffff);
    expect(pixel(panel, 300, 10)).toBe(0xffff);
  });

  it('I-D0 递减时在窗口左边界回卷并推进下一行', async () => {
    const value = await board({ refreshRate: 240 });

    // R03h = 0x0020：AM=0（水平快轴）、I-D0=0（X 递减）、I-D1=1（Y 递增）。
    value.command(0x03);
    value.data(0x0020);
    setWindow(value, 10, 19, 20, 29);
    setCursor(value, 11, 20);
    value.command(0x22);
    value.data(0x1111);
    value.data(0x2222);
    value.data(0x3333);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    const panel = compose(value.frames, 0xffff);

    expect(pixel(panel, 319 - 20, 11)).toBe(0x1111);
    expect(pixel(panel, 319 - 20, 10)).toBe(0x2222);
    // 从窗口左边界 10 再减一 → 回卷到 19，Y 推进到 21。
    expect(pixel(panel, 319 - 21, 19)).toBe(0x3333);
  });

  it('AM=1 时以 Y 为快轴', async () => {
    const value = await board({ refreshRate: 240 });

    // R03h = 0x0038：AM=1（垂直快轴）、I-D0=1、I-D1=1。
    value.command(0x03);
    value.data(0x0038);
    setWindow(value, 10, 19, 20, 29);
    setCursor(value, 10, 20);
    value.command(0x22);
    value.data(0x00aa, 11);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.frames).toHaveLength(1);
    expect(value.frames[0]).toMatchObject({ x: 290, y: 10, width: 10, height: 2 });

    const panel = compose(value.frames, 0xffff);

    // 前 10 个像素覆盖 GRAM (10, 20..29) → 面板 x = 299..290、y = 10。
    for (let column = 290; column < 300; column += 1) expect(pixel(panel, column, 10)).toBe(0x00aa);
    // 第 11 个像素回卷到 Y=20，X 推进到 11 → 面板 (299, 11)。
    expect(pixel(panel, 299, 11)).toBe(0x00aa);
    // 窗口之外没有写入。
    expect(pixel(panel, 289, 10)).toBe(0xffff);
    expect(pixel(panel, 299, 9)).toBe(0xffff);
  });

  it.each([0x00, 0x10, 0x20, 0x30, 0x08, 0x18, 0x28, 0x38])(
    '入口模式 %#：全部快轴/方向在小窗口多次回卷，读写地址一致',
    async (mode) => {
      const value = await board({ refreshRate: 240 });
      const xs = (mode & 16) !== 0 ? [10, 11] : [11, 10];
      const ys = (mode & 32) !== 0 ? [20, 21, 22] : [22, 21, 20];
      const positions: [number, number][] = [];

      if ((mode & 8) === 0) {
        for (const y of ys) for (const x of xs) positions.push([x, y]);
      } else {
        for (const x of xs) for (const y of ys) positions.push([x, y]);
      }
      value.command(0x03);
      value.data(mode);
      setWindow(value, 10, 11, 20, 22);
      setCursor(value, xs[0]!, ys[0]!);
      value.command(0x22);
      const writes = positions.length * 2 + 3;
      const expected = new Map<string, number>();

      for (let index = 0; index < writes; index += 1) {
        value.data(0x1200 + index);
        expected.set(positions[index % positions.length]!.join(','), 0x1200 + index);
      }
      value.command(0x20);
      value.read();
      value.command(0x21);
      value.read();
      // 从写入终点再读两整圈，验证保留的读地址推进与写快路径完全一致。
      value.command(0x22);
      for (let index = 0; index < positions.length * 2; index += 1) value.read();
      value.drain();
      expect(value.reads.slice(0, 2)).toEqual(positions[writes % positions.length]);
      expect(value.reads.slice(2)).toEqual(
        Array.from({ length: positions.length * 2 }, (_, index) =>
          expected.get(positions[(writes + index) % positions.length]!.join(',')),
        ),
      );
      value.run(value.framePeriod + 1_000_000);
      const panel = compose(value.frames, 0xffff);

      for (const [x, y] of positions)
        expect(pixel(panel, 319 - y, x)).toBe(expected.get(`${x},${y}`));
      expect(pixel(panel, 319 - 19, 10)).toBe(0xffff);
      expect(value.faults).toEqual([]);
    },
  );

  it('屏外及窗口外写跳过像素后仍按入口模式回卷', async () => {
    const value = await board({ refreshRate: 240 });

    setWindow(value, 10, 11, 20, 22);
    setCursor(value, 255, 511);
    value.command(0x22);
    value.data(0xdead); // 屏外；X 回卷到 10，Y 回卷到 20。
    value.data(0x1234);
    setCursor(value, 9, 19);
    value.command(0x22);
    value.data(0xbeef); // X 进入窗口、Y 仍在窗口外：不写像素，继续推进。
    value.data(0xabcd);
    value.data(0xcafe); // 快轴回卷后进入 (10, 20)。
    value.data(0x5678);
    value.command(0x20);
    value.read();
    value.command(0x21);
    value.read();
    value.drain();
    expect(value.reads).toEqual([11, 20]);
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(1);
    expect(value.frames[0]).toMatchObject({ x: 299, y: 10, width: 1, height: 1 });
    expect(value.frames[0]!.pixels).toEqual(new Uint16Array([0x5678]));
    expect(value.faults).toEqual([]);
  });

  it('读 R22h 返回 GRAM 像素并推进地址', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0xbeef);
    value.data(0x1234);
    value.drain();

    setCursor(value, 0, 0);
    value.command(0x22);
    value.read();
    value.read();
    value.command(0x20);
    value.read();
    value.drain();

    expect(value.reads).toEqual([0xbeef, 0x1234, 2]);
    expect(value.faults).toEqual([]);
  });

  it('CS 无效时写周期被忽略', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0x0001);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(1);

    setCursor(value, 1, 0);
    value.command(0x22);
    value.data(0x0002);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(2);

    // 用不选中的访问再写一次：命令与数据都不应生效。
    value.command(0x22, { selected: false });
    value.data(0x0003, 1, { selected: false });
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(2);

    const panel = compose(value.frames, 0);

    expect(pixel(panel, 319, 0)).toBe(0x0001);
    expect(pixel(panel, 319, 1)).toBe(0x0002);
  });

  it('RST 脉冲清空 GRAM 并发布整屏黑帧', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0x4321);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(1);

    value.pulseReset();
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(2);
    expect(value.frames[1]).toMatchObject({
      x: 0,
      y: 0,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });
    expect(value.frames[1]!.pixels.every((entry) => entry === 0)).toBe(true);

    // 复位后地址回到 (0, 0)，器件码仍可读。
    value.command(0x20);
    value.read();
    value.command(0x00);
    value.read();
    value.drain();
    expect(value.reads.slice(-2)).toEqual([0, 0x9325]);
  });

  it('一个帧周期内的多次写入合并成一帧并覆盖包围盒', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0x1111);
    setCursor(value, GRAM_WIDTH - 1, GRAM_HEIGHT - 1);
    value.command(0x22);
    value.data(0x2222);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.frames).toHaveLength(1);
    expect(value.stats.infos).toBe(1);
    expect(value.stats.rows).toBe(1);
    expect(value.frames[0]).toMatchObject({
      x: 0,
      y: 0,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });

    const panel = compose(value.frames, 0xffff);

    expect(pixel(panel, 319, 0)).toBe(0x1111);
    expect(pixel(panel, 0, GRAM_WIDTH - 1)).toBe(0x2222);
  });

  it('跨帧周期的两批写入发布两帧', async () => {
    const value = await board({ refreshRate: 240 });

    setCursor(value, 0, 0);
    value.command(0x22);
    value.data(0x1111);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(1);

    setCursor(value, 1, 0);
    value.command(0x22);
    value.data(0x2222);
    value.drain();
    value.run(value.framePeriod + 1_000_000);
    expect(value.frames).toHaveLength(2);
    expect(value.stats.infos).toBe(2);
    expect(value.frames[1]).toMatchObject({ x: 319, y: 1, width: 1, height: 1 });
  });

  it('读周期在 RD 与 CS 同时有效时驱动数据总线', async () => {
    const value = await board({ refreshRate: 240 });

    // CS 高时读：控制器不驱动，主设备采到浮空（按 0 解释）。
    value.read({ selected: false });
    value.drain();
    expect(value.reads).toEqual([0]);

    value.read();
    value.drain();
    expect(value.reads).toEqual([0, 0x9325]);
    expect(value.faults).toEqual([]);
  });

  it('参考 BSP 初始化后 LCD_Clear(Blue) 得到整屏 0x001F', async () => {
    // 76,800 次写约 7.7 ms；用 60 Hz（16.7 ms）保证整屏落在同一帧周期内。
    const value = await board({ refreshRate: 60 });

    initBsp(value);
    value.command(0x22);
    value.data(0x001f, PANEL_WIDTH * PANEL_HEIGHT);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.faults).toEqual([]);
    expect(value.frames).toHaveLength(1);
    // 整屏覆盖 → 一次 copyBytes。
    expect(value.stats).toEqual({ infos: 1, rows: 1 });
    expect(value.frames[0]).toMatchObject({
      x: 0,
      y: 0,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });
    expect(value.frames[0]!.pixels.every((entry) => entry === 0x001f)).toBe(true);
  });

  it('参考 BSP 的字符绘制落在面板左上角', async () => {
    const value = await board({ refreshRate: 240 });

    initBsp(value);
    // LCD_DisplayStringLine(Line4, ...) → 行 96；首字符 refcolumn=319；
    // LCD_DrawChar 每行 16 像素、24 行，行间显式重设光标。
    for (let row = 0; row < 24; row += 1) {
      setCursor(value, 96 + row, 319);
      value.command(0x22);
      value.data(0xffff, 16);
    }
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.faults).toEqual([]);
    // 24 行 × 16 像素跨 16 个面板列与 24 个面板行，按行复制。
    expect(value.stats).toEqual({ infos: 1, rows: 24 });
    expect(value.frames[0]).toMatchObject({
      x: 0,
      y: 96,
      width: 16,
      height: 24,
    });

    const panel = compose(value.frames, 0x001f);

    expect(pixel(panel, 0, 96)).toBe(0xffff);
    expect(pixel(panel, 15, 119)).toBe(0xffff);
    expect(pixel(panel, 16, 96)).toBe(0x001f);
    expect(pixel(panel, 0, 120)).toBe(0x001f);
  });

  it('R20h 按 8 位、R21h 按 9 位保存地址', async () => {
    const value = await board({ refreshRate: 240 });

    // 参考的 LCD_DrawRect 会把行地址推到 269；真实 R20h 只有 8 位。
    value.command(0x20);
    value.data(269);
    value.command(0x20);
    value.read();
    // 576 = 0x240，R21h 9 位截断后为 64。
    value.command(0x21);
    value.data(576);
    value.command(0x21);
    value.read();
    value.drain();

    expect(value.reads).toEqual([13, 64]);
    expect(value.faults).toEqual([]);
  });

  it('窗口允许单像素边界（start == end）', async () => {
    const value = await board({ refreshRate: 240 });

    setWindow(value, 5, 5, 7, 7);
    setCursor(value, 5, 7);
    value.command(0x22);
    value.data(0x2468);
    value.drain();
    value.run(value.framePeriod + 1_000_000);

    expect(value.frames).toHaveLength(1);
    expect(value.frames[0]).toMatchObject({ x: 312, y: 5, width: 1, height: 1 });
  });
});
