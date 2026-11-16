import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileBody, compileSynchronousBody } from '../../../../packages/compiler/src/index';
import type { ExecutionHost, ReactionFrame } from '../../../../packages/compiler/src/types';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { RegionIR } from '@mica-js/sdk/model';

/**
 * ILI9325 的同步 reaction 编译集成测试。
 *
 * DDL 编译属于示例工程，不在 compiler 包内；这里用真实 model.ddl 验证
 * `writeLatch → dataBus → writeData` 与 `readWindow → readValue → driveData → driveBit`
 * 两条路径，并用记录型 host 对照 generator 后端。
 */

const source = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'devices', 'ili9325', 'model.ddl'),
  'utf8',
);
const model = await compileDDL(source, { uri: 'mica:test/ili9325-synchronous.ddl' });

const functions = new Map<string, RegionIR>(
  model.declarations.flatMap((declaration) =>
    declaration.kind === 'function' ? [[declaration.name, declaration.body] as const] : [],
  ),
);
const writeLatch = model.declarations.find(
  (declaration) => declaration.kind === 'reaction' && declaration.name === 'writeLatch',
);
const readWindow = model.declarations.find(
  (declaration) => declaration.kind === 'reaction' && declaration.name === 'readWindow',
);

interface Sample {
  readonly level: 'low' | 'high' | 'unknown';
  readonly voltage: number | null;
  readonly status: 'valid' | 'floating';
}

interface HostInitial {
  readonly states: Readonly<Record<string, unknown>>;
  readonly memories: Readonly<Record<string, Uint8Array>>;
  readonly samples: Readonly<Record<string, Sample>>;
  readonly constants: Readonly<Record<string, unknown>>;
  readonly allowCall: boolean;
  readonly bind?: boolean;
}

const HIGH: Sample = { level: 'high', voltage: 3.3, status: 'valid' };
const LOW: Sample = { level: 'low', voltage: 0, status: 'valid' };

type Entry = [string, ...unknown[]];

function makeHost(initial: HostInitial) {
  const state = new Map(Object.entries(initial.states));
  const memories = new Map(
    Object.entries(initial.memories).map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
  );
  const samples = new Map(Object.entries(initial.samples));
  const constants = new Map(Object.entries(initial.constants));
  const entries: Entry[] = [];

  const view = (name: string): { bytes: Uint8Array; view: DataView } => {
    const bytes = memories.get(name);
    if (bytes === undefined) throw new Error(`Unknown memory ${name}`);
    return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  };

  const host = {
    entries,
    state,
    memories,
    effects(): Entry[] {
      return entries.filter((entry) => entry[0] !== 'call');
    },
    read(kind: string, name: string): unknown {
      entries.push(['read', kind, name]);
      if (kind === 'const' || kind === 'property') {
        if (!constants.has(name)) throw new Error(`Unknown ${kind} ${name}`);
        return constants.get(name);
      }
      return state.get(name);
    },
    write(name: string, value: unknown): void {
      entries.push(['write', name, value]);
      if (!state.has(name)) throw new Error(`Unknown state ${name}`);
      state.set(name, value);
    },
    sample(pin: string): unknown {
      entries.push(['sample', pin]);
      const sample = samples.get(pin);
      if (sample === undefined) throw new Error(`Unknown pin ${pin}`);
      return sample;
    },
    intent(pin: string, value: unknown): void {
      entries.push(['intent', pin, value]);
    },
    resistor(pin: string, resistance: unknown): unknown {
      entries.push(['resistor', pin, resistance]);
      return [{ pin, resistance }];
    },
    load(kind: string, memory: string, offset: unknown): number {
      entries.push(['load', kind, memory, offset]);
      const bank = view(memory);
      const size = kind.startsWith('load8') ? 1 : kind.startsWith('load16') ? 2 : 4;
      const at = Number(offset);
      if (!Number.isInteger(at) || at < 0 || at + size > bank.bytes.length)
        throw new RangeError('Memory range is out of bounds');
      if (size === 1) return bank.bytes[at]!;
      return size === 2
        ? bank.view.getUint16(at, kind.endsWith('le'))
        : bank.view.getUint32(at, kind.endsWith('le'));
    },
    store(kind: string, memory: string, offset: unknown, value: unknown): void {
      entries.push(['store', kind, memory, offset, value]);
      const bank = view(memory);
      const size = kind.startsWith('store8') ? 1 : kind.startsWith('store16') ? 2 : 4;
      const at = Number(offset);
      if (!Number.isInteger(at) || at < 0 || at + size > bank.bytes.length)
        throw new RangeError('Memory range is out of bounds');
      if (size === 1) bank.bytes[at] = Number(value);
      else if (size === 2) bank.view.setUint16(at, Number(value), kind.endsWith('le'));
      else bank.view.setUint32(at, Number(value), kind.endsWith('le'));
    },
    copyBytes(memory: string, offset: unknown, length: unknown): Uint8Array {
      entries.push(['copyBytes', memory, offset, length]);
      return view(memory).bytes.slice(Number(offset), Number(offset) + Number(length));
    },
    memoryLength(memory: string): number {
      entries.push(['memoryLength', memory]);
      return view(memory).bytes.length;
    },
    send(name: string, value: unknown): void {
      entries.push(['send', name, value]);
    },
    notify(name: string): void {
      entries.push(['notify', name]);
    },
    now(): number {
      entries.push(['now']);
      return 11;
    },
    random(): number {
      entries.push(['random']);
      return 0.5;
    },
    assert(condition: unknown, message: unknown): void {
      entries.push(['assert', condition, message]);
      if (condition !== true)
        throw new Error(message === undefined ? 'Assertion failed' : String(message));
    },
    call(name: string, args: readonly unknown[]) {
      entries.push(['call', name]);
      if (!initial.allowCall) throw new Error(`Unexpected host.call ${name}`);
      const body = functions.get(name);
      if (body === undefined) throw new Error(`Unknown function ${name}`);
      return compileBody(body)(host as unknown as ExecutionHost, args);
    },
    bind(specs: readonly (readonly [string, string])[]) {
      return specs.map(([kind, name]) => {
        if (kind === 'state') {
          return {
            read: () => host.read('state', name),
            write: (value: unknown) => host.write(name, value),
          };
        }
        if (kind === 'pin') {
          return {
            sample: () => host.sample(name),
            intent: (value: unknown) => host.intent(name, value),
            resistor: (resistance: unknown) => host.resistor(name, resistance),
          };
        }
        return {
          load8: (offset: unknown) => host.load('load8', name, offset),
          load16le: (offset: unknown) => host.load('load16le', name, offset),
          load16be: (offset: unknown) => host.load('load16be', name, offset),
          load32le: (offset: unknown) => host.load('load32le', name, offset),
          load32be: (offset: unknown) => host.load('load32be', name, offset),
          store8: (offset: unknown, value: unknown) => host.store('store8', name, offset, value),
          store16le: (offset: unknown, value: unknown) =>
            host.store('store16le', name, offset, value),
          store16be: (offset: unknown, value: unknown) =>
            host.store('store16be', name, offset, value),
          store32le: (offset: unknown, value: unknown) =>
            host.store('store32le', name, offset, value),
          store32be: (offset: unknown, value: unknown) =>
            host.store('store32be', name, offset, value),
          length: () => host.memoryLength(name),
          copy: (offset: unknown, length: unknown) => host.copyBytes(name, offset, length),
        };
      });
    },
  };

  if (initial.bind === false) delete (host as { bind?: unknown }).bind;

  return host;
}

const highBits = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`D${index}`, HIGH]));

function lcdHost(
  rs: Sample,
  options: {
    readonly index?: number;
    readonly addrY?: number;
    readonly memory?: Uint8Array;
    readonly allowCall: boolean;
    readonly bind?: boolean;
  },
) {
  return makeHost({
    states: {
      index: options.index ?? 0x22,
      entryMode: 0x1018,
      addrX: 0,
      addrY: options.addrY ?? 0,
      windowX0: 0,
      windowX1: 239,
      windowY0: 0,
      windowY1: 319,
      dirty: false,
      dirtyX0: 0,
      dirtyX1: 0,
      dirtyY0: 0,
      dirtyY1: 0,
      scheduled: false,
      frameSeq: 0,
    },
    memories: {
      gram: options.memory ?? new Uint8Array(320 * 240 * 2),
      regs: new Uint8Array(512),
    },
    samples: { CS: LOW, RST: HIGH, RS: rs, ...highBits },
    constants: { PANEL_WIDTH: 320, GRAM_WIDTH: 240, GRAM_HEIGHT: 320 },
    allowCall: options.allowCall,
    ...(options.bind === undefined ? {} : { bind: options.bind }),
  });
}

describe('synchronous reaction compilation with the real ILI9325 model', () => {
  it('compiles writeLatch → dataBus → writeData without host.call', () => {
    expect(writeLatch?.kind).toBe('reaction');
    if (writeLatch?.kind !== 'reaction') return;
    const program = compileSynchronousBody(writeLatch.body, {
      resolveFunction: (name) => functions.get(name),
      bindResources: true,
    });
    expect(program).toBeTruthy();
    expect(program!.source.includes('host.call')).toBe(false);

    const frame: ReactionFrame = { previous: 'low', current: 'high', captures: [] };
    const genericHost = lcdHost(HIGH, { allowCall: true });
    const generic = compileBody(writeLatch.body)(
      genericHost as unknown as ExecutionHost,
      [],
      frame,
    );
    expect(generic.next().done).toBe(true);

    const syncHost = lcdHost(HIGH, { allowCall: false });
    program!.bind(syncHost as unknown as ExecutionHost)([], frame);

    expect(syncHost.effects()).toEqual(genericHost.effects());
    expect(syncHost.entries.every((entry) => entry[0] !== 'call')).toBe(true);
    expect([...syncHost.memories.get('gram')!.slice(638, 640)]).toEqual([0xff, 0xff]);
    expect(syncHost.state.get('addrY')).toBe(319);
    expect(syncHost.state.get('addrX')).toBe(1);
    expect(syncHost.state.get('scheduled')).toBe(true);
    expect(syncHost.state.get('frameSeq')).toBe(1);

    const fallbackHost = lcdHost(HIGH, { allowCall: false, bind: false });
    program!.bind(fallbackHost as unknown as ExecutionHost)([], frame);
    expect(fallbackHost.effects()).toEqual(genericHost.effects());
    expect(fallbackHost.entries.every((entry) => entry[0] !== 'call')).toBe(true);
  });

  it('compiles a command latch without advancing the address', () => {
    if (writeLatch?.kind !== 'reaction') return;
    const program = compileSynchronousBody(writeLatch.body, {
      resolveFunction: (name) => functions.get(name),
    });
    expect(program).toBeTruthy();
    const frame: ReactionFrame = { previous: 'low', current: 'high', captures: [] };
    const genericHost = lcdHost(LOW, { allowCall: true });
    const generic = compileBody(writeLatch.body)(
      genericHost as unknown as ExecutionHost,
      [],
      frame,
    );
    expect(generic.next().done).toBe(true);

    const syncHost = lcdHost(LOW, { allowCall: false });
    program!.bind(syncHost as unknown as ExecutionHost)([], frame);
    expect(syncHost.effects()).toEqual(genericHost.effects());
    expect(syncHost.state.get('index')).toBe(0xff);
    expect(syncHost.state.get('addrY')).toBe(0);
  });

  it('compiles readWindow with pin-parameter driveBit calls', () => {
    if (readWindow?.kind !== 'reaction') return;
    const program = compileSynchronousBody(readWindow.body, {
      resolveFunction: (name) => functions.get(name),
      bindResources: true,
    });
    expect(program).toBeTruthy();
    expect(program!.functions).toContain('driveBit');
    expect(program!.functions).toContain('readValue');

    const memory = new Uint8Array(320 * 240 * 2);
    memory.set([0x34, 0x12], 628);
    const frame: ReactionFrame = { previous: false, current: true, captures: [] };
    const genericHost = lcdHost(HIGH, { addrY: 5, memory, allowCall: true });
    const generic = compileBody(readWindow.body)(
      genericHost as unknown as ExecutionHost,
      [],
      frame,
    );
    expect(generic.next().done).toBe(true);

    const syncHost = lcdHost(HIGH, { addrY: 5, memory, allowCall: false });
    program!.bind(syncHost as unknown as ExecutionHost)([], frame);
    expect(syncHost.effects()).toEqual(genericHost.effects());
    expect(syncHost.state.get('addrY')).toBe(4);
    expect(
      syncHost.entries.filter((entry) => entry[0] === 'intent').map((entry) => entry[1]),
    ).toEqual(Array.from({ length: 16 }, (_, index) => `D${index}`));
  });
});
