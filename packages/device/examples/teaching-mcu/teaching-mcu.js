/**
 * Minimal teaching MCU from #8 §8.2 / #26 §16.4.
 *
 * Synthetic two-byte ISA, decoded once per guest basic block at Provider generation time:
 * 0x10 ADD R0, #imm; 0x20 JMP #address; 0x30 JNZ R0, #address; 0x00 HALT.
 * Every instruction counts as 10,000 ps and the model is observable only at block boundaries.
 * This is not a cycle-accurate AVR/8051 model and does not execute a real ISA.
 *
 * @param {import('@mica-js/device').DeviceAPI} api
 */
export default function createDevice(api) {
  const ir = api.ir;
  const OP_ADD = 0x10;
  const OP_JMP = 0x20;
  const OP_JNZ = 0x30;
  const OP_HALT = 0x00;
  const OP_FAULT = 0xff;
  const CYCLE_PS = 10000;
  const FIRMWARE_BYTES = [0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0];
  const FIRMWARE_LENGTH = FIRMWARE_BYTES.length;

  const gpio = ir.pin('GPIO');
  const writeGPIO = ir.func('writeGPIO', { params: ['u32'], results: [] });
  writeGPIO.body((b, [value]) => {
    const lowBit = b.int.and(value, b.const('u32', 1));
    const high = b.int.cmp('ne', lowBit, b.const('u32', 0));
    b.pin.writeDigital(gpio, high);
    b.return([]);
  });

  // Readonly forbids ordinary guest stores. The host grants the separate update path with
  // `updateResources: ["firmware"]`; the generated code only reads through the tracked API.
  const firmware = ir.bytes('firmware', new Uint8Array(FIRMWARE_BYTES), {
    readonly: true,
    unitBytes: 8,
  });
  const pc = ir.state('pc', 'u32', 0);
  const r0 = ir.state('r0', 'u32', 0);
  const stopped = ir.state('stopped', 'bool', false);
  const guestFault = ir.state('guestFault', 'bool', false);
  const step = ir.entry('step', []);
  const initialize = ir.lifecycle('initialize', []);

  const code = ir.provider(
    'code',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, r0, stopped, guestFault, step, writeGPIO],
    },
    (gen, [address]) => {
      // Generation-time decoding only. Each fetch records the version unit it actually covers.
      const instructions = [];
      let cursor = address;
      for (;;) {
        if (cursor + 2 > FIRMWARE_LENGTH || cursor % 2 !== 0) {
          instructions.push({ opcode: OP_FAULT, operand: 0, cursor });
          break;
        }
        const bytes = gen.readBytes(firmware, cursor, 2);
        const opcode = bytes[0];
        const operand = bytes[1];
        instructions.push({ opcode, operand, cursor });
        if (opcode !== OP_ADD) break;
        cursor += 2;
      }
      return gen.function((b) => {
        // The running value is loaded once; generation never bakes the current register value.
        let value = b.state.load(r0);
        for (const instruction of instructions) {
          const { opcode, operand, cursor } = instruction;
          if (opcode === OP_ADD) {
            value = b.int.add(value, b.const('u32', operand));
            continue;
          }
          b.state.store(r0, value);
          b.call(writeGPIO, [value]);
          if (opcode === OP_JMP || opcode === OP_JNZ) {
            let next = b.const('u32', operand);
            if (opcode === OP_JNZ) {
              const nonzero = b.int.cmp('ne', value, b.const('u32', 0));
              next = b.select(nonzero, next, b.const('u32', cursor + 2));
            }
            b.state.store(pc, next);
            const delay = b.const('f64', instructions.length * CYCLE_PS);
            const deadline = b.float.add(b.event.now(), delay);
            b.event.at(step, deadline, []);
          } else {
            b.state.store(stopped, b.const('bool', true));
            b.state.store(guestFault, b.const('bool', opcode !== OP_HALT));
          }
          b.return([]);
          return;
        }
        b.return([]);
      });
    },
  );

  step.body((b) => {
    b.dispatch(code, [b.state.load(pc)], []);
  });
  initialize.body((b) => {
    b.pin.writeDigital(gpio, b.const('bool', false));
    b.pin.configure(gpio, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
    b.event.at(step, b.event.now(), []);
    b.return([]);
  });

  const stop = api.subscribe('firmwarePatch', (patch) => {
    if (patch instanceof Uint8Array) {
      return api.updateBytes(firmware, 0, patch);
    }
    return undefined;
  });
  return { initialize, onDispose: stop };
}
