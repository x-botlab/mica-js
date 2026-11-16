import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { inlineFusedCalls } from './fused-inline';

/** Fixed CT117E wiring, internal to one device; no inter-device electrical nets. */
export const FUSED_WIRES = [
  ...Array.from({ length: 16 }, (_, bit) => `PC${bit}`),
  'PB5',
  'PB8',
  'PB9',
  'PA8',
] as const;
const LCD_WIRES = [...Array.from({ length: 16 }, (_, bit) => `D${bit}`), 'WR', 'RS', 'CS', 'RD'];
const ROOT = resolve(import.meta.dirname, '..', '..');
let modelPromise: Promise<DeviceIR> | undefined;
export const FUSED_FRAME_PC = 0x20050;
const frameBuilder = createJitBlockBuilder();
frameBuilder.instruction({ pc: FUSED_FRAME_PC, nextPc: FUSED_FRAME_PC }, (b) => {
  b.writeState(
    'frameSeq',
    b.add(b.readState('frameSeq', types.number), b.constant(types.number, 1)),
  );
  b.writeState('pc', b.readState('fusedFrameResume', types.number));
  b.elapse(b.readState('fusedFrameDelay', types.number));
});
export const FUSED_FRAME_BLOCK = frameBuilder.finish();

function body(source: string): string {
  const start = source.indexOf('{', source.indexOf('\ndevice '));
  if (start < 0 || source.trimEnd().at(-1) !== '}') throw new Error('Invalid device source');
  return source.slice(start + 1, source.lastIndexOf('}'));
}

/** Assemble source, rather than copying the evolving CPU/LCD implementations. */
export function fusedSource(): string {
  const mcu = body(
    readFileSync(resolve(ROOT, 'src', 'devices', 'stm32g431rbt6', 'model.ddl'), 'utf8'),
  );
  let lcd = body(readFileSync(resolve(ROOT, 'src/devices/ili9325/model.ddl'), 'utf8'));
  // LCD pins become internal wires. Keep its register/GRAM/address/frame code unchanged.
  lcd = lcd.replace(/^ {2}pin \w+(?:\([^;]*\))?;$/gm, '');
  lcd = lcd.replace(
    / {2}fn driveBit\([\s\S]*?(?= {2}fn clearGram\()/,
    `
  fn driveData(value: number) {
    fusedReadValue = value;
    fusedReading = true;
  }
  fn releaseData() { fusedReading = false; }

`,
  );
  lcd = lcd.replace(/ {2}process start \{\s*reset\(false\);\s*\}/, '');
  lcd = lcd.replace(/ {2}reaction writeLatch[\s\S]*?(?= {2}\/\*\*\n {3}\* 合帧发布)/, '');
  // Turn the pixel-path early return into an equivalent if/else, so the complete original
  // writeData body can be expanded into the JIT without a function-return control edge.
  const pixelTail = '      return;\n    }\n\n    store16le(regs';
  if (!lcd.includes(pixelTail)) throw new Error('LCD writeData shape changed');
  lcd = lcd.replace(pixelTail, '    } else {\n    store16le(regs');
  const dataEnd = lcd.indexOf('\n  /** 读周期返回的值');
  if (dataEnd < 0) throw new Error('LCD readValue boundary changed');
  lcd = `${lcd.slice(0, dataEnd)}\n  }${lcd.slice(dataEnd)}`;
  lcd = lcd.replace(/\bRST\.sample\.level\b/g, '1');
  for (const [index, pin] of LCD_WIRES.entries())
    lcd = lcd.replaceAll(`${pin}.sample.level`, `fusedWire${index}`);
  lcd = lcd.replaceAll('Logic.low', '0').replaceAll('Logic.high', '1');
  const readStart = lcd.indexOf('  fn readValue()');
  const readEnd = lcd.indexOf('  fn driveData(');
  if (readStart < 0 || readEnd < readStart) throw new Error('LCD readValue shape changed');
  let reader = lcd.slice(readStart, readEnd);
  reader = reader.replaceAll('    if index', '    else if index');
  reader = reader.replace(/\breturn ([^;]+);/g, 'fusedResult = $1;');
  reader = reader.replace('-> number {', '-> number {\n    let fusedResult = 0;');
  const readerClose = reader.lastIndexOf('  }');
  reader = `${reader.slice(0, readerClose)}    return fusedResult;\n${reader.slice(readerClose)}`;
  // The generic register read is the final else arm, not an unconditional overwrite.
  reader = reader.replace(
    '    fusedResult = load16le(regs, index * 2);',
    '    else { fusedResult = load16le(regs, index * 2); }',
  );
  lcd = lcd.slice(0, readStart) + reader + lcd.slice(readEnd);
  lcd = lcd.replaceAll('frameSeq = frameSeq + 1;', 'fusedFramePending = true;');
  lcd = lcd.replace(
    'store16le(gram, (x * stride + column) * 2, value);',
    `store16le(gram, (x * stride + column) * 2, value);
        fusedGramStores = fusedGramStores + 1;`,
  );
  const states = FUSED_WIRES.map((_, bit) => `state fusedWire${bit}: number = -1;`).join('\n');
  const levels = FUSED_WIRES.map(
    (_, bit) =>
      `wire == ${bit} ? ${bit < 16 ? `(fusedReading ? (fusedReadValue >> ${bit}) & 1 : fusedWire${bit})` : `fusedWire${bit}`} :`,
  ).join('\n');
  return `device Stm32Lcd(firmware: bytes default bytes[],
    clockFrequency: number default 80000000, refreshRate: number default 60) {
    ${mcu.replace('process start {', 'process start { reset(false);')}
    ${lcd}
    ${states}
    state fusedWrChanges: number = 0;
    state fusedWrites: number = 0;
    state fusedReading: bool = false;
    state fusedReadValue: number = 0;
    state fusedGramStores: number = 0;
    state fusedFramePending: bool = false;
    state fusedFrameResume: number = 0;
    state fusedFrameDelay: number = 0;
    fn fusedWr(previous: number) {
      const next = fusedWire16;
      if previous != next { fusedWrChanges = fusedWrChanges + 1; }
      if previous == 0 && next == 1 && fusedWire18 == 0 {
        fusedWrites = fusedWrites + 1;
        if fusedWire17 == 0 { writeCommand(dataBus()); }
        else { writeData(dataBus()); }
      }
    }
    fn fusedLevel(wire: number) -> number {
      return ${levels} -1;
    }
    fn fusedReadWindow() {
        const active = fusedWire18 == 0 && fusedWire19 == 0;
        if active && !fusedReading { driveData(readValue()); }
        else if !active && fusedReading { releaseData(); }
    }
  }`;
}

export function loadFusedModel(): Promise<DeviceIR> {
  return (modelPromise ??= compileDDL(fusedSource(), { uri: 'mica:bench/stm32-lcd-fused.ddl' }));
}

const fusedBlocks = new WeakMap<BlockIR, BlockIR>();

/**
 * GPIO's actual mode/pull/open-drain selection stays in the original translator. Only the
 * final resistor-to-rail intent is lowered to an ideal internal digital level. This fixture
 * has fixed 3.3 V power and one bus master; analog contention is outside its contract.
 */
export function fuseBlock(block: BlockIR, model: DeviceIR): BlockIR {
  const cached = fusedBlocks.get(block);
  if (cached) return cached;
  let next = 0;
  let needsFusion = false;
  const scan = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const op = value as OperationIR;
    if (
      op.kind === 'writeIntent' ||
      (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1')
    )
      needsFusion = true;
    if ('result' in value && typeof value.result === 'number')
      next = Math.max(next, value.result + 1);
    for (const entry of Object.values(value)) scan(entry);
  };
  scan(block);
  if (!needsFusion) {
    fusedBlocks.set(block, block);
    return block;
  }
  let touched = new Set<number>();
  const transform = (value: unknown, samples: Map<number, string>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.flatMap((entry) => {
        const result = transform(entry, samples);
        return result === undefined ? [] : Array.isArray(result) ? result : [result];
      });
    const op = value as OperationIR;
    if (op.kind === 'readSample' && op.pin.kind === 'pin' && op.pin.name !== 'VDD1') {
      samples.set(op.result, op.pin.name);
      return undefined;
    }
    if (op.kind === 'field' && samples.has(op.value)) {
      if (op.field !== 'level') throw new Error('Fused GPIO only supports digital samples');
      const pin = next++;
      return [
        {
          kind: 'constant',
          result: pin,
          type: { kind: 'number' },
          constant: { kind: 'number', value: FUSED_WIRES.indexOf(samples.get(op.value)!) },
        },
        {
          kind: 'callValue',
          name: 'fusedLevel',
          pure: false,
          result: op.result,
          type: { kind: 'number' },
          args: [{ kind: 'value', value: pin }],
        },
      ];
    }
    if (op.kind === 'resistor') {
      if (op.to.kind !== 'pin' || !['VDD1', 'VSS1'].includes(op.to.name))
        throw new Error('Fused GPIO intent must refer to a supply rail');
      return {
        kind: 'constant',
        result: op.result,
        type: { kind: 'number' },
        constant: { kind: 'number', value: op.to.name === 'VDD1' ? 1 : 0 },
      };
    }
    if (op.kind === 'combineIntents') {
      if (op.values.length)
        throw new Error('Fused GPIO does not support parallel internal drivers');
      return {
        kind: 'constant',
        result: op.result,
        type: { kind: 'number' },
        constant: { kind: 'number', value: -1 },
      };
    }
    if (op.kind === 'writeIntent') {
      if (op.pin.kind !== 'pin') throw new Error('Fused GPIO requires a static pin');
      const index = FUSED_WIRES.indexOf(op.pin.name);
      if (index < 0) return undefined;
      touched.add(index);
      return { kind: 'write', resource: 'state', name: `fusedWire${index}`, value: op.value };
    }
    if (
      'kind' in value &&
      (value.kind === 'intent' ||
        (value.kind === 'enum' &&
          'name' in value &&
          value.name === 'Logic' &&
          !('member' in value)))
    )
      return { kind: 'number' };
    if (op.kind === 'constant' && op.constant.kind === 'enum' && op.constant.name === 'Logic')
      return {
        ...op,
        type: { kind: 'number' },
        constant: {
          kind: 'number',
          value: op.constant.member === 'high' ? 1 : op.constant.member === 'low' ? 0 : -1,
        },
      };
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, transform(entry, samples)]),
    );
  };
  const result: BlockIR = {
    ...block,
    instructions: block.instructions.map((instruction) => {
      touched = new Set();
      const transformed = transform(instruction.body, new Map()) as RegionIR;
      const last = transformed.operations.at(-1);
      if (last?.kind !== 'elapse') throw new Error('Fused MCU must end in elapse');
      const before = next++;
      const prefix: OperationIR[] = touched.has(16)
        ? [
            {
              kind: 'read',
              resource: 'state',
              name: 'fusedWire16',
              result: before,
              type: { kind: 'number' },
            },
          ]
        : [];
      const suffix: OperationIR[] = [];
      if (touched.has(16))
        suffix.push({
          kind: 'call',
          name: 'fusedWr',
          pure: false,
          args: [{ kind: 'value', value: before }],
        });
      if (touched.has(18) || touched.has(19))
        suffix.push({ kind: 'call', name: 'fusedReadWindow', pure: false, args: [] });
      const duration = transformed.operations.find(
        (op) => 'result' in op && op.result === last.duration,
      );
      if (!duration || !['constant', 'localRead'].includes(duration.kind))
        throw new Error('Unexpected MCU duration shape');
      const expanded = inlineFusedCalls(
        {
          operations: [
            ...prefix,
            ...transformed.operations.slice(0, -1).filter((op) => op !== duration),
            ...suffix,
            duration,
            last,
          ],
        },
        model,
      );
      let requestsFrame = false;
      const inspect = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (
          'kind' in value &&
          value.kind === 'write' &&
          'name' in value &&
          value.name === 'fusedFramePending'
        )
          requestsFrame = true;
        Object.values(value).forEach(inspect);
      };
      inspect(expanded);
      if (!requestsFrame) return { ...instruction, body: expanded };
      const tail = expanded.operations.at(-1);
      if (tail?.kind !== 'elapse') throw new Error('Fused MCU must end in elapse');
      scan(expanded);
      const pending = next++,
        zero = next++,
        delay = next++,
        resume = next++,
        pc = next++,
        no = next++;
      return {
        ...instruction,
        body: {
          operations: [
            ...expanded.operations.slice(0, -1),
            {
              kind: 'read',
              resource: 'state',
              name: 'fusedFramePending',
              type: { kind: 'bool' },
              result: pending,
            },
            {
              kind: 'constant',
              type: { kind: 'number' },
              constant: { kind: 'number', value: 0 },
              result: zero,
            },
            {
              kind: 'select',
              condition: pending,
              type: { kind: 'number' },
              result: delay,
              yes: {
                type: { kind: 'number' },
                body: { operations: [{ kind: 'yield', value: zero }] },
              },
              no: {
                type: { kind: 'number' },
                body: { operations: [{ kind: 'yield', value: tail.duration }] },
              },
            },
            {
              kind: 'if',
              condition: pending,
              yes: {
                operations: [
                  {
                    kind: 'write',
                    resource: 'state',
                    name: 'fusedFrameDelay',
                    value: tail.duration,
                  },
                  {
                    kind: 'read',
                    resource: 'state',
                    name: 'pc',
                    type: { kind: 'number' },
                    result: resume,
                  },
                  { kind: 'write', resource: 'state', name: 'fusedFrameResume', value: resume },
                  {
                    kind: 'constant',
                    type: { kind: 'number' },
                    constant: { kind: 'number', value: FUSED_FRAME_PC },
                    result: pc,
                  },
                  { kind: 'write', resource: 'state', name: 'pc', value: pc },
                  {
                    kind: 'constant',
                    type: { kind: 'bool' },
                    constant: { kind: 'bool', value: false },
                    result: no,
                  },
                  { kind: 'write', resource: 'state', name: 'fusedFramePending', value: no },
                ],
              },
            },
            { kind: 'elapse', duration: delay },
          ],
        },
      };
    }),
  };
  fusedBlocks.set(block, result);
  return result;
}
