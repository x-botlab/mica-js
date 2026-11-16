import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * Fused CT107D fixture. This is the formal `device/dist` artifact: one model, one
 * instance and one JIT. The legacy adapter only bridges `createBoard` prop validation
 * and firmware resources; it does not assemble any discrete device or net.
 */

const PROJECT = join(import.meta.dirname, '..');
const ARTIFACT = join(PROJECT, 'device', 'dist', 'model.js');
const MANIFEST = join(PROJECT, 'device', 'dist', 'package.json');
const SCHEMATIC = join(PROJECT, 'ct107d.sch');
const GENERATED_MODEL = join(PROJECT, 'device', 'src', 'model.ddl');

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface ArtifactModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => {
    readonly methods?: Readonly<Record<string, (params: unknown) => unknown>>;
    sync(batch: unknown): void;
    dispose(): void;
  };
}

export interface FusedFingerprints {
  readonly source: 'dist';
  readonly model: string;
  readonly manifest: string;
  readonly generatedModel: string;
  readonly schematic: string;
  readonly firmware: string;
}

export interface FusedBoardOptions {
  readonly firmware: Uint8Array;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly execution?: 'throughput' | 'precise';
}

export interface FusedBenchBoard {
  readonly board: {
    readonly time: number;
    readonly status: string;
    readonly topics: {
      onDidReceive(listener: (message: { topic: string; payload: unknown }) => unknown): {
        dispose(): void;
      };
      publish(topic: string, payload: unknown): void;
    };
    runUntil(target: number): void;
    dispose(): void;
  };
  readonly faults: readonly string[];
  /** Exactly one device instance in the artifact graph. */
  readonly instances: number;
  /** Exactly one JIT (the 8051 core) in the artifact graph. */
  readonly jits: number;
  readonly clockFrequency: number;
  readonly devices: number;
  readonly nets: number;
  readonly fingerprints: FusedFingerprints;
  /** Adapter methods exposed for correctness tests (not used in timing). */
  readonly methods: Readonly<Record<string, (params: unknown) => unknown>>;
  /** Test-only view of the fused MCU pin levels (0 low, 1 high, 2 unknown). */
  fusedPins(): Uint8Array;
  /** Test-only view of the fused MCU pin drive codes (0/1/2/3/4). */
  fusedMcuDrives(): Uint8Array;
  dispose(): void;
}

let artifactPromise: Promise<ArtifactModule> | undefined;

function loadArtifact(): Promise<ArtifactModule> {
  artifactPromise ??= (async () => {
    const imported = (await import(pathToFileURL(ARTIFACT).href)) as ArtifactModule;
    if (imported.model === undefined || imported.create === undefined)
      throw new Error(`${ARTIFACT} must export both \`model\` and \`create\``);
    return imported;
  })();
  return artifactPromise;
}

export function demoFirmware(): Uint8Array {
  return new Uint8Array(readFileSync(join(PROJECT, 'assets', 'ct107d-demo.bin')));
}

export async function createFusedCt107dBoard(options: FusedBoardOptions): Promise<FusedBenchBoard> {
  const artifact = await loadArtifact();
  const create = adaptModelFactory(artifact.create as never, {
    props: (context) => ({
      ...(context.props as Readonly<Record<string, unknown>>),
      firmware: firmwareImage([
        { addressSpace: 'code', address: 0, data: options.firmware.slice() },
      ]),
    }),
    events: {
      onDidSignal: 'signal',
      onDidBytes: 'bytes',
      onDidUart1Tx: 'uart1.tx',
      onDidUart1Rx: 'uart1.rx',
      onDidAmplifier: 'amplifier.event',
    },
    inputs: {
      switch: { method: 'setSwitch' },
      jumper: { method: 'setJumper' },
      hall: { method: 'setHallField', params: (value) => ({ value }) },
      wiper: { method: 'setWiper', params: (value) => ({ value }) },
      amplifier: { method: 'setAmplifierInputs' },
      ir: { method: 'setIrCarrier' },
      temperature: { method: 'setTemperature', params: (value) => ({ value }) },
      analog: { method: 'setAnalogInput' },
      uart: { method: 'sendUart', params: (value) => ({ data: value }) },
    },
  });
  const props = {
    ...(options.props ?? {}),
    ...(options.props?.['clockFrequency'] === undefined ? { clockFrequency: 11_059_200 } : {}),
  };
  const description = {
    instances: [{ id: 'board', type: 'board', props } as never],
    nets: [
      { id: 'vcc', voltage: 5, pins: [{ instance: 'board', pin: 'VCC' }] },
      { id: 'gnd', voltage: 0, pins: [{ instance: 'board', pin: 'GND' }] },
    ],
  };
  const board =
    options.execution === undefined
      ? createBoard(
          createDeviceLibrary([{ id: 'board', model: artifact.model, create: create as never }]),
          description,
        )
      : createBoard(
          createDeviceLibrary([{ id: 'board', model: artifact.model, create: create as never }]),
          description,
          { execution: options.execution },
        );
  const faults: string[] = [];
  const subscription = board.onDidError((event) => faults.push(`${event.code}: ${event.message}`));
  const runtime = board as unknown as {
    readonly instances: readonly {
      readonly jits: readonly unknown[];
      readonly adapter?: {
        readonly methods?: Readonly<Record<string, (params: unknown) => unknown>>;
      };
      readonly memories?: ReadonlyMap<string, Uint8Array>;
    }[];
  };
  const instances = runtime.instances.length;
  const jits = runtime.instances.reduce((sum, instance) => sum + instance.jits.length, 0);
  const methods = runtime.instances[0]?.adapter?.methods ?? {};
  const memories = runtime.instances[0]?.memories;

  return {
    board: board as unknown as FusedBenchBoard['board'],
    faults,
    instances,
    jits,
    clockFrequency: Number(props.clockFrequency ?? 11_059_200),
    devices: instances,
    nets: 2,
    methods,
    fusedPins: () => new Uint8Array(memories?.get('fusedPins') ?? []),
    fusedMcuDrives: () => new Uint8Array(memories?.get('fusedMcuDrives') ?? []),
    fingerprints: {
      source: 'dist',
      model: sha256(readFileSync(ARTIFACT)),
      manifest: sha256(readFileSync(MANIFEST)),
      generatedModel: sha256(readFileSync(GENERATED_MODEL)),
      schematic: sha256(readFileSync(SCHEMATIC)),
      firmware: sha256(options.firmware),
    },
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}
