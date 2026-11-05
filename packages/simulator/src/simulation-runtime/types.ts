import type { TimePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type {
  DeviceMetadata,
  DevicePortMetadata,
  SchematicDocument,
} from '@mica-js/document/schematic';

export type ISimulationDeviceTopicDefinition = DevicePortMetadata;
import type { RuntimeDiagnosticCode, RuntimePhase } from '../types';

/** A current SDK device: JSON metadata plus self-contained ESM with named model/create exports. */
export interface IPreparedSimulationDevice {
  readonly id: string;
  readonly definition: DeviceMetadata;
  /** Imported only by the runtime guest, never by the editor that prepares this DTO. */
  readonly code: string;
}

/** A prepared schematic and its separately resolved resource bytes. */
export interface IPreparedSimulation {
  readonly schematic: SchematicDocument;
  readonly devices: readonly IPreparedSimulationDevice[];
  /** Fixed board voltages by exact schematic net name; ignored for empty sheets. Ground stays zero. */
  readonly voltageReferences?: Readonly<Record<string, number>>;
  /** assets[symbolId][src]; required for every effective image/binary resource reference. */
  readonly assets?: Readonly<Record<string, Readonly<Record<string, Uint8Array>>>>;
}

export interface ISimulationMessageTarget {
  readonly symbol: string;
  readonly port: string;
}

export interface ISimulationMessage {
  readonly target: ISimulationMessageTarget;
  readonly payload: unknown;
  /** End of the tick that delivered this publication, in integer picoseconds. */
  readonly simTime: TimePs;
}

export interface ISimulationTickReport {
  readonly simTime: TimePs;
  /** One successful Board.runUntil call, or zero when no board is loaded. */
  readonly executed: number;
}

export type SimulationDiagnosticCode =
  'device/input-failed' | 'device/output-failed' | 'board/error' | 'board/diagnostic';

/** Serializable projection of a board diagnostic or invalid device topic publication. */
export interface ISimulationDiagnostic {
  readonly code: SimulationDiagnosticCode;
  /** Empty only for a board-wide diagnostic with no associated instance. */
  readonly symbol: string;
  readonly port?: string;
  readonly message: string;
  readonly simTime: TimePs;
  readonly runtimeCode?: RuntimeDiagnosticCode;
  readonly phase?: RuntimePhase;
}

export type SimulationModuleImporter = (code: string, deviceId: string) => Promise<unknown>;

export interface ISimulationRuntimeOptions {
  /** Defaults to a blob-URL dynamic import in the runtime worker. */
  readonly importer?: SimulationModuleImporter;
}

/** Owns a Board; failed load/reset leaves the previous board and queued inputs intact. */
export interface ISimulationRuntime {
  load(input: IPreparedSimulation): Promise<void>;
  /** Recreates the captured board synchronously without re-importing modules. */
  reset(): Promise<void>;
  /** Advances by a positive integer number of picoseconds, up to MAX_TIME_PS. */
  tick(dt: TimePs): Promise<ISimulationTickReport>;
  /** Snapshots a declared input; the next tick delivers it before Board.runUntil. */
  deliver(message: ISimulationMessage): Promise<void>;
  readonly onDidPublish: Event<ISimulationMessage>;
  readonly onDidDiagnostic: Event<ISimulationDiagnostic>;
  dispose(): Promise<void>;
}
