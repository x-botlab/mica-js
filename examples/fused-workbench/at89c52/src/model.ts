import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import { decode } from '../../../iap15f2k61s2/src/devices/iap15f2k61s2/kernel/decode';
import { InterruptController } from '../../../iap15f2k61s2/src/devices/iap15f2k61s2/kernel/interrupt';
import {
  activateMachine,
  type Machine,
} from '../../../iap15f2k61s2/src/devices/iap15f2k61s2/kernel/machine';
import { SfrHooks } from '../../../iap15f2k61s2/src/devices/iap15f2k61s2/kernel/sfr-hooks';
import {
  readPin,
  readPort,
} from '../../../iap15f2k61s2/src/devices/iap15f2k61s2/peripherals/ports';

const twoCycle = new Set([
  0x02, 0x10, 0x12, 0x20, 0x22, 0x30, 0x32, 0x40, 0x43, 0x50, 0x53, 0x60, 0x63, 0x70, 0x72, 0x73,
  0x75, 0x80, 0x82, 0x83, 0x85, 0x86, 0x87, 0x90, 0x92, 0x93, 0xa0, 0xa3, 0xa6, 0xa7, 0xb0, 0xc0,
  0xd0, 0xd5,
]);
const externalMemory = new Set([0xe0, 0xe2, 0xe3, 0xf0, 0xf2, 0xf3]);

// The shared decoder reports STC15 clocks; this model uses classic 8051 machine cycles.
function machineCycles(opcode: number): number {
  if (opcode === 0x84 || opcode === 0xa4) return 4;
  if (
    (opcode & 0x1f) === 1 ||
    (opcode & 0x1f) === 0x11 ||
    twoCycle.has(opcode) ||
    (opcode >= 0x88 && opcode <= 0x8f) ||
    (opcode >= 0xa8 && opcode <= 0xaf) ||
    (opcode >= 0xb4 && opcode <= 0xbf) ||
    (opcode >= 0xd8 && opcode <= 0xdf)
  )
    return 2;
  return 1;
}

export const create: DeviceFactory = (context) => {
  const cyclePs = Math.round(12_000_000_000_000 / context.props.clockFrequency);
  const sfr = new SfrHooks();
  for (let port = 0; port < 4; port++) {
    sfr.onWrite(0x80 + port * 0x10, (body, _address, value) => {
      const low = body.resistor('GND', body.constant(types.number, 25));
      const high =
        port === 0
          ? body.combineIntents()
          : body.resistor('VCC', body.constant(types.number, 10000));
      for (let bit = 0; bit < 8; bit++) {
        const released = body.notEqual(
          types.number,
          body.bitAnd(value, body.constant(types.number, 1 << bit)),
          body.constant(types.number, 0),
        );
        body.writeIntent(
          `P${port}_${bit}`,
          body.select(
            types.intent,
            released,
            () => high,
            () => low,
          ),
        );
      }
    });
  }
  const supported = new Set([0x80, 0x81, 0x82, 0x83, 0x90, 0xa0, 0xb0, 0xd0, 0xe0, 0xf0]);
  for (let address = 0x80; address <= 0xff; address++) {
    if (supported.has(address)) continue;
    const unsupported = () => {
      throw new Error(`AT89C52 GPIO example: SFR 0x${address.toString(16)} is not modeled.`);
    };
    sfr.onRead(address, unsupported);
    sfr.onWrite(address, unsupported);
  }
  const machine: Machine = {
    clockFrequency: context.props.clockFrequency,
    cyclePs,
    pcState: 'pc',
    sfr,
    irq: new InterruptController(),
    peripherals: [],
    ports: { readPin, readPort },
  };
  context.attachJit({
    entry: 'cpu',
    code: 'code',
    pc: 'pc',
    translate({ code, pc }) {
      if (pc >= 8192) throw new Error(`AT89C52 program counter exceeds internal Flash: ${pc}`);
      const opcode = code[pc] ?? 0xff;
      if (externalMemory.has(opcode) || opcode === 0x32 || opcode === 0xa5)
        throw new Error(`AT89C52 GPIO example: opcode 0x${opcode.toString(16)} is not supported.`);
      return activateMachine(machine, () => {
        const instruction = decode(code, pc);
        const builder = createJitBlockBuilder();
        builder.instruction({ pc, nextPc: (pc + instruction.size) & 0xffff }, (body) => {
          instruction.emit(body);
          body.elapse(machineCycles(opcode) * cyclePs);
        });
        return builder.finish();
      });
    },
  });
  context.loadBytes('code', new Uint8Array(8192).fill(0xff));
  for (const segment of context.props.program.segments)
    context.loadBytes('code', segment.data.slice(), segment.address);
  return { methods: {}, sync() {}, dispose() {} };
};
