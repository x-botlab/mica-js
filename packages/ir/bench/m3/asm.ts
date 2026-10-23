/**
 * Minimal two-pass assembler for the benchmark guest ISA.
 *
 * Branches use labels; `finish()` resolves the fixups to signed word
 * displacements and returns the little-endian firmware image. It is not a
 * general-purpose assembler — it only covers the instructions the benchmark
 * firmware and tests need.
 */
import { Cond, Op, encodeB, encodeBL, encodeI, encodeR } from './isa';

interface BranchFixup {
  readonly index: number;
  readonly label: string;
  readonly cond: number;
  readonly kind: 'b' | 'bl';
}

export interface AssembledProgram {
  readonly bytes: Uint8Array;
  readonly labels: ReadonlyMap<string, number>;
}

export class Assembler {
  readonly #words: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #fixups: BranchFixup[] = [];

  label(name: string): this {
    if (this.#labels.has(name)) throw new Error(`Duplicate guest label "${name}"`);
    this.#labels.set(name, this.#words.length * 4);
    return this;
  }

  movi(rd: number, imm16: number): this {
    return this.#emit(encodeI(Op.MOVI, rd, 0, imm16));
  }

  movt(rd: number, imm16: number): this {
    return this.#emit(encodeI(Op.MOVT, rd, 0, imm16));
  }

  add(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.ADD, rd, rn, rm));
  }

  sub(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.SUB, rd, rn, rm));
  }

  and(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.AND, rd, rn, rm));
  }

  orr(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.ORR, rd, rn, rm));
  }

  eor(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.EOR, rd, rn, rm));
  }

  lsl(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.LSL, rd, rn, rm));
  }

  lsr(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.LSR, rd, rn, rm));
  }

  asr(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.ASR, rd, rn, rm));
  }

  mul(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.MUL, rd, rn, rm));
  }

  addi(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.ADDI, rd, rn, imm16));
  }

  subi(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.SUBI, rd, rn, imm16));
  }

  cmp(rn: number, rm: number): this {
    return this.#emit(encodeR(Op.CMP, 0, rn, rm));
  }

  cmpi(rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.CMPI, 0, rn, imm16));
  }

  adds(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.ADDS, rd, rn, rm));
  }

  subs(rd: number, rn: number, rm: number): this {
    return this.#emit(encodeR(Op.SUBS, rd, rn, rm));
  }

  ldr(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.LDR, rd, rn, imm16));
  }

  str(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.STR, rd, rn, imm16));
  }

  ldrb(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.LDRB, rd, rn, imm16));
  }

  strb(rd: number, rn: number, imm16: number): this {
    return this.#emit(encodeI(Op.STRB, rd, rn, imm16));
  }

  b(label: string, cond: number = Cond.AL): this {
    this.#fixups.push({ index: this.#words.length, label, cond, kind: 'b' });
    this.#words.push(0);
    return this;
  }

  bl(label: string): this {
    this.#fixups.push({ index: this.#words.length, label, cond: Cond.AL, kind: 'bl' });
    this.#words.push(0);
    return this;
  }

  bx(rn: number): this {
    return this.#emit(encodeR(Op.BX, 0, rn, 0));
  }

  halt(): this {
    return this.#emit(encodeR(Op.HALT, 0, 0, 0));
  }

  finish(): AssembledProgram {
    const words = [...this.#words];
    for (const fixup of this.#fixups) {
      const target = this.#labels.get(fixup.label);
      if (target === undefined) throw new Error(`Unknown guest label "${fixup.label}"`);
      const pc = fixup.index * 4;
      const deltaBytes = target - (pc + 4);
      if (deltaBytes % 4 !== 0) throw new Error('Guest branch target is not word aligned');
      const deltaWords = deltaBytes / 4;
      if (fixup.kind === 'b') {
        if (deltaWords < -(1 << 21) || deltaWords >= 1 << 21) {
          throw new Error('Guest B displacement does not fit in simm22');
        }
        words[fixup.index] = encodeB(fixup.cond, deltaWords);
      } else {
        if (deltaWords < -(1 << 25) || deltaWords >= 1 << 25) {
          throw new Error('Guest BL displacement does not fit in simm26');
        }
        words[fixup.index] = encodeBL(deltaWords);
      }
    }
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < words.length; index += 1) {
      view.setUint32(index * 4, words[index]!, true);
    }
    return { bytes, labels: new Map(this.#labels) };
  }

  #emit(word: number): this {
    this.#words.push(word >>> 0);
    return this;
  }
}
