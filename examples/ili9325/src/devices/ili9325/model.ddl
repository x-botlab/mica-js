/**
 * ILI9325 TFT 控制器（240×320 GRAM，面板横向安装 320×240）。
 *
 * 总线按 CT117E-M4 的接法建模：16 位数据总线 + 低有效 CS/WR/RD、RS 选择命令/数据、
 * 低有效 RST。控制器只观察引脚电平，不依赖任何 MCU。
 *
 * ## 高性能路径
 *
 * 1. **观察源极少**：变化源只有三处——`WR.sample.level`、`readActive`（RD 与 CS
 *    同时有效，一个两输入 derived）与 `RST.sample.level`。数据总线与 RS 不建立观察，
 *    只在 WR 上升沿真正锁存时读取一次当前采样。与「23 根脚各建一个观察」相比，每个
 *    发布边界的比较量从 23 项降到 3 项。
 * 2. **热路径只有 state 与 16 位存储**：地址计数器、窗口、入口模式都用 state；一个
 *    像素是一次 `store16le` + 4 次边界比较 + 地址推进，没有逐像素的消息分配。
 * 3. **合帧发布**：写入只维护脏矩形，发布由 `publishFrames` 按 `refreshRate` 合并。
 *    `frameSeq` 只在「上一帧已发布」后递增，过程自身不写这个源，因此不会自我重触发；
 *    一次连续绘图无论多少像素都只发布一帧。
 * 4. **整段复制**：脏矩形覆盖整行（`width == 320`）或只有一行时，用一次 `copyBytes`
 *    取整个矩形；其余情况按行复制，避免跨 stride 的整块拷贝。
 *
 * ## 理想化
 *
 * - 寄存器写入忽略建立/保持时间；WR 在 CS 有效时的上升沿锁存数据。
 * - 读周期不做 ILI9325 的第一次哑读，直接返回当前值；读 R22h 后地址计数器推进。
 * - R00h 读回 0x9325；未建模寄存器按写入值读回。
 * - 复位释放时清空 GRAM；RST 保持有效期间忽略总线访问。
 * - 输出的 RGB565 是 GRAM 原始值：R03h 的 BGR 位只在面板级交换 R/B，不改变端口载荷
 *   （CT117E 官方 BSP 以 BGR=1 写入 0xF800 显示红色，与原始值一致）。
 */
device Ili9325(refreshRate: number default 60) {
  assert isFinite(refreshRate) && refreshRate >= 1 && refreshRate <= 240,
    "refreshRate must be a finite value within 1..240";

  /** 面板（横向安装）与 GRAM（控制器原生方向）的尺寸。 */
  const PANEL_WIDTH = 320;
  const PANEL_HEIGHT = 240;
  const GRAM_WIDTH = 240;
  const GRAM_HEIGHT = 320;
  /** 单个帧消息的最大像素体：整屏。 */
  const MAX_BODY_BYTES = PANEL_WIDTH * PANEL_HEIGHT * 2;
  const FRAME_PERIOD_PS = round(1_000_000_000_000 / refreshRate);

  record FrameRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** 16 位数据总线；写周期由总线主设备驱动，读周期由控制器驱动。 */
  pin D0(low: 0.8, high: 2.0);
  pin D1(low: 0.8, high: 2.0);
  pin D2(low: 0.8, high: 2.0);
  pin D3(low: 0.8, high: 2.0);
  pin D4(low: 0.8, high: 2.0);
  pin D5(low: 0.8, high: 2.0);
  pin D6(low: 0.8, high: 2.0);
  pin D7(low: 0.8, high: 2.0);
  pin D8(low: 0.8, high: 2.0);
  pin D9(low: 0.8, high: 2.0);
  pin D10(low: 0.8, high: 2.0);
  pin D11(low: 0.8, high: 2.0);
  pin D12(low: 0.8, high: 2.0);
  pin D13(low: 0.8, high: 2.0);
  pin D14(low: 0.8, high: 2.0);
  pin D15(low: 0.8, high: 2.0);
  /** 写选通，低有效：CS 有效时的上升沿锁存数据。 */
  pin WR(low: 0.8, high: 2.0);
  /** 读选通，低有效：与 CS 同时有效时控制器驱动数据总线。 */
  pin RD(low: 0.8, high: 2.0);
  /** 寄存器选择：低为命令，高为数据。 */
  pin RS(low: 0.8, high: 2.0);
  /** 片选，低有效。 */
  pin CS(low: 0.8, high: 2.0);
  /** 复位，低有效。 */
  pin RST(low: 0.8, high: 2.0);
  /** 供电与地：数据总线读驱动的参考。 */
  pin VDD;
  pin VSS;

  /** 面板像素的 RGB565 小端字节；下标 = (py * 320 + px) * 2。 */
  memory gram[PANEL_WIDTH * PANEL_HEIGHT * 2];
  /** 寄存器后备值；下标 = index * 2。 */
  memory regs[512];

  /** 当前命令索引。 */
  state index: number = 0;
  /** R03h：AM / I-D[1:0] 与 BGR。 */
  state entryMode: number = 0x1030;
  /** GRAM 地址计数器。 */
  state addrX: number = 0;
  state addrY: number = 0;
  /** R50h–R53h 窗口。 */
  state windowX0: number = 0;
  state windowX1: number = GRAM_WIDTH - 1;
  state windowY0: number = 0;
  state windowY1: number = GRAM_HEIGHT - 1;

  /** 脏矩形（面板坐标）。 */
  state dirty: bool = false;
  state dirtyX0: number = 0;
  state dirtyX1: number = 0;
  state dirtyY0: number = 0;
  state dirtyY1: number = 0;
  /** 已有一帧在等待发布；避免每个像素都推进 `frameSeq`。 */
  state scheduled: bool = false;
  /** 帧触发计数；只有写入方递增，`publishFrames` 从不写它。 */
  state frameSeq: number = 0;

  output channel frameInfo: FrameRect(capacity: 4096, overflow: Overflow.error);
  output channel frameRows: bytes(maxLength: MAX_BODY_BYTES, capacity: 4096,
                                  overflow: Overflow.error);

  /** 读选通与片选同时有效且不在复位：控制器需要驱动数据总线。 */
  derived readActive: bool =
    RD.sample.level == Logic.low && CS.sample.level == Logic.low &&
    RST.sample.level != Logic.low;

  /** 当前 16 位数据总线电平；只在锁存或读驱动时求值，比较全部内联。 */
  fn dataBus() -> number {
    return (D0.sample.level == Logic.high ? 1 : 0) +
      2 * (D1.sample.level == Logic.high ? 1 : 0) +
      4 * (D2.sample.level == Logic.high ? 1 : 0) +
      8 * (D3.sample.level == Logic.high ? 1 : 0) +
      16 * (D4.sample.level == Logic.high ? 1 : 0) +
      32 * (D5.sample.level == Logic.high ? 1 : 0) +
      64 * (D6.sample.level == Logic.high ? 1 : 0) +
      128 * (D7.sample.level == Logic.high ? 1 : 0) +
      256 * (D8.sample.level == Logic.high ? 1 : 0) +
      512 * (D9.sample.level == Logic.high ? 1 : 0) +
      1024 * (D10.sample.level == Logic.high ? 1 : 0) +
      2048 * (D11.sample.level == Logic.high ? 1 : 0) +
      4096 * (D12.sample.level == Logic.high ? 1 : 0) +
      8192 * (D13.sample.level == Logic.high ? 1 : 0) +
      16384 * (D14.sample.level == Logic.high ? 1 : 0) +
      32768 * (D15.sample.level == Logic.high ? 1 : 0);
  }

  /**
   * 按 R03h 的 AM / I-D[1:0] 推进地址计数器：快轴到边界后回卷并推进慢轴。
   * 回卷判断内联，热路径（未回卷）只有一次加法与一次比较，不调用辅助函数。
   */
  fn advanceAddress() {
    const xUp = (entryMode & 16) != 0;
    const yUp = (entryMode & 32) != 0;

    if (entryMode & 8) == 0 {
      addrX = addrX + (xUp ? 1 : -1);
      if addrX > windowX1 {
        addrX = windowX0;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 {
          addrY = windowY0;
        } else if addrY < windowY0 {
          addrY = windowY1;
        }
      } else if addrX < windowX0 {
        addrX = windowX1;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 {
          addrY = windowY0;
        } else if addrY < windowY0 {
          addrY = windowY1;
        }
      }
    } else {
      addrY = addrY + (yUp ? 1 : -1);
      if addrY > windowY1 {
        addrY = windowY0;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 {
          addrX = windowX0;
        } else if addrX < windowX0 {
          addrX = windowX1;
        }
      } else if addrY < windowY0 {
        addrY = windowY1;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 {
          addrX = windowX0;
        } else if addrX < windowX0 {
          addrX = windowX1;
        }
      }
    }
  }

  /** 扩大脏矩形；第一笔写入同时排队一次发布。顺序填充只写变化的那一侧。 */
  fn markDirty(panelColumn: number, panelRow: number) {
    if dirty {
      if panelColumn < dirtyX0 {
        dirtyX0 = panelColumn;
      } else if panelColumn > dirtyX1 {
        dirtyX1 = panelColumn;
      }
      if panelRow < dirtyY0 {
        dirtyY0 = panelRow;
      } else if panelRow > dirtyY1 {
        dirtyY1 = panelRow;
      }
    } else {
      dirty = true;
      dirtyX0 = panelColumn;
      dirtyX1 = panelColumn;
      dirtyY0 = panelRow;
      dirtyY1 = panelRow;
    }
    if !scheduled {
      scheduled = true;
      frameSeq = frameSeq + 1;
    }
  }

  /**
   * 写一个 GRAM 像素。地址计数器保持寄存器原值（R20h 8 位、R21h 9 位），只有
   * 落在窗口内且落在 GRAM 内才真正存储：参考程序的 `LCD_DrawRect` 会把行地址推到
   * 269，真实芯片按 8 位截断后落在屏外或别的行，这里不做 clamp，避免把越界地址
   * 折叠到 239 造出一个参考画面没有的像素。
   */
  fn writePixel(value: number) {
    if addrX >= windowX0 && addrX <= windowX1 &&
        addrY >= windowY0 && addrY <= windowY1 &&
        addrX < GRAM_WIDTH && addrY < GRAM_HEIGHT {
      // 面板坐标：列 = 319 - GRAM Y，行 = GRAM X。偏移内联，避免每像素三次纯函数调用。
      store16le(gram, (addrX * PANEL_WIDTH + (PANEL_WIDTH - 1) - addrY) * 2, value);
      markDirty((PANEL_WIDTH - 1) - addrY, addrX);
    }
    advanceAddress();
  }

  fn writeCommand(value: number) {
    index = value & 0xff;
  }

  fn writeData(value: number) {
    if index == 0x22 {
      writePixel(value);
      return;
    }

    store16le(regs, index * 2, value);

    if index == 0x20 {
      // R20h 只有 8 位；参考程序把行地址写到 269，真实芯片按 8 位截断。
      addrX = value & 0xff;
      store16le(regs, index * 2, addrX);
    } else if index == 0x21 {
      // R21h 只有 9 位。
      addrY = value & 0x1ff;
      store16le(regs, index * 2, addrY);
    } else if index == 0x03 {
      entryMode = value;
    } else if index == 0x50 {
      // 窗口允许单像素（start == end）；参考的 SetDisplayWindow 先写 start 再写 end。
      const next = value & 0xff;

      if next <= windowX1 {
        windowX0 = next;
      }
      store16le(regs, index * 2, windowX0);
    } else if index == 0x51 {
      const next = value & 0xff;

      if next >= windowX0 && next < GRAM_WIDTH {
        windowX1 = next;
      }
      store16le(regs, index * 2, windowX1);
    } else if index == 0x52 {
      const next = value & 0x1ff;

      if next <= windowY1 {
        windowY0 = next;
      }
      store16le(regs, index * 2, windowY0);
    } else if index == 0x53 {
      const next = value & 0x1ff;

      if next >= windowY0 && next < GRAM_HEIGHT {
        windowY1 = next;
      }
      store16le(regs, index * 2, windowY1);
    }
  }

  /** 读周期返回的值；RS=低时索引寄存器不可读，返回 0。读 R22h 后地址推进。 */
  fn readValue() -> number {
    if RS.sample.level != Logic.high {
      return 0;
    }
    if index == 0x00 {
      return 0x9325;
    }
    if index == 0x20 {
      return addrX;
    }
    if index == 0x21 {
      return addrY;
    }
    if index == 0x22 {
      const value = load16le(gram,
        (addrX * PANEL_WIDTH + (PANEL_WIDTH - 1) - addrY) * 2);

      advanceAddress();
      return value;
    }
    return load16le(regs, index * 2);
  }

  /** 读周期的一根数据脚：1 拉到 VDD，0 拉到 VSS。 */
  fn driveBit(target: pin, value: number) {
    if value == 1 {
      target.intent <- [resistor(to: VDD, resistance: 25)];
    } else {
      target.intent <- [resistor(to: VSS, resistance: 25)];
    }
  }

  fn driveData(value: number) {
    driveBit(D0, value & 1);
    driveBit(D1, (value >> 1) & 1);
    driveBit(D2, (value >> 2) & 1);
    driveBit(D3, (value >> 3) & 1);
    driveBit(D4, (value >> 4) & 1);
    driveBit(D5, (value >> 5) & 1);
    driveBit(D6, (value >> 6) & 1);
    driveBit(D7, (value >> 7) & 1);
    driveBit(D8, (value >> 8) & 1);
    driveBit(D9, (value >> 9) & 1);
    driveBit(D10, (value >> 10) & 1);
    driveBit(D11, (value >> 11) & 1);
    driveBit(D12, (value >> 12) & 1);
    driveBit(D13, (value >> 13) & 1);
    driveBit(D14, (value >> 14) & 1);
    driveBit(D15, (value >> 15) & 1);
  }

  fn releaseData() {
    D0.intent <- [];
    D1.intent <- [];
    D2.intent <- [];
    D3.intent <- [];
    D4.intent <- [];
    D5.intent <- [];
    D6.intent <- [];
    D7.intent <- [];
    D8.intent <- [];
    D9.intent <- [];
    D10.intent <- [];
    D11.intent <- [];
    D12.intent <- [];
    D13.intent <- [];
    D14.intent <- [];
    D15.intent <- [];
  }

  fn clearGram() {
    let offset = 0;

    while offset < PANEL_WIDTH * PANEL_HEIGHT * 2 {
      store16le(gram, offset, 0);
      offset = offset + 2;
    }
  }

  /** 寄存器复位；`clearPixels` 只在 RST 释放时重清 GRAM。 */
  fn reset(clearPixels: bool) {
    index = 0;
    entryMode = 0x1030;
    addrX = 0;
    addrY = 0;
    windowX0 = 0;
    windowX1 = GRAM_WIDTH - 1;
    windowY0 = 0;
    windowY1 = GRAM_HEIGHT - 1;

    let reg = 0;

    while reg < 512 {
      store8(regs, reg, 0);
      reg = reg + 1;
    }
    store16le(regs, 0x03 * 2, entryMode);
    store16le(regs, 0x20 * 2, addrX);
    store16le(regs, 0x21 * 2, addrY);
    store16le(regs, 0x50 * 2, windowX0);
    store16le(regs, 0x51 * 2, windowX1);
    store16le(regs, 0x52 * 2, windowY0);
    store16le(regs, 0x53 * 2, windowY1);
    releaseData();

    if clearPixels {
      clearGram();
      // 复位后的整屏 GRAM 为 0（黑），也要送到端口，而不是悄悄丢弃这一帧。
      dirty = true;
      dirtyX0 = 0;
      dirtyX1 = PANEL_WIDTH - 1;
      dirtyY0 = 0;
      dirtyY1 = PANEL_HEIGHT - 1;
      if !scheduled {
        scheduled = true;
        frameSeq = frameSeq + 1;
      }
    }
  }

  process start {
    reset(false);
  }

  /**
   * 写周期锁存：CS 有效时 WR 的上升沿取一次数据总线与 RS。
   * 数据脚与 RS 不参与观察，只在真正锁存时读采样。
   */
  reaction writeLatch on WR.sample.level as (previous, next) {
    if previous == Logic.low && next == Logic.high &&
        CS.sample.level == Logic.low && RST.sample.level != Logic.low {
      if RS.sample.level == Logic.low {
        writeCommand(dataBus());
      } else {
        writeData(dataBus());
      }
    }
  }

  /** 读窗口开合：开时驱动数据总线，关时释放。 */
  reaction readWindow on readActive as (previous, next) {
    if next && !previous {
      driveData(readValue());
    } else if previous && !next {
      releaseData();
    }
  }

  /** RST 释放沿完成复位；保持有效期间不响应总线。 */
  reaction resetRelease on RST.sample.level as (previous, next) {
    if previous == Logic.low && next != Logic.low {
      reset(true);
    }
  }

  /**
   * 合帧发布。触发源 `frameSeq` 只由写入方递增，本过程从不写它，因此一次连续
   * 绘图只在下一帧周期发布一次，也不会因自身收尾再排队一次。
   */
  process publishFrames on frameSeq {
    if dirty {
      await ticks(FRAME_PERIOD_PS);
      const x = dirtyX0;
      const y = dirtyY0;
      const width = dirtyX1 - dirtyX0 + 1;
      const height = dirtyY1 - dirtyY0 + 1;
      const info: FrameRect = { x: x, y: y, width: width, height: height };

      frameInfo.send(info);
      if width == PANEL_WIDTH || height == 1 {
        frameRows.send(copyBytes(gram, (y * PANEL_WIDTH + x) * 2,
          width * height * 2));
      } else {
        let row = 0;

        while row < height {
          frameRows.send(copyBytes(gram, ((y + row) * PANEL_WIDTH + x) * 2,
            width * 2));
          row = row + 1;
        }
      }
      dirty = false;
    }
    scheduled = false;
  }
}
