import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import type {
  DevicePropertyDescriptor,
  MemoryProgram,
  ProgramFiles,
} from '@mica-js/document/fused';
import { createProgramFiles, PROGRAM_LIMITS } from './program';
import { decodeMemoryProgram } from './program-memory';
import { resolveInstanceProperties, type PropertyResolutionInput } from './properties';

const memory: DevicePropertyDescriptor = {
  type: 'program',
  loader: 'memory',
  formats: ['bin', 'hex', 'elf'],
  addressSpaces: { code: { start: 0x100, size: 16 } },
  defaults: { addressSpace: 'code', loadAddress: 0x100 },
};
const reference = { mode: 'project', projectId: 'controller' } as const;
const text = (value: string) => new TextEncoder().encode(value);

function hexRecord(address: number, type: number, data: number[]): string {
  const bytes = [data.length, address >>> 8, address & 255, type, ...data];
  bytes.push(-bytes.reduce((sum, byte) => sum + byte, 0) & 255);
  return ':' + bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function elf(wide: boolean, little: boolean): Uint8Array {
  const header = wide ? 64 : 52;
  const stride = wide ? 56 : 32;
  const offset = header + stride;
  const bytes = new Uint8Array(offset + 2);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1]);
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, little);
  const u32 = (at: number, value: number) => view.setUint32(at, value, little);
  const word = (at: number, value: number) =>
    wide ? view.setBigUint64(at, BigInt(value), little) : u32(at, value);
  u16(16, 2);
  u32(20, 1);
  word(wide ? 32 : 28, header);
  u16(wide ? 52 : 40, header);
  u16(wide ? 54 : 42, stride);
  u16(wide ? 56 : 44, 1);
  u32(header, 1);
  word(header + (wide ? 8 : 4), offset);
  word(header + (wide ? 16 : 8), 0x4000);
  word(header + (wide ? 24 : 12), 0x100);
  word(header + (wide ? 32 : 16), 2);
  word(header + (wide ? 40 : 20), 8);
  bytes.set([7, 9], offset);
  return bytes;
}

function input(
  descriptor: DevicePropertyDescriptor,
  overrides: PropertyResolutionInput['overrides'],
): PropertyResolutionInput {
  const lock = { id: 'test:controller', version: '1.0.0', integrity: 'sha256:' + '0'.repeat(64) };
  const source = { lock, files: {}, read: vi.fn(async () => new Uint8Array()) };
  return {
    instanceId: 'controller-instance',
    descriptors: { program: descriptor },
    overrides,
    package: {
      lock,
      manifest: {
        publisher: 'test',
        name: 'controller',
        version: '1.0.0',
        displayName: 'Controller',
        engines: { mica: '^1.0.0' },
      },
      source,
      files: {},
      read: source.read,
    },
    irProperties: new Map(),
    pointer: ['instances', '0', 'properties'],
  };
}

describe('memory programs', () => {
  it('loads BIN at independent default/override addresses and captures its bytes', () => {
    const bytes = new Uint8Array([1, 2]);
    const program = decodeMemoryProgram('bin', bytes, memory, { ...reference, loadAddress: 0x102 });
    bytes.fill(9);
    expect(program.segments[0]?.address).toBe(0x102);
    expect([...program.segments[0]!.data]).toEqual([1, 2]);
    expect(() =>
      decodeMemoryProgram('bin', bytes, memory, { ...reference, loadAddress: 0x10f }),
    ).toThrow(expect.objectContaining({ code: 'program/out-of-range' }));
  });

  it('decodes HEX extended absolute addresses and rejects checksums, overlap and data after EOF', () => {
    const descriptor = { ...memory, addressSpaces: { code: { start: 0x10000, size: 256 } } };
    const records = [hexRecord(0, 4, [0, 1]), hexRecord(0x20, 0, [3, 4]), hexRecord(0, 1, [])];
    const program = decodeMemoryProgram('hex', text(records.join('\n')), descriptor, reference);
    expect(program.segments[0]?.address).toBe(0x10020);
    expect(program.segments[0]?.data.slice()).toEqual(new Uint8Array([3, 4]));
    expect(() =>
      decodeMemoryProgram('hex', text(':02000004000100\n:00000001ff'), descriptor, reference),
    ).toThrow(expect.objectContaining({ code: 'program/invalid-format' }));
    expect(() =>
      decodeMemoryProgram('hex', text([...records, records[1]].join('\n')), descriptor, reference),
    ).toThrow(expect.objectContaining({ code: 'program/invalid-format' }));
    expect(() =>
      decodeMemoryProgram(
        'hex',
        text([records[0], records[1], records[1], records[2]].join('\n')),
        descriptor,
        reference,
      ),
    ).toThrow(expect.objectContaining({ code: 'program/invalid-image' }));
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'decodes ELF wide=%s little=%s using physical addresses and file bytes only',
    (wide, little) => {
      const program = decodeMemoryProgram('elf', elf(wide, little), memory, reference);
      expect(program.segments).toHaveLength(1);
      expect(program.segments[0]?.address).toBe(0x100);
      expect(program.segments[0]?.data.slice()).toEqual(new Uint8Array([7, 9]));
    },
  );

  it('rejects ambiguous ELF spaces, truncated segments and inappropriate overrides', () => {
    expect(() =>
      decodeMemoryProgram(
        'elf',
        elf(false, true),
        {
          ...memory,
          addressSpaces: { code: { start: 0, size: 1024 }, other: { start: 0, size: 1024 } },
        },
        reference,
      ),
    ).toThrow(expect.objectContaining({ code: 'program/ambiguous-address-space' }));
    expect(() =>
      decodeMemoryProgram('elf', elf(false, true).subarray(0, 85), memory, reference),
    ).toThrow(expect.objectContaining({ code: 'program/invalid-format' }));
    expect(() =>
      decodeMemoryProgram('elf', elf(false, true), memory, { ...reference, addressSpace: 'code' }),
    ).toThrow(expect.objectContaining({ code: 'schema/invalid-value' }));
    expect(() =>
      decodeMemoryProgram('bin', new Uint8Array([1]), { ...memory, formats: ['elf'] }, reference),
    ).toThrow(expect.objectContaining({ code: 'program/unsupported-format' }));
  });
});

describe('program file snapshots', () => {
  it('sorts paths, copies mutable input, supports empty files and reports missing reads', () => {
    const data = text('print(1)');
    const files = createProgramFiles([
      { path: 'main.py', data },
      { path: 'lib/empty.py', data: new Uint8Array() },
    ]);
    data.fill(0);
    expect(files.paths).toEqual(['lib/empty.py', 'main.py']);
    expect(new TextDecoder().decode(files.read('main.py').slice())).toBe('print(1)');
    files.read('main.py').slice().fill(0);
    expect(files.read('main.py')[0]).toBe('p'.charCodeAt(0));
    expect(files.read('lib/empty.py').length).toBe(0);
    expect(() => files.read('absent.py')).toThrow(
      expect.objectContaining({ code: 'program/file-not-found' }),
    );
    expect(createProgramFiles([]).paths).toEqual([]);
  });

  it.each([
    '../main.py',
    '/main.py',
    'C:main.py',
    'lib\\main.py',
    'lib//main.py',
    './main.py',
    'a\0b',
  ])('rejects path %s', (path) => {
    expect(() => createProgramFiles([{ path, data: new Uint8Array() }])).toThrow(
      expect.objectContaining({ code: 'program/invalid-path' }),
    );
  });

  it('rejects duplicate paths and file/directory conflicts in either order', () => {
    for (const paths of [
      ['a', 'a'],
      ['a', 'a/b'],
      ['a/b', 'a'],
    ])
      expect(() =>
        createProgramFiles(paths.map((path) => ({ path, data: new Uint8Array() }))),
      ).toThrow(expect.objectContaining({ code: 'program/invalid-path' }));
  });

  it('enforces count, path and byte limits at their actual boundaries', () => {
    const files = Array.from({ length: PROGRAM_LIMITS.maxFiles }, (_, i) => ({
      path: `${i}.py`,
      data: new Uint8Array(),
    }));
    expect(createProgramFiles(files).paths).toHaveLength(PROGRAM_LIMITS.maxFiles);
    expect(() => createProgramFiles([...files, { path: 'extra', data: new Uint8Array() }])).toThrow(
      expect.objectContaining({ code: 'program/resource-limit' }),
    );
    expect(
      createProgramFiles([
        { path: 'a'.repeat(PROGRAM_LIMITS.maxPathBytes), data: new Uint8Array() },
      ]).paths,
    ).toHaveLength(1);
    expect(() =>
      createProgramFiles([
        { path: 'a'.repeat(PROGRAM_LIMITS.maxPathBytes + 1), data: new Uint8Array() },
      ]),
    ).toThrow(expect.objectContaining({ code: 'program/resource-limit' }));
    expect(() =>
      createProgramFiles([
        { path: 'large', data: new Uint8Array(PROGRAM_LIMITS.maxFileBytes + 1) },
      ]),
    ).toThrow(expect.objectContaining({ code: 'program/resource-limit' }));
  });
});

describe('program property preparation', () => {
  it('reads asset bytes by identity and decodes an independent memory snapshot', async () => {
    const bytes = new Uint8Array([0x12, 0x34]);
    const value = { mode: 'asset', assetId: 'asset-uuid', name: 'app.bin' } as const;
    const read = vi.fn(async () => bytes);
    const result = await resolveInstanceProperties({
      ...input(memory, { program: value }),
      resolveResource: read,
    });
    expect(read).toHaveBeenCalledWith({
      instanceId: 'controller-instance',
      property: 'program',
      reference: value,
    });
    bytes.fill(0);
    const image = result.props['program'] as MemoryProgram;
    expect(image).toMatchObject({ segments: [{ addressSpace: 'code', address: 0x100 }] });
    expect(image.segments[0]?.data.slice()).toEqual(new Uint8Array([0x12, 0x34]));
  });

  it('accepts ZIP assets and rejects traversal, duplicate names and oversized decompressed entries', async () => {
    const descriptor: DevicePropertyDescriptor = { type: 'program', loader: 'filesystem' };
    const capture = async (archive: Uint8Array) =>
      resolveInstanceProperties({
        ...input(descriptor, {
          program: { mode: 'asset', assetId: 'asset-uuid', name: 'scripts.zip' },
        }),
        resolveResource: async () => archive,
      });
    const prepared = await capture(
      zipSync({ 'main.py': text('start()'), 'lib/empty.py': new Uint8Array() }),
    );
    const files = prepared.props['program'] as ProgramFiles;
    expect(files.paths).toEqual(['lib/empty.py', 'main.py']);
    expect(new TextDecoder().decode(files.read('main.py').slice())).toBe('start()');
    await expect(capture(zipSync({ '../outside': text('x') }))).rejects.toMatchObject({
      code: 'program/invalid-path',
    });
    const duplicate = zipSync({ 'a.py': text('a'), 'b.py': text('b') });
    for (let i = 0; i < duplicate.length - 3; i++)
      if (
        duplicate[i] === 98 &&
        duplicate[i + 1] === 46 &&
        duplicate[i + 2] === 112 &&
        duplicate[i + 3] === 121
      )
        duplicate[i] = 97;
    await expect(capture(duplicate)).rejects.toMatchObject({ code: 'program/invalid-path' });
    const oversized = zipSync({ 'huge.py': text('x') });
    const view = new DataView(oversized.buffer);
    for (let i = 0; i < oversized.length - 24; i++)
      if (view.getUint32(i, true) === 0x02014b50)
        view.setUint32(i + 24, PROGRAM_LIMITS.maxFileBytes + 1, true);
    await expect(capture(oversized)).rejects.toMatchObject({ code: 'program/resource-limit' });
    await expect(capture(text('not a ZIP'))).rejects.toMatchObject({
      code: 'program/source-resolve-failed',
    });
  });

  it.each(['image', 'binary', 'firmware'] as const)(
    'rejects project references for %s properties',
    async (type) => {
      await expect(
        resolveInstanceProperties(input({ type }, { program: reference })),
      ).rejects.toMatchObject({ code: 'schema/invalid-type' });
    },
  );
  it('passes the declared target to project builds, keeps files out of the DDL props and preserves failures', async () => {
    const descriptor: DevicePropertyDescriptor = { type: 'program', loader: 'filesystem' };
    const resolve = vi.fn(async () => ({
      kind: 'filesystem' as const,
      files: [{ path: 'main.py', data: text('start()') }],
    }));
    const prepared = await resolveInstanceProperties({
      ...input(descriptor, { program: reference }),
      programs: { projects: { select: async () => undefined, resolve } },
    });
    expect(resolve).toHaveBeenCalledWith('controller', {
      deviceId: 'test:controller',
      property: 'program',
      loader: 'filesystem',
    });
    expect((prepared.props['program'] as ProgramFiles).paths).toEqual(['main.py']);
    expect(prepared.boardProps).toEqual({});
    await expect(
      resolveInstanceProperties({
        ...input(descriptor, { program: reference }),
        programs: {
          projects: {
            select: async () => undefined,
            resolve: async () => ({ kind: 'memory', format: 'bin', data: new Uint8Array([1]) }),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'program/loader-mismatch' });
    await expect(
      resolveInstanceProperties({
        ...input({ ...descriptor, nullable: true }, { program: null }),
        irProperties: new Map([['program', { kind: 'bytes' }]]),
      }),
    ).rejects.toMatchObject({ code: 'model/invalid-interface' });
  });

  it('reads only the exact package directory prefix and requires an asset reader', async () => {
    const descriptor: DevicePropertyDescriptor = { type: 'program', loader: 'filesystem' };
    const base = input(descriptor, { program: { mode: 'package', src: 'apps/openmv' } });
    const read = vi.fn(async () => text('pass'));
    const record = { size: 4, integrity: 'sha256:' + '0'.repeat(64) };
    const prepared = await resolveInstanceProperties({
      ...base,
      package: {
        ...base.package,
        files: { 'apps/openmv/main.py': record, 'apps/openmv-other/private.py': record },
        read,
      },
    });
    expect((prepared.props['program'] as ProgramFiles).paths).toEqual(['main.py']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('apps/openmv/main.py', PROGRAM_LIMITS.maxFileBytes);
    await expect(
      resolveInstanceProperties(
        input(descriptor, { program: { mode: 'asset', assetId: 'scripts', name: 'scripts.zip' } }),
      ),
    ).rejects.toMatchObject({ code: 'runtime/prepare-failed' });
  });
});
