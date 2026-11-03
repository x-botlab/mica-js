import type { DeviceBuilder, TypeFactory } from '../../../../docs/spec/contracts/builder';
import type { DeviceIR } from '../../../../docs/spec/contracts/ir';
import type {
  JitTranslate,
  DeviceContext,
  InputNotification,
  ReadonlyBytes,
} from '../../../../docs/spec/contracts/host';

// A representative 8-bit accumulator, byte-addressed 256-byte unified code RAM.
// PC/immediate fetch wrap modulo 256; IRQ vector=128, one saved return PC.
// A level-latched pending IRQ is coalesced; nested interrupts are masked.
export type ProcessorContext = DeviceContext<
  { readonly firmware: ReadonlyBytes },
  { readonly irq: InputNotification; readonly wake: InputNotification },
  object
>;

// Supply a fresh real SDK builder and its type factory; contracts are types only.
export function buildProcessor(d: DeviceBuilder, types: TypeFactory): DeviceIR {
  d.property({ name: 'firmware', type: types.bytes, default: [0xff] });
  d.memory({ name: 'code', length: 256 });
  for (const name of ['pc', 'acc', 'returnPc']) {
    d.state({ name, type: types.number, initial: 0 });
  }
  d.state({ name: 'irqEnabled', type: types.bool, initial: true });
  d.state({ name: 'irqPending', type: types.bool, initial: false });
  d.state({ name: 'wakeLatched', type: types.bool, initial: false });
  d.notification({ name: 'irq', direction: 'input' });
  d.notification({ name: 'wake', direction: 'input' });
  d.on({ name: 'latchIrq', sourcePath: ['irq'] }, (b) => {
    b.writeState('irqPending', true);
  });
  d.on({ name: 'latchWake', sourcePath: ['wake'] }, (b) => {
    b.writeState('wakeLatched', true);
  });
  d.derived({ name: 'takeIrq', type: types.bool }, (b) => {
    b.returnValue(
      b.and(b.readState('irqEnabled', types.bool), (c) => c.readState('irqPending', types.bool)),
    );
  });
  d.pureFn({ name: 'canResume', params: [], returns: types.bool }, (b) => {
    b.returnValue(
      b.or(b.readState('wakeLatched', types.bool), (c) => c.readDerived('takeIrq', types.bool)),
    );
  });
  d.fn({ name: 'enterIrq', params: [] }, (b) => {
    // At this boundary pc is the next instruction, including after WAIT.
    b.writeState('returnPc', b.readState('pc', types.number));
    b.writeState('irqPending', false);
    b.writeState('irqEnabled', false);
    b.redirect(128, 2);
  });
  d.fn({ name: 'returnIrq', params: [] }, (b) => {
    b.writeState('irqEnabled', true);
    b.redirect(b.readState('returnPc', types.number), 2);
  });
  // No start reset: notifications/reactions may have updated state already.
  return d.finish();
}

// ISA (hex): 00 NOP(1 ps), 10 imm LDI(2 ps), 11 imm ADDI(2 ps),
// 20 WAIT(1 ps then dependency wait), 21 ACK-wake(1 ps), 30 addr JMP(1 ps),
// 40 IRET(2 ps via redirect), 50 addr byte PATCH(2 ps), ff HALT.
// Illegal opcode asserts only when executed, not while decoding a future suffix.
// Up to two instructions per block exercise per-instruction hooks/invalidation.
export function createProcessorTranslator(types: TypeFactory): JitTranslate {
  return ({ pc, code }, block) => {
    if (!Number.isInteger(pc) || pc < 0 || pc >= 256 || code.length !== 256) {
      throw new Error('Invalid processor PC or code memory binding');
    }
    const byteAt = (address: number): number => {
      const value = code[address & 255];
      if (value === undefined) throw new Error('Missing code byte');
      return value;
    };
    let address = pc;
    for (let count = 0; count < 2; count += 1) {
      const opcode = byteAt(address);
      const operand = byteAt(address + 1);
      const patchedByte = byteAt(address + 2);
      const width =
        opcode === 0x50 ? 3 : opcode === 0x10 || opcode === 0x11 || opcode === 0x30 ? 2 : 1;
      const nextPc = (address + width) & 255;
      const terminal =
        opcode === 0x20 || opcode === 0x30 || opcode === 0x40 || opcode === 0x50 || opcode === 0xff;
      const known = [0x00, 0x10, 0x11, 0x20, 0x21, 0x30, 0x40, 0x50, 0xff].includes(opcode);
      block.instruction({ pc: address, nextPc }, (b) => {
        switch (opcode) {
          case 0x00:
            b.elapse(1);
            break;
          case 0x10:
            b.writeState('acc', operand);
            b.elapse(2);
            break;
          case 0x11:
            b.writeState('acc', b.bitAnd(b.add(b.readState('acc', types.number), operand), 255));
            b.elapse(2);
            break;
          case 0x20:
            b.elapse(1);
            b.waitUntil('canResume');
            break;
          case 0x21:
            b.writeState('wakeLatched', false);
            b.elapse(1);
            break;
          case 0x30:
            b.redirect(operand, 1);
            break;
          case 0x40:
            b.call('returnIrq');
            break;
          case 0x50:
            b.store8('code', operand, patchedByte);
            b.elapse(2);
            break;
          case 0xff:
            b.stop();
            break;
          default:
            b.assert(false, (c) => c.constant(types.string, 'Illegal opcode'));
            b.stop();
        }
      });
      if (terminal || !known) break;
      address = nextPc;
    }
    return block.finish();
  };
}

// Pure input vectors, not a simulator. Expected outcomes require a future runtime.
export const processorCases = {
  // acc=1 at t=0, still 1 at t=1; patch byte[2] to ff while paused at t=1:
  // active LDI consumes its remaining 1 ps, old ADDI suffix must not execute.
  invalidateSuffix: new Uint8Array([0x10, 1, 0x11, 2, 0xff]),
  // WAIT nextPc=1; wake or enabled IRQ releases dependency wait, not code writes.
  waitAndIrq: new Uint8Array([0x20, 0x21, 0x10, 7, 0xff]),
  // Replace the next NOP with HALT; next instruction uses the new code version.
  selfModify: new Uint8Array([0x50, 3, 0xff, 0x00]),
  // Same-byte writes also invalidate; a future runtime cache test observes this.
  sameByteWrite: new Uint8Array([0x50, 3, 0x00, 0x00, 0xff]),
  // Wrap immediate fetch: load [ff]=10 and [00]=42, jump to ff.
  wrapFetch: new Uint8Array([0x30, 0xff]),
  irqHandler: new Uint8Array([0x10, 9, 0x40]), // load at offset 128
} as const;
