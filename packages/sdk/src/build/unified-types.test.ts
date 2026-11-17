import typescript from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/ddl';
import type { UnifiedDeviceManifest } from '@mica-js/document/fused';
import {
  DEVICE_GLOBAL_TYPES,
  renderDeviceDeclaration,
  renderDeviceTypeScriptConfig,
} from './unified-types';

const manifest: UnifiedDeviceManifest = {
  publisher: 'example',
  name: 'button',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Button',
  properties: {
    label: { type: 'string', nullable: false, default: 'start' },
    debounce: { type: 'integer', default: 2 },
    mode: {
      type: 'enum',
      default: 'momentary',
      options: [
        { value: 'momentary', label: 'Momentary' },
        { value: 'latching', label: 'Latching' },
      ],
    },
    icon: { type: 'image', nullable: true, default: { src: 'assets/icon.png', mode: 'package' } },
    profile: { type: 'binary', nullable: true },
    firmware: {
      type: 'firmware',
      nullable: true,
      addressSpaces: { code: { start: 0, size: 8192 } },
      addressSpace: 'code',
      loadAddress: 0,
    },
  },
  pins: { a1: { label: '1' }, b1: { label: '2' } },
  model: {
    entry: 'model.js',
    types: {
      ButtonState: {
        type: 'object',
        properties: {
          pressed: { type: 'boolean' },
          samples: { type: 'array', items: { type: 'number' } },
          note: { type: 'string' },
        },
        optional: ['samples'],
        additionalProperties: { type: 'string' },
      },
    },
    methods: {
      press: { params: { type: 'boolean' }, returns: { type: 'null' } },
      getStatus: { params: { type: 'null' }, returns: { ref: 'ButtonState' } },
    },
    events: { onDidStateChange: { ref: 'ButtonState' }, onDidBlink: { type: 'binary' } },
  },
};

describe('renderDeviceDeclaration', () => {
  it('declares the fixed global names with manifest-derived shapes', () => {
    const text = renderDeviceDeclaration({ manifest, manifestPath: 'package.json' });
    expect(text).toContain('declare global {');
    for (const name of DEVICE_GLOBAL_TYPES) expect(text).toContain(`type ${name}`);
    expect(text).toContain('readonly label: string;');
    expect(text).toContain('readonly debounce: number;');
    expect(text).toContain('readonly mode: "momentary" | "latching";');
    expect(text).toContain('readonly icon: ReadonlyBytes | null;');
    expect(text).toContain('readonly profile: ReadonlyBytes | null;');
    expect(text).toContain('readonly firmware: FirmwareImage | null;');
    expect(text).toContain('type DevicePinId = "a1" | "b1";');
    expect(text).toContain('readonly press: (params: boolean) => null;');
    expect(text).toContain('readonly getStatus: (params: null) => MicaPayload_ButtonState;');
    expect(text).toContain('readonly onDidStateChange: MicaPayload_ButtonState;');
    expect(text).toContain('readonly onDidBlink: Uint8Array;');
    expect(text).toContain(
      'type DeviceModelContext = ModelContext<CoreContext, DeviceProps, DeviceEvents>;',
    );
    expect(text).toContain(
      'type DeviceFactory = (context: DeviceModelContext) => ModelInstance<DeviceMethods, Batch>;',
    );
    expect(text).toContain('type DeviceClient = ModelClient<DeviceMethods, DeviceEvents>;');
    expect(text).toContain('Batch = DeviceBatch<Record<never, never>>');
  });

  it('projects the payload types and their references', () => {
    const text = renderDeviceDeclaration({ manifest, manifestPath: 'package.json' });
    expect(text).toContain('type MicaPayload_ButtonState = {');
    expect(text).toContain('readonly "samples"?: ReadonlyArray<number>;');
    expect(text).toContain(
      'readonly [key: string]: ReadonlyArray<number> | boolean | string | undefined;',
    );
    expect(text).toContain('  ReadonlyBytes,');
    expect(text).toContain('  FirmwareImage,');
  });

  it('projects each program loader as a precise factory input type', () => {
    const text = renderDeviceDeclaration({
      manifest: {
        ...manifest,
        properties: {
          program: { type: 'program', loader: 'memory', nullable: true },
          scripts: { type: 'program', loader: 'filesystem' },
        },
      },
      manifestPath: 'package.json',
    });
    expect(text).toContain('readonly program: MemoryProgram | null;');
    expect(text).toContain('readonly scripts: ProgramFiles;');
    expect(text).toContain('  MemoryProgram,');
    expect(text).toContain('  ProgramFiles,');
  });

  it('quotes payload keys and namespaces payload aliases', () => {
    const text = renderDeviceDeclaration({
      manifest: {
        ...manifest,
        model: {
          entry: 'model.js',
          types: {
            Batch: {
              type: 'object',
              properties: {
                'not-an-identifier': { type: 'number' },
                'with space': { type: 'string' },
              },
            },
            ModelClient: { type: 'array', items: { type: 'array', items: { type: 'boolean' } } },
          },
          events: { onDidBatch: { ref: 'Batch' }, onDidMatrix: { ref: 'ModelClient' } },
        },
      },
      manifestPath: 'package.json',
    });
    expect(text).toContain('type MicaPayload_Batch = {');
    expect(text).toContain('readonly "not-an-identifier": number;');
    expect(text).toContain('readonly "with space": string;');
    expect(text).toContain('type MicaPayload_ModelClient = ReadonlyArray<ReadonlyArray<boolean>>;');
    expect(text).not.toContain('readonly Batch:');
    expect(text).toContain('readonly onDidBatch: MicaPayload_Batch;');
  });

  it('rejects payload names that cannot become an identifier', () => {
    expect(() =>
      renderDeviceDeclaration({
        manifest: {
          ...manifest,
          model: { entry: 'model.js', types: { 'needs "quotes"': { type: 'number' } } },
        },
        manifestPath: 'package.json',
      }),
    ).toThrow('model.types: invalid payload type name');
  });

  it('rejects a payload ref that the manifest does not declare', () => {
    expect(() =>
      renderDeviceDeclaration({
        manifest: {
          ...manifest,
          model: { entry: 'model.js', events: { onDidMissing: { ref: 'Missing' } } },
        },
        manifestPath: 'package.json',
      }),
    ).toThrow("model.types: unknown payload type 'Missing'");
  });

  it('produces a syntactically valid declaration module', () => {
    const text = renderDeviceDeclaration({ manifest, manifestPath: 'package.json' });
    const parsed = typescript.createSourceFile(
      'device.d.ts',
      text,
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.TS,
    );
    const { parseDiagnostics } = parsed as unknown as {
      readonly parseDiagnostics: readonly unknown[];
    };
    expect(parseDiagnostics).toEqual([]);
  });

  it('reports never for a device without pins and empty member maps', () => {
    const text = renderDeviceDeclaration({
      manifest: {
        publisher: 'example',
        name: 'empty',
        version: '1.0.0',
        engines: { mica: '^1.0.0' },
        displayName: 'Empty',
      },
      manifestPath: 'package.json',
    });
    expect(text).toContain('type DevicePinId = never;');
    expect(text).toContain('type DeviceProps = {\n  };');
    expect(text).toContain('type DeviceMethods = {\n  };');
    expect(text).toContain('type DeviceEvents = {\n  };');
    expect(text).not.toContain('ReadonlyBytes');
  });

  it('projects the DDL channel, memory and output declarations', async () => {
    const model = await compileDDL(`device Button(debounce: number default 2) {
      output channel brightness: number (capacity: 4);
      pin a1;
      pin b1;
    }`);
    const text = renderDeviceDeclaration({ manifest, model, manifestPath: 'package.json' });
    expect(text).toContain('type Batch = DeviceBatch<MicaOutputs>;');
    expect(text).toContain(
      'type CoreContext = DeviceContext<DeviceProps, MicaInputs, MicaMemory>;',
    );
    expect(text).toContain('export type MicaContext');
    expect(text).toContain('readonly "brightness": readonly ChannelMessage<number>[];');
  });
});

describe('renderDeviceTypeScriptConfig', () => {
  it('loads the generated declaration and includes the source directory', () => {
    const config = JSON.parse(renderDeviceTypeScriptConfig('src')) as {
      compilerOptions: Record<string, unknown>;
      files: readonly string[];
      include: readonly string[];
    };
    expect(config.files).toEqual(['./device.d.ts']);
    expect(config.include).toEqual(['../src']);
    expect(config.compilerOptions['strict']).toBe(true);
    expect(config.compilerOptions['noEmit']).toBe(true);
    expect(config.compilerOptions['allowArbitraryExtensions']).toBe(true);
    expect(config.compilerOptions['verbatimModuleSyntax']).toBe(true);
  });
});
