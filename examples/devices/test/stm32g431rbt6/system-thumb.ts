/**
 * 手写 Thumb/Thumb-2 编码器，只覆盖 NVIC/EXTI/NRST 测试固件用到的形式。
 *
 * 代码从 Flash 偏移 0x100 开始；向量表按 Cortex-M 异常号填写。`build()` 解析
 * 标签分支并把 bit0 置为 Thumb 状态。
 */
type SystemBranch =
  | { readonly at: number; readonly label: string; readonly condition?: undefined }
  | { readonly at: number; readonly label: string; readonly condition: number };

export class SystemThumb {
  readonly #code: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #branches: SystemBranch[] = [];
  readonly #vectors = new Map<number, string>();
  readonly #literals: number[] = [];
  readonly #literalBase = 0x800;

  /** 当前代码偏移（相对代码起点，不是 Flash 绝对偏移）。 */
  get offset(): number {
    return this.#code.length * 2;
  }

  mark(label: string): this {
    this.#labels.set(label, this.offset);

    return this;
  }

  vector(exception: number, label: string): this {
    this.#vectors.set(exception, label);

    return this;
  }

  half(value: number): this {
    this.#code.push(value & 0xffff);

    return this;
  }

  dword(first: number, second: number): this {
    return this.half(first).half(second);
  }

  movs(rd: number, immediate: number): this {
    return this.half(0x2000 | (rd << 8) | (immediate & 0xff));
  }

  adds(rd: number, immediate: number): this {
    return this.half(0x3000 | (rd << 8) | (immediate & 0xff));
  }

  subs(rd: number, immediate: number): this {
    return this.half(0x3800 | (rd << 8) | (immediate & 0xff));
  }

  cmp(rd: number, immediate: number): this {
    return this.half(0x2800 | (rd << 8) | (immediate & 0xff));
  }

  ands(rd: number, rm: number): this {
    return this.half(0x4000 | ((rm & 7) << 3) | (rd & 7));
  }

  movw(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.dword(
      0xf240 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movt(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.dword(
      0xf2c0 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strHalf(rt: number, rn: number, offset: number): this {
    return this.dword(0xf8a0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrHalf(rt: number, rn: number, offset: number): this {
    return this.dword(0xf8b0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strByte(rt: number, rn: number, offset: number): this {
    return this.dword(0xf880 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrByte(rt: number, rn: number, offset: number): this {
    return this.dword(0xf890 | rn, (rt << 12) | (offset & 0xfff));
  }

  /** `str Rt, [Rn, Rm]` */
  strReg(rt: number, rn: number, rm: number): this {
    return this.dword(0xf840 | rn, (rt << 12) | (rm & 0xf));
  }

  /** `ldr Rt, [Rn, Rm]` */
  ldrReg(rt: number, rn: number, rm: number): this {
    return this.dword(0xf850 | rn, (rt << 12) | (rm & 0xf));
  }

  strSp(rt: number, offset: number): this {
    return this.half(0x9000 | (rt << 8) | ((offset >>> 2) & 0xff));
  }

  ldrSp(rt: number, offset: number): this {
    return this.half(0x9800 | (rt << 8) | ((offset >>> 2) & 0xff));
  }

  push(list: number): this {
    return this.half(0xb400 | (list & 0x1ff));
  }

  pop(list: number): this {
    return this.half(0xbc00 | (list & 0x1ff));
  }

  bx(rm: number): this {
    return this.half(0x4700 | ((rm & 0xf) << 3));
  }

  blx(rm: number): this {
    return this.half(0x4780 | ((rm & 0xf) << 3));
  }

  nop(): this {
    return this.half(0xbf00);
  }

  svc(immediate = 0): this {
    return this.half(0xdf00 | (immediate & 0xff));
  }

  bkpt(immediate = 0): this {
    return this.half(0xbe00 | (immediate & 0xff));
  }

  cpsid(): this {
    return this.half(0xb672);
  }

  cpsie(): this {
    return this.half(0xb662);
  }

  mrs(rd: number, sysm: number): this {
    return this.dword(0xf3ef, 0x8000 | (rd << 8) | (sysm & 0xff));
  }

  msr(rn: number, sysm: number): this {
    return this.dword(0xf380 | (rn & 0xf), 0x8800 | (sysm & 0xff));
  }

  /** 无条件分支到标签。 */
  b(label: string): this {
    this.#branches.push({ at: this.offset, label });

    return this.half(0xe000);
  }

  /** 条件分支到标签；条件使用 4 位 ARM 编码（EQ=0、NE=1…）。 */
  bcond(condition: number, label: string): this {
    this.#branches.push({ at: this.offset, label, condition });

    return this.half(0xd000 | ((condition & 0xf) << 8));
  }

  /** `b .`：测试固件常用的静止点。 */
  spin(): this {
    return this.half(0xe7fe);
  }

  /** 追加一个 32 位字面量并返回它在 Flash 中的绝对地址。 */
  literal(value: number): number {
    const index = this.#literals.length;

    this.#literals.push(value >>> 0);

    return this.#literalBase + index * 4;
  }

  build(start = 0x0800_0500): Uint8Array {
    const resolve = (): void => {
      for (const branch of this.#branches) {
        const target = this.#labels.get(branch.label);

        if (target === undefined) throw new Error(`Unknown label ${branch.label}`);
        const delta = (target - (branch.at + 4)) / 2;

        if (branch.condition === undefined) {
          if (delta < -2048 || delta > 2047) throw new Error(`Branch to ${branch.label} out of range`);
          this.#code[branch.at / 2] = 0xe000 | (delta & 0x7ff);
        } else {
          if (delta < -128 || delta > 127) throw new Error(`Branch to ${branch.label} out of range`);
          this.#code[branch.at / 2] = 0xd000 | ((branch.condition & 0xf) << 8) | (delta & 0xff);
        }
      }
    };
    resolve();

    const codeBase = start & 0x1ffff;
    const size = Math.max(codeBase + this.#code.length * 2 + 4, this.#literalBase + this.#literals.length * 4 + 4);
    const image = new Uint8Array(size);
    const view = new DataView(image.buffer);

    for (const [exception, label] of this.#vectors) {
      const target = this.#labels.get(label);

      if (target === undefined) throw new Error(`Unknown vector ${label}`);
      view.setUint32(exception * 4, (start + target) | 1, true);
    }
    view.setUint32(4, start | 1, true);
    view.setUint32(0, 0x2000_5800, true);
    this.#code.forEach((value, index) => view.setUint16(codeBase + index * 2, value, true));
    this.#literals.forEach((value, index) =>
      view.setUint32(this.#literalBase + index * 4, value, true),
    );

    return image;
  }
}

/** 向量号：CMSIS IRQn + 16。 */
export const vectorOf = (irq: number): number => irq + 16;
