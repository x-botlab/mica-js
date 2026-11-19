/**
 * CT117E-M4 §2 的 bit-bang I²C 固件夹具。
 *
 * 生成真实的 Thumb-1 机器码，经 `dist/model.js` 的 MCU JIT 执行：GPIOB PB6=SCL、
 * PB7=SDA 配成开漏输出，只用 BSRR 逐位拉低/释放；每次写或读都把结果字写入
 * `RESULT_BASE` 起的 SRAM，测试再从 `sram` 内存读取。夹具不直接调用模型方法，
 * 也不绕过 GPIO/融合层。
 *
 * 本文件与共享 harness 无关，避免并行改动 `test/harness.ts`。
 */

/** 结果字在 SRAM 内的起始偏移；与 `Thumb.build` 的栈顶 0x20005000 不重叠。 */
export const I2C_RESULT_BASE = 0x2000_0100;

const GPIOB = 0x4800_0400;
const RCC_AHB2ENR = 0x4002_104c;

class Thumb {
  readonly #halves: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #patches: { readonly at: number; readonly label: string; readonly condition: number }[] =
    [];

  #half(value: number): this {
    this.#halves.push(value & 0xffff);
    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
  }

  label(name: string): this {
    this.#labels.set(name, this.#halves.length * 2);
    return this;
  }

  movw(rd: number, immediate: number): this {
    const value = immediate & 0xffff;
    return this.#dword(
      0xf240 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movt(rd: number, immediate: number): this {
    const value = immediate & 0xffff;
    return this.#dword(
      0xf2c0 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movs(rd: number, immediate: number): this {
    if (!Number.isInteger(immediate) || immediate < 0 || immediate > 0xff)
      throw new RangeError(`movs immediate out of range: ${immediate}`);
    return this.#half(0x2000 | (rd << 8) | immediate);
  }

  subs(rd: number, immediate: number): this {
    if (!Number.isInteger(immediate) || immediate < 0 || immediate > 0xff)
      throw new RangeError(`subs immediate out of range: ${immediate}`);
    return this.#half(0x3800 | (rd << 8) | immediate);
  }

  lsls(rd: number, rs: number, amount: number): this {
    return this.#half(((amount & 0x1f) << 6) | ((rs & 7) << 3) | (rd & 7));
  }

  lsrs(rd: number, rs: number, amount: number): this {
    return this.#half(0x0800 | ((amount & 0x1f) << 6) | ((rs & 7) << 3) | (rd & 7));
  }

  orrs(rd: number, rm: number): this {
    return this.#half(0x4300 | ((rm & 7) << 3) | (rd & 7));
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  b(condition: number, label: string): this {
    this.#patches.push({ at: this.#halves.length, label, condition });
    return this.#half(0xd000 | ((condition & 0xf) << 8));
  }

  nop(): this {
    return this.#half(0xbf00);
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  build(): Uint8Array {
    for (const patch of this.#patches) {
      const target = this.#labels.get(patch.label);

      if (target === undefined) throw new Error(`Missing label ${patch.label}`);

      const displacement = target - (patch.at * 2 + 4);
      const half = displacement / 2;

      if (!Number.isInteger(half) || half < -128 || half > 127)
        throw new Error(`Branch to ${patch.label} out of range`);

      this.#halves[patch.at] = 0xd000 | ((patch.condition & 0xf) << 8) | (half & 0xff);
    }

    const code = new Uint8Array(this.#halves.length * 2);
    const view = new DataView(code.buffer);

    this.#halves.forEach((value, index) => view.setUint16(index * 2, value, true));

    const image = new Uint8Array(8 + code.length);
    const header = new DataView(image.buffer);

    header.setUint32(0, 0x2000_5000, true);
    header.setUint32(4, 0x0800_0009, true);
    image.set(code, 8);

    return image;
  }
}

/**
 * 可编程的 bit-bang 固件。
 *
 * `writeByte` 返回 ACK 采样结果槽，`readByte` 返回读到的数据字节槽，
 * `sampleAdc` 返回 ADC1 DR 槽。槽号通过 `readResult(sram, slot)` 读取。
 */
export class I2cProgram {
  readonly #thumb = new Thumb();
  #slot = 0;
  #label = 0;

  constructor() {
    // GPIOB 时钟、PB6/PB7 开漏输出、无内部上下拉、初始释放为高。
    this.#writeWord(RCC_AHB2ENR, 1 << 1);
    this.#thumb.movw(4, GPIOB & 0xffff).movt(4, GPIOB >>> 16);
    this.#writeWord(GPIOB, 0x0000_5000);
    this.#writeWord(GPIOB + 0x04, 0x0000_00c0);
    this.#writeWord(GPIOB + 0x0c, 0);
    this.#writeWord(GPIOB + 0x18, (1 << 6) | (1 << 7));
    this.#thumb.movw(6, I2C_RESULT_BASE & 0xffff).movt(6, I2C_RESULT_BASE >>> 16);
  }

  #writeWord(address: number, value: number): void {
    this.#thumb.movw(0, address & 0xffff).movt(0, address >>> 16);
    if (value <= 0xff) this.#thumb.movs(1, value);
    else this.#thumb.movw(1, value & 0xffff).movt(1, value >>> 16);
    this.#thumb.strWord(1, 0, 0);
  }

  #word(base: number, offset: number, value: number): void {
    if (value <= 0xff) this.#thumb.movs(1, value);
    else this.#thumb.movw(1, value & 0xffff).movt(1, value >>> 16);
    this.#thumb.strWord(1, base, offset);
  }

  #bsrr(mask: number): void {
    if (mask <= 0xff) this.#thumb.movs(1, mask);
    else this.#thumb.movw(1, mask & 0xffff).movt(1, mask >>> 16);
    this.#thumb.strWord(1, 4, 0x18);
  }

  #scl(high: boolean): void {
    this.#bsrr(high ? 1 << 6 : 1 << (6 + 16));
  }

  #sda(high: boolean): void {
    this.#bsrr(high ? 1 << 7 : 1 << (7 + 16));
  }

  /** 采样 PB7：IDR bit 7 → bit 31 → 0/1。 */
  #readSda(): void {
    this.#thumb.ldrWord(0, 4, 0x10).lsls(0, 0, 24).lsrs(0, 0, 31);
  }

  #storeSlot(register: number, slot: number): void {
    if (slot * 4 > 0xfff) throw new RangeError(`result slot ${slot} exceeds STR offset`);
    this.#thumb.strWord(register, 6, slot * 4);
  }

  /** 写 GPIOB MODER；保留调用方给出的完整 16 位模式。 */
  setModer(value: number): void {
    this.#word(4, 0x00, value);
  }

  setOtyper(value: number): void {
    this.#word(4, 0x04, value);
  }

  setPupdr(value: number): void {
    this.#word(4, 0x0c, value);
  }

  /** 直接写 ODR；仅用于构造输入/释放边界，不替代正常 BSRR 时序。 */
  setOdr(value: number): void {
    this.#word(4, 0x14, value);
  }

  /** 开/关 GPIOB 时钟；关闭后 MODER/ODR 保留，但不得再被当作主动拉低。 */
  setGpioClock(enabled: boolean): void {
    this.#writeWord(RCC_AHB2ENR, enabled ? 1 << 1 : 0);
  }

  setScl(high: boolean): void {
    this.#scl(high);
  }

  setSda(high: boolean): void {
    this.#sda(high);
  }

  sampleSda(): number {
    this.#readSda();
    const slot = this.#slot++;
    this.#storeSlot(0, slot);
    return slot;
  }

  sampleScl(): number {
    this.#thumb.ldrWord(0, 4, 0x10).lsls(0, 0, 25).lsrs(0, 0, 31);
    const slot = this.#slot++;
    this.#storeSlot(0, slot);
    return slot;
  }

  #delay(iterations: number): void {
    if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 0xffff)
      throw new RangeError(`invalid delay ${iterations}`);

    const label = `delay-${this.#label++}`;

    this.#thumb.movw(3, iterations).label(label).subs(3, 1).b(1, label);
  }

  start(): void {
    this.#sda(true);
    this.#scl(true);
    this.#sda(false);
  }

  stop(): void {
    this.#scl(false);
    this.#sda(false);
    this.#scl(true);
    this.#sda(true);
  }

  /** 发送一个字节，返回采样第 9 个时钟 ACK 的结果槽。 */
  writeByte(value: number): number {
    this.#scl(false);

    for (let bit = 7; bit >= 0; bit -= 1) {
      this.#sda(((value >> bit) & 1) === 1);
      this.#scl(true);
      this.#scl(false);
    }

    this.#sda(true);
    this.#scl(true);
    this.#readSda();
    const slot = this.#slot++;
    this.#storeSlot(0, slot);
    this.#scl(false);
    return slot;
  }

  /**
   * 写完 8 位后停在 ACK 高电平窗口，期间翻转主控 SDA 意图，再退出 ACK。
   *
   * 返回 ACK 窗口三个采样槽：释放后、主控再次拉低后、再次释放后。三次都应读到
   * 从机保持的低电平，证明这些主控意图变化没有被当成 START/STOP。
   */
  writeByteWithAckToggles(value: number): readonly number[] {
    this.#scl(false);
    for (let bit = 7; bit >= 0; bit -= 1) {
      this.#sda(((value >> bit) & 1) === 1);
      this.#scl(true);
      this.#scl(false);
    }

    this.#sda(true);
    this.#scl(true);
    const released = this.sampleSda();

    this.#sda(false);
    const pulled = this.sampleSda();

    this.#sda(true);
    const releasedAgain = this.sampleSda();

    this.#scl(false);
    return [released, pulled, releasedAgain];
  }

  /** 读一个字节并由主机发 ACK(ack=true)/NACK；返回数据槽。 */
  readByte(ack: boolean): number {
    this.#sda(true);
    this.#thumb.movs(5, 0);

    for (let bit = 0; bit < 8; bit += 1) {
      this.#scl(true);
      this.#readSda();
      this.#thumb.lsls(5, 5, 1).orrs(5, 0);
      this.#scl(false);
    }

    const slot = this.#slot++;
    this.#storeSlot(5, slot);

    this.#sda(!ack);
    this.#scl(true);
    this.#scl(false);
    this.#sda(true);
    return slot;
  }

  /**
   * 在当前 PB14 接线上启动一次 ADC1 转换并保存 DR。
   *
   * PB14 = ADC1_IN5（`examples/stm32g431rbt6-core/src/adc-layout.ts`）。调用前
   * I²C 事务应已结束；该操作会把同一 GPIOB MODER 重写成 PB6/PB7 输出 + PB14 模拟。
   */
  sampleAdc(channel = 5): number {
    this.#word(4, 0, 0x3000_5000);
    this.#thumb.movw(0, 0x0308).movt(0, 0x5000);
    this.#thumb.movs(1, 1).strWord(1, 0, 0);
    this.#thumb.movw(7, 0).movt(7, 0x5000);
    this.#thumb.movw(1, 0x1000).movt(1, 0x0001).strWord(1, 7, 0x08);
    this.#delay(2_000);
    if (channel < 0 || channel > 18) throw new RangeError(`invalid ADC channel ${channel}`);
    this.#thumb.movw(1, channel << 6).strWord(1, 7, 0x30);
    this.#thumb.movw(1, 0x1000).movt(1, 0x0001).strWord(1, 7, 0x08);
    this.#thumb.movw(1, 0x0005).movt(1, 0x0001).strWord(1, 7, 0x08);
    this.#delay(4_000);
    this.#thumb.ldrWord(2, 7, 0x40);
    const slot = this.#slot++;
    this.#storeSlot(2, slot);
    return slot;
  }

  spin(): void {
    this.#thumb.spin();
  }

  build(): {
    readonly image: Uint8Array;
    readonly readResult: (sram: Uint8Array, slot: number) => number;
  } {
    const image = this.#thumb.build();

    return {
      image,
      readResult(sram, slot) {
        return new DataView(sram.buffer, sram.byteOffset, sram.byteLength).getUint32(
          I2C_RESULT_BASE - 0x2000_0000 + slot * 4,
          true,
        );
      },
    };
  }
}

/** 只空转的固件，用于宿主方法/事件用例。 */
export function idleFirmware(): Uint8Array {
  const program = new I2cProgram();

  program.spin();
  return program.build().image;
}
