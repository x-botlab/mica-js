import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeviceBuilder,
  createJitBlockBuilder,
  types,
} from '../../../device-model/dist/index.js';
import * as sdk from '../../dist/index.js';
import {
  DEFAULT_CYCLE_PS,
  FLASH_BASE,
  FLASH_SIZE,
  GPIOA_BASE,
  RCC_AHB2ENR,
  SCB_ICSR,
  SCB_VTOR,
  SRAM_BASE,
  SRAM_SIZE,
  SYSTICK_BASE,
} from './constants.mjs';
import {
  GPIO_DRIVE,
  MMIO,
  busInitialState,
  createBusAccess,
  emitLoad,
  emitStore,
  registerBus,
  snapshotStateNames,
} from './bus.mjs';

// A five-byte "instruction" performs exactly one bus access, so the firmware below is also
// the timing script: instruction `i` starts at `i * cyclePs`.
const OP = Object.freeze({
  setAcc: 1,
  setAddr: 2,
  store32: 3,
  store32dyn: 4,
  load32: 5,
  load32dyn: 6,
  load16dyn: 7,
  load8dyn: 8,
  store16dyn: 9,
  store8dyn: 10,
  delay: 11,
  halt: 0xff,
});
const ACC = 0;
const ODR = 8;
const MODER = 12;
const TICKS = 16;
const COUNTFLAG = 20;
const IRQ = 24;
const LEVEL = 28;
const STATUS = 32;
const SNAPSHOT_LENGTH = 36;
const BYTES_PER_INSTRUCTION = 5;

const op = (code, operand = 0) => {
  const bytes = new Uint8Array(BYTES_PER_INSTRUCTION);
  bytes[0] = code;
  new DataView(bytes.buffer).setUint32(1, operand, true);
  return Array.from(bytes);
};
const program = (...items) => items.flat();
const withData = (code, offset, data) => {
  const bytes = [...code];
  while (bytes.length < offset) bytes.push(0);
  bytes.push(...data);
  return bytes;
};
/** Board time (ps) at which the instruction with this index starts. */
const at = (index, cyclePs = DEFAULT_CYCLE_PS) => index * cyclePs;

function createModel({ memoryAccess = 'bytes', cyclePs = DEFAULT_CYCLE_PS } = {}) {
  const access = createBusAccess({ memoryAccess });
  const d = createDeviceBuilder();
  d.memory({ name: 'code', length: FLASH_SIZE });
  d.memory({ name: 'ram', length: SRAM_SIZE, public: true });
  d.memory({ name: 'snapshot', length: SNAPSHOT_LENGTH, public: true });
  d.state({ name: 'pc', type: types.number, initial: 0 });
  d.state({ name: 'acc', type: types.number, initial: 0 });
  d.state({ name: 'addr', type: types.number, initial: 0 });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  registerBus(d, { cyclePs });
  d.on({ name: 'captureSnapshot', sourcePath: ['snapshotRequest'] }, (b) => {
    b.store32le('snapshot', ACC, b.readState('acc', types.number));
    b.store32le('snapshot', ODR, b.readState('gpioOdr', types.number));
    b.store32le('snapshot', MODER, b.readState('gpioModer', types.number));
    b.store32le('snapshot', TICKS, b.readState('systickTicks', types.number));
    b.store32le('snapshot', COUNTFLAG, b.readState('systickCountflag', types.number));
    b.store32le(
      'snapshot',
      IRQ,
      b.select(
        types.number,
        b.readState('irqPending', types.bool),
        () => 1,
        () => 0,
      ),
    );
    const sample = b.readSample('pa5');
    const level = b.field(sample, 'level');
    b.store32le(
      'snapshot',
      LEVEL,
      b.select(
        types.number,
        b.equal(types.logic, level, types.logic.members.high),
        () => 1,
        (c) =>
          c.select(
            types.number,
            c.equal(types.logic, level, types.logic.members.low),
            () => 0,
            () => 2,
          ),
      ),
    );
    b.store32le(
      'snapshot',
      STATUS,
      b.select(
        types.number,
        b.equal(types.sampleStatus, b.field(sample, 'status'), types.sampleStatus.members.floating),
        () => 1,
        () => 0,
      ),
    );
  });
  const translate = ({ pc, code }, block) => {
    const opcode = code[pc];
    const operand =
      (code[pc + 1] | (code[pc + 2] << 8) | (code[pc + 3] << 16) | (code[pc + 4] << 24)) >>> 0;
    const nextPc = pc + BYTES_PER_INSTRUCTION;
    block.instruction({ pc, nextPc }, (b) => {
      const dynamic = () => b.readState('addr', types.number);
      switch (opcode) {
        case OP.setAcc:
          b.writeState('acc', b.constant(types.number, operand));
          break;
        case OP.setAddr:
          b.writeState('addr', b.constant(types.number, operand));
          break;
        case OP.store32:
          access.emitStore(b, operand, b.readState('acc', types.number), 4);
          break;
        case OP.store32dyn:
          access.emitStore(b, dynamic(), b.readState('acc', types.number), 4);
          break;
        case OP.load32:
          b.writeState('acc', access.emitLoad(b, operand, 4));
          break;
        case OP.load32dyn:
          b.writeState('acc', access.emitLoad(b, dynamic(), 4));
          break;
        case OP.load16dyn:
          b.writeState('acc', access.emitLoad(b, dynamic(), 2));
          break;
        case OP.load8dyn:
          b.writeState('acc', access.emitLoad(b, dynamic(), 1));
          break;
        case OP.store16dyn:
          access.emitStore(b, dynamic(), b.readState('acc', types.number), 2);
          break;
        case OP.store8dyn:
          access.emitStore(b, dynamic(), b.readState('acc', types.number), 1);
          break;
        case OP.delay:
          b.elapse(operand * cyclePs);
          break;
        case OP.halt:
          b.stop();
          break;
        default:
          throw new Error(`Invalid test opcode ${opcode} at ${pc}`);
      }
      if (opcode !== OP.halt && opcode !== OP.delay) b.redirect(nextPc, cyclePs);
    });
    return block.finish();
  };
  const model = d.finish();
  const messages = [];
  const contexts = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'mcu',
      model,
      create(context) {
        contexts.push(context);
        context.attachJit({ entry: 'cpu', code: 'code', pc: 'pc', translate });
        return {
          sync(batch) {
            for (const message of batch.outputs.gpioChanged ?? []) messages.push(message.value);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = sdk.createBoard(library, {
    instances: [{ id: 'mcu', type: 'mcu' }],
    nets: [
      { id: 'supply', voltage: 3.3, pins: [{ instance: 'mcu', pin: 'supply' }] },
      { id: 'reference', voltage: 0, pins: [{ instance: 'mcu', pin: 'reference' }] },
      { id: 'pa5', pins: [{ instance: 'mcu', pin: 'pa5' }] },
    ],
  });
  const context = () => contexts.at(-1);
  const snapshot = () => {
    context().inputs.snapshotRequest.notify();
    board.runUntil(board.time);
    const bytes = Uint8Array.from(context().memory.snapshot);
    const view = new DataView(bytes.buffer);
    return {
      acc: view.getUint32(ACC, true),
      odr: view.getUint32(ODR, true),
      moder: view.getUint32(MODER, true),
      ticks: view.getUint32(TICKS, true),
      countflag: view.getUint32(COUNTFLAG, true),
      irq: view.getUint32(IRQ, true),
      level: view.getUint32(LEVEL, true),
      status: view.getUint32(STATUS, true),
    };
  };
  return {
    board,
    messages,
    model,
    load: (bytes) => context().loadBytes('code', Uint8Array.from(bytes)),
    snapshot,
    ram: () => Uint8Array.from(context().memory.ram),
  };
}

test('exports a complete peripheral state description', () => {
  assert.deepEqual(snapshotStateNames, Object.keys(busInitialState));
  for (const name of [
    'gpioModer',
    'gpioOdr',
    'rccAhb2enr',
    'systickCtrl',
    'systickReload',
    'systickCountflag',
    'systickTicks',
    'irqPending',
    'vtor',
  ])
    assert.ok(name in busInitialState, `missing ${name}`);
  assert.equal(typeof busInitialState.irqPending, 'boolean');
  for (const [name, value] of Object.entries(busInitialState))
    if (name !== 'irqPending') assert.equal(typeof value, 'number', `${name} must be a number`);
  assert.equal(busInitialState.vtor, FLASH_BASE);
  assert.equal(MMIO.gpioModer, GPIOA_BASE);
  assert.equal(MMIO.rccAhb2enr, RCC_AHB2ENR);
  assert.equal(MMIO.systickCtrl, SYSTICK_BASE);
  assert.equal(MMIO.scbVtor, SCB_VTOR);
  assert.equal(GPIO_DRIVE.floating, 2);
});

test('rejects unsupported widths, addresses and access profiles at construction time', () => {
  assert.throws(() => createBusAccess({ memoryAccess: 'words' }), /memoryAccess/);
  assert.throws(() => registerBus(createDeviceBuilder(), { cyclePs: 0 }), /cyclePs/);
  assert.throws(() => registerBus(createDeviceBuilder(), { frame: 1 }), /Unknown bus option/);
  // A literal address decodes at construction time, so these never reach the IR.
  assert.throws(() => emitLoad({}, SRAM_BASE, 3), /width 3/);
  assert.throws(() => emitLoad({}, 0x12345678, 4), /Unmapped STM32G431 bus read/);
  assert.throws(() => emitStore({}, FLASH_BASE + 8, {}, 4), /Flash is read-only/);
  assert.throws(
    () => emitLoad({}, FLASH_BASE + FLASH_SIZE - 2, 4),
    /crosses the end of the region/,
  );
  assert.throws(() => emitLoad({}, MMIO.gpioOdr + 2, 4), /must be an aligned 32-bit access/);
  assert.throws(() => emitLoad({}, MMIO.gpioOdr, 2), /must be an aligned 32-bit access/);
  assert.throws(() => emitStore({}, MMIO.gpioOdr + 1, {}, 4), /must be an aligned 32-bit/);
});

for (const memoryAccess of ['bytes', 'wide']) {
  test(`${memoryAccess} profile: little-endian word store/load in SRAM`, () => {
    const mcu = createModel({ memoryAccess });
    mcu.load(
      program(
        op(OP.setAcc, 0x11223344),
        op(OP.store32, SRAM_BASE + 4),
        op(OP.load32, SRAM_BASE + 4),
        op(OP.halt),
      ),
    );
    mcu.board.runUntil(at(5));
    assert.deepEqual(Array.from(mcu.ram().slice(4, 8)), [0x44, 0x33, 0x22, 0x11]);
    assert.equal(mcu.snapshot().acc, 0x11223344);
  });

  test(`${memoryAccess} profile: unaligned word and half-word accesses stay byte-ordered`, () => {
    const mcu = createModel({ memoryAccess });
    mcu.load(
      program(
        op(OP.setAcc, 0xdeadbeef),
        op(OP.store32, SRAM_BASE + 1),
        op(OP.load32, SRAM_BASE + 1),
        op(OP.setAddr, SRAM_BASE + 7),
        op(OP.setAcc, 0xcafe),
        op(OP.store16dyn),
        op(OP.load16dyn),
        op(OP.setAddr, SRAM_BASE + 9),
        op(OP.setAcc, 0x12345678),
        op(OP.store8dyn),
        op(OP.load8dyn),
        op(OP.halt),
      ),
    );
    mcu.board.runUntil(at(13));
    const bytes = mcu.ram();
    assert.deepEqual(Array.from(bytes.slice(0, 5)), [0, 0xef, 0xbe, 0xad, 0xde]);
    assert.deepEqual(Array.from(bytes.slice(7, 9)), [0xfe, 0xca]);
    assert.equal(bytes[9], 0x78, 'byte stores wrap to the low byte');
    assert.equal(mcu.snapshot().acc, 0x78, 'byte loads are unsigned');
  });

  test(`${memoryAccess} profile: unaligned Flash reads are allowed`, () => {
    const mcu = createModel({ memoryAccess });
    const code = withData(
      program(op(OP.load32, FLASH_BASE + 65), op(OP.halt)),
      64,
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    mcu.load(code);
    mcu.board.runUntil(at(3));
    assert.equal(mcu.snapshot().acc, 0x05040302);
  });
}

test('dynamic decode maps SRAM, Flash and MMIO and fails fast elsewhere', () => {
  const sram = createModel();
  sram.load(
    program(
      op(OP.setAddr, SRAM_BASE + 9),
      op(OP.setAcc, 0x55),
      op(OP.store8dyn),
      op(OP.load8dyn),
      op(OP.halt),
    ),
  );
  sram.board.runUntil(at(7));
  assert.equal(sram.snapshot().acc, 0x55);

  const flash = createModel();
  flash.load(
    withData(
      program(op(OP.setAddr, FLASH_BASE + 66), op(OP.load8dyn), op(OP.halt)),
      64,
      [1, 2, 3, 4, 5, 6, 7, 8],
    ),
  );
  flash.board.runUntil(at(4));
  assert.equal(flash.snapshot().acc, 3);

  const unmapped = createModel();
  unmapped.load(program(op(OP.setAddr, 0x12345678), op(OP.load32dyn), op(OP.halt)));
  assert.throws(() => unmapped.board.runUntil(at(4)), /unmapped read/);
  assert.equal(unmapped.board.status, 'faulted');

  const crossing = createModel();
  crossing.load(program(op(OP.setAddr, SRAM_BASE + SRAM_SIZE - 2), op(OP.load32dyn), op(OP.halt)));
  assert.throws(() => crossing.board.runUntil(at(4)), /crosses the end of the region/);

  const crossingWrite = createModel();
  crossingWrite.load(
    program(
      op(OP.setAddr, SRAM_BASE + SRAM_SIZE - 1),
      op(OP.setAcc, 1),
      op(OP.store16dyn),
      op(OP.halt),
    ),
  );
  assert.throws(() => crossingWrite.board.runUntil(at(6)), /write crosses the end/);

  const flashWrite = createModel();
  flashWrite.load(program(op(OP.setAcc, 1), op(OP.store32, FLASH_BASE + 0x40), op(OP.halt)));
  assert.throws(() => flashWrite.board.runUntil(at(4)), /Flash is read-only/);

  const flashWriteDynamic = createModel();
  flashWriteDynamic.load(
    program(op(OP.setAddr, FLASH_BASE + 0x40), op(OP.setAcc, 1), op(OP.store32dyn), op(OP.halt)),
  );
  assert.throws(() => flashWriteDynamic.board.runUntil(at(6)), /Flash: writes are not modelled/);
});

test('MMIO only accepts aligned 32-bit accesses', () => {
  const narrow = createModel();
  narrow.load(program(op(OP.setAddr, MMIO.gpioOdr), op(OP.load16dyn), op(OP.halt)));
  assert.throws(() => narrow.board.runUntil(at(4)), /32-bit access/);

  const unaligned = createModel();
  unaligned.load(program(op(OP.setAddr, MMIO.gpioOdr + 1), op(OP.load32dyn), op(OP.halt)));
  assert.throws(() => unaligned.board.runUntil(at(4)), /is unaligned/);

  const unalignedWrite = createModel();
  unalignedWrite.load(
    program(op(OP.setAddr, MMIO.gpioModer + 2), op(OP.setAcc, 1), op(OP.store32dyn), op(OP.halt)),
  );
  assert.throws(() => unalignedWrite.board.runUntil(at(6)), /is unaligned/);
});

test('GPIOA registers are gated by RCC_AHB2ENR', () => {
  const mcu = createModel();
  mcu.load(
    program(
      // Clock still off: the ODR write is dropped and nothing is published.
      op(OP.setAcc, 0x20),
      op(OP.store32, MMIO.gpioOdr),
      op(OP.load32, MMIO.gpioOdr),
      op(OP.halt),
    ),
  );
  mcu.board.runUntil(at(5));
  assert.deepEqual(mcu.messages, []);
  const gated = mcu.snapshot();
  assert.equal(gated.odr, 0);
  assert.equal(gated.acc, 0, 'a gated register reads as zero');
});

test('GPIOA ODR and BSRR update the latch, and set wins over reset', () => {
  const odr = createModel();
  odr.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0xffffe7ff),
      op(OP.store32, MMIO.gpioModer),
      op(OP.setAcc, 0x20),
      op(OP.store32, MMIO.gpioOdr),
      op(OP.halt),
    ),
  );
  odr.board.runUntil(at(8));
  assert.deepEqual(odr.messages, [0x20]);
  const snapshot = odr.snapshot();
  assert.equal(snapshot.odr, 0x20);
  assert.equal(snapshot.moder, 0xffffe7ff);
  assert.equal(snapshot.level, 1, 'PA5 is driven high by the ODR latch');
  assert.equal(snapshot.status, 0);

  const set = createModel();
  set.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0x0020),
      op(OP.store32, MMIO.gpioBsrr),
      op(OP.halt),
    ),
  );
  set.board.runUntil(at(6));
  assert.equal(set.snapshot().odr, 0x20);
  assert.deepEqual(set.messages, [0x20]);

  const both = createModel();
  both.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0x0020),
      op(OP.store32, MMIO.gpioBsrr),
      // Set (low half) and reset (high half) in one write: set wins.
      op(OP.setAcc, 0x00200020),
      op(OP.store32, MMIO.gpioBsrr),
      op(OP.halt),
    ),
  );
  both.board.runUntil(at(8));
  assert.equal(both.snapshot().odr, 0x20, 'BSRR set wins over reset');
  assert.deepEqual(both.messages, [0x20, 0x20]);

  const reset = createModel();
  reset.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0x0020),
      op(OP.store32, MMIO.gpioBsrr),
      op(OP.setAcc, 0x00200000),
      op(OP.store32, MMIO.gpioBsrr),
      op(OP.halt),
    ),
  );
  reset.board.runUntil(at(8));
  assert.equal(reset.snapshot().odr, 0);
  assert.deepEqual(reset.messages, [0x20, 0]);
});

test('PA5 drive follows MODER and the clock gate, not only the ODR latch', () => {
  const driven = createModel();
  driven.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0xffffe7ff),
      op(OP.store32, MMIO.gpioModer),
      op(OP.setAcc, 0x20),
      op(OP.store32, MMIO.gpioOdr),
      op(OP.halt),
    ),
  );
  driven.board.runUntil(at(8));
  assert.equal(driven.snapshot().level, 1);

  const released = createModel();
  released.load(
    program(
      op(OP.setAcc, 1),
      op(OP.store32, MMIO.rccAhb2enr),
      op(OP.setAcc, 0xffffe7ff),
      op(OP.store32, MMIO.gpioModer),
      op(OP.setAcc, 0x20),
      op(OP.store32, MMIO.gpioOdr),
      // Back to the reset (alternate function) mode: the pin must float again.
      op(OP.setAcc, 0xffffebff),
      op(OP.store32, MMIO.gpioModer),
      op(OP.halt),
    ),
  );
  released.board.runUntil(at(10));
  const snapshot = released.snapshot();
  assert.equal(snapshot.odr, 0x20);
  assert.equal(snapshot.status, 1, 'PA5 floats again after the mode change');
});

test('SysTick reloads exactly (reload + 1) cycles after the enabling write', () => {
  const mcu = createModel();
  mcu.load(
    program(
      op(OP.setAcc, 99),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 0),
      op(OP.store32, MMIO.systickVal),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.halt),
    ),
  );
  const enableTime = at(5);
  const period = 100 * DEFAULT_CYCLE_PS;
  mcu.board.runUntil(enableTime + period - 1);
  assert.equal(mcu.snapshot().ticks, 0, 'no reload one picosecond early');
  assert.equal(mcu.snapshot().irq, 0);
  mcu.board.runUntil(enableTime + period);
  assert.equal(mcu.snapshot().ticks, 1);
  assert.equal(mcu.snapshot().irq, 1, 'TICKINT raises the pending exception');
  assert.equal(mcu.snapshot().countflag, 1);
  mcu.board.runUntil(enableTime + 2 * period);
  assert.equal(mcu.snapshot().ticks, 2);
  mcu.board.runUntil(enableTime + 3 * period);
  assert.equal(mcu.snapshot().ticks, 3);
});

test('SysTick honours a LOAD written after the first reload', () => {
  const mcu = createModel();
  mcu.load(
    program(
      op(OP.setAcc, 9),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 12),
      op(OP.setAcc, 19),
      op(OP.store32, MMIO.systickLoad),
      op(OP.halt),
    ),
  );
  // Enable at 3 cycles, reload at 13 cycles, the LOAD write lands at 17 cycles.
  mcu.board.runUntil(at(3) + 10 * DEFAULT_CYCLE_PS);
  assert.equal(mcu.snapshot().ticks, 1);
  mcu.board.runUntil(at(3) + 30 * DEFAULT_CYCLE_PS);
  assert.equal(mcu.snapshot().ticks, 2, 'the reload is 20 cycles after the previous one');
});

test('SysTick COUNTFLAG is visible on a CTRL read and cleared by it', () => {
  const mcu = createModel();
  mcu.load(
    program(
      op(OP.setAcc, 9),
      op(OP.store32, MMIO.systickLoad),
      // CLKSOURCE | ENABLE: reloads without an exception request.
      op(OP.setAcc, 5),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 12),
      op(OP.load32, MMIO.systickCtrl),
      op(OP.halt),
    ),
  );
  mcu.board.runUntil(at(4) + 14 * DEFAULT_CYCLE_PS);
  const snapshot = mcu.snapshot();
  assert.equal(snapshot.ticks, 1);
  assert.equal(snapshot.irq, 0, 'TICKINT is clear');
  assert.equal(snapshot.acc, 0x10005, 'CTRL read reports COUNTFLAG in bit 16');
  mcu.board.runUntil(mcu.board.time + 1);
  assert.equal(mcu.snapshot().countflag, 0, 'COUNTFLAG was cleared by the read');
});

test('SysTick pending survives masking and SCB ICSR PENDSTCLR clears it', () => {
  const pending = createModel();
  pending.load(
    program(
      op(OP.setAcc, 4),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 10),
      op(OP.load32, SCB_ICSR),
      op(OP.halt),
    ),
  );
  pending.board.runUntil(at(4) + 12 * DEFAULT_CYCLE_PS);
  const snapshot = pending.snapshot();
  assert.equal(snapshot.irq, 1, 'the pending exception stays set without a CPU');
  assert.equal(snapshot.acc, 0x04000000, 'ICSR reports PENDSTSET');

  const cleared = createModel();
  cleared.load(
    program(
      op(OP.setAcc, 9),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 10),
      op(OP.setAcc, 0x02000000),
      op(OP.store32, SCB_ICSR),
      op(OP.halt),
    ),
  );
  cleared.board.runUntil(at(4) + 14 * DEFAULT_CYCLE_PS);
  assert.equal(cleared.snapshot().irq, 0);

  const setAgain = createModel();
  setAgain.load(program(op(OP.setAcc, 0x04000000), op(OP.store32, SCB_ICSR), op(OP.halt)));
  setAgain.board.runUntil(at(4));
  assert.equal(setAgain.snapshot().irq, 1, 'PENDSTSET sets the pending exception');
});

test('SysTick stops when disabled and restarts from the next enabling write', () => {
  const disabled = createModel();
  disabled.load(
    program(
      op(OP.setAcc, 9),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.setAcc, 0),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.halt),
    ),
  );
  disabled.board.runUntil(200 * DEFAULT_CYCLE_PS);
  assert.equal(disabled.snapshot().ticks, 0, 'disabled before the first reload');

  const reenabled = createModel();
  reenabled.load(
    program(
      op(OP.setAcc, 9),
      op(OP.store32, MMIO.systickLoad),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 10),
      op(OP.setAcc, 0),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.delay, 10),
      op(OP.setAcc, 7),
      op(OP.store32, MMIO.systickCtrl),
      op(OP.halt),
    ),
  );
  // Enable at 3 cycles, reload at 13, disable at 15, enable at 27, reload at 37.
  reenabled.board.runUntil(at(3) + 33 * DEFAULT_CYCLE_PS);
  assert.equal(reenabled.snapshot().ticks, 1);
  reenabled.board.runUntil(at(3) + 34 * DEFAULT_CYCLE_PS);
  assert.equal(reenabled.snapshot().ticks, 2, 'the restart counts a full period again');
});

test('VTOR resets to Flash and is writable; other SCB addresses stay unmapped', () => {
  const mcu = createModel();
  mcu.load(
    program(
      op(OP.setAcc, SRAM_BASE),
      op(OP.store32, SCB_VTOR),
      op(OP.load32, SCB_VTOR),
      op(OP.halt),
    ),
  );
  mcu.board.runUntil(at(5));
  assert.equal(mcu.snapshot().acc, SRAM_BASE);

  const unmapped = createModel();
  unmapped.load(program(op(OP.load32, SCB_VTOR + 0x100), op(OP.halt)));
  assert.throws(() => unmapped.board.runUntil(at(3)), /Unmapped STM32G431/);
});

/** Every `kind` in an instruction body, including nested regions and computations. */
function kinds(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) kinds(item, found);
    return found;
  }
  if (typeof value.kind === 'string') found.add(value.kind);
  for (const [key, item] of Object.entries(value)) if (key !== 'source') kinds(item, found);
  return found;
}

function emitAccessOps(model, access, emit) {
  const block = createJitBlockBuilder({ device: model });
  block.instruction({ pc: 0, nextPc: 1 }, (b) => {
    emit(b, access);
    b.redirect(1, DEFAULT_CYCLE_PS);
  });
  return kinds(block.finish().instructions[0].body.operations);
}

test('memoryAccess profiles emit canonical IR, never host emulation', () => {
  const { model } = createModel();
  const bytes = createBusAccess({ memoryAccess: 'bytes' });
  const wide = createBusAccess({ memoryAccess: 'wide' });

  const byteLoad = emitAccessOps(model, bytes, (b, access) =>
    b.writeState('acc', access.emitLoad(b, SRAM_BASE + 4, 4)),
  );
  assert.ok(byteLoad.has('load8'), 'the bytes profile assembles from byte loads');
  assert.ok(!byteLoad.has('load32le'), 'the bytes profile never uses a wide load');

  const wideLoad = emitAccessOps(model, wide, (b, access) =>
    b.writeState('acc', access.emitLoad(b, SRAM_BASE + 4, 4)),
  );
  assert.ok(wideLoad.has('load32le'), 'the wide profile uses the canonical word load');
  assert.ok(!wideLoad.has('load8'));

  const byteStore = emitAccessOps(model, bytes, (b, access) =>
    access.emitStore(b, SRAM_BASE + 4, b.readState('acc', types.number), 4),
  );
  assert.ok(byteStore.has('store8'));
  assert.ok(!byteStore.has('store32le'));

  const wideStore = emitAccessOps(model, wide, (b, access) =>
    access.emitStore(b, SRAM_BASE + 4, b.readState('acc', types.number), 4),
  );
  assert.ok(wideStore.has('store32le'));

  const halfWord = emitAccessOps(model, wide, (b, access) =>
    b.writeState('acc', access.emitLoad(b, SRAM_BASE + 2, 2)),
  );
  assert.ok(halfWord.has('load16le'));

  // A literal MMIO read decodes at construction time into register reads.
  const mmio = emitAccessOps(model, bytes, (b, access) =>
    b.writeState('acc', access.emitLoad(b, MMIO.gpioOdr, 4)),
  );
  assert.ok(mmio.has('read'));
  assert.ok(!mmio.has('if'), 'literal MMIO needs no address branch');

  // A dynamic address decodes through IR branches with fail-fast assertions.
  const dynamic = emitAccessOps(model, bytes, (b, access) =>
    b.writeState('acc', access.emitLoad(b, b.readState('addr', types.number), 4)),
  );
  assert.ok(dynamic.has('if'));
  assert.ok(dynamic.has('assert'));
  assert.ok(dynamic.has('local'));
  assert.ok(dynamic.has('load8'));
});
