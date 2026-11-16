/**
 * Preparation of one headless fused session (RFC 0025).
 *
 * Everything here happens before the first model factory: the document is snapshotted, every locked
 * package is verified, the topology and its voltage constraints are derived, model modules are
 * loaded and their IR is checked against the manifest, and all instance properties (including
 * resources and firmware) are captured as independent snapshots.
 */
import { deriveFusedTopology, parseFusedDocument } from '@mica-js/document/fused';
import type {
  DeviceLock,
  DeviceRegistry,
  FusedDocument,
  FusedNet,
  PackageFiles,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import { validateDeviceIR } from '@mica-js/device-model';
import type { DeviceIR, ValueTypeIR } from '@mica-js/device-model';
import { checkModelAgreement } from './agreement.js';
import { DiagnosticBatch, FusedPreparationError, problem } from './diagnostics.js';
import type { DiagnosticSink, RuntimeDiagnostic } from './diagnostics.js';
import type { FusedModelFactory } from './models.js';
import { openDevicePackage, type VerifiedPackage } from './package.js';
import type { FirmwareProjectSource } from './firmware.js';
import {
  resolveInstanceProperties,
  type BoardPropertyValue,
  type ResourceResolver,
} from './properties.js';

export interface PrepareInput {
  /** Document to snapshot; the caller's object is never mutated or retained. */
  readonly document: FusedDocument;
  readonly registry: DeviceRegistry;
  /** Loads one declared entry of a verified package; the module namespace is validated here. */
  readonly loadModule: (files: PackageFiles, path: string) => Promise<unknown>;
  readonly resolveResource?: ResourceResolver;
  readonly projects?: FirmwareProjectSource;
  readonly onDiagnostic?: DiagnosticSink;
  readonly hostApiVersion?: string;
}

export interface PreparedModel {
  readonly ir: DeviceIR;
  readonly create: FusedModelFactory;
}

export interface PreparedDevice {
  readonly deviceId: string;
  readonly lock: DeviceLock;
  readonly package: VerifiedPackage;
  /** Present when the device declares a model; display-only devices are skipped headless. */
  readonly model?: PreparedModel;
}

export interface PreparedInstance {
  readonly instanceId: string;
  readonly deviceId: string;
  /** Resolved read-only property snapshot handed to the model factory. */
  readonly props: Readonly<Record<string, unknown>>;
  /** IR-declared plain properties handed to the board. */
  readonly boardProps: Readonly<Record<string, BoardPropertyValue>>;
}

export interface PreparedSession {
  readonly document: FusedDocument;
  readonly devices: ReadonlyMap<string, PreparedDevice>;
  /** Modeled instances in document order. */
  readonly instances: readonly PreparedInstance[];
  readonly nets: readonly FusedNet[];
}

/**
 * Prepares one headless session.
 *
 * @throws {FusedPreparationError} after reporting every problem through `onDiagnostic`.
 */
export async function prepareFusedSession(input: PrepareInput): Promise<PreparedSession> {
  const batch = new DiagnosticBatch();
  const failure = (): FusedPreparationError => {
    const diagnostics: RuntimeDiagnostic[] = batch.drain();
    for (const entry of diagnostics) {
      input.onDiagnostic?.(entry);
    }
    return new FusedPreparationError(diagnostics);
  };

  let document: FusedDocument;
  try {
    document = parseFusedDocument(input.document);
  } catch (cause) {
    batch.add(cause, 'schema/invalid-value');
    throw failure();
  }

  const deviceIds: string[] = [];
  for (const instance of document.instances) {
    if (!deviceIds.includes(instance.device)) {
      deviceIds.push(instance.device);
    }
  }

  const devices = new Map<string, PreparedDevice>();
  const manifests = new Map<string, UnifiedDeviceManifest>();
  for (const deviceId of deviceIds) {
    const dependency = document.dependencies[deviceId];
    if (dependency === undefined) {
      batch.addProblem(
        problem('document/unlocked-device', `Instance device "${deviceId}" is not locked.`),
      );
      continue;
    }
    let verified: VerifiedPackage;
    try {
      verified = await openDevicePackage(
        input.registry,
        { id: deviceId, version: dependency.version, integrity: dependency.integrity },
        input.hostApiVersion,
      );
    } catch (cause) {
      batch.add(cause, 'package/not-found');
      continue;
    }
    manifests.set(deviceId, verified.manifest);
    devices.set(deviceId, {
      deviceId,
      lock: verified.lock,
      package: verified,
    });
  }
  if (!batch.empty) {
    throw failure();
  }

  // View layout identities need the device manifest, so they are checked here and not by the
  // document parser; a layout that names an undeclared view would otherwise only fail on display.
  for (const [index, instance] of document.instances.entries()) {
    const layout = instance.viewLayout;
    const manifest = manifests.get(instance.device);
    if (layout === undefined || manifest === undefined) {
      continue;
    }
    const declared = manifest.view ?? {};
    const seen = new Set<string>();
    layout.views.forEach((entry, at) => {
      const pointer = `/instances/${index}/viewLayout/views/${at}/viewId`;
      if (seen.has(entry.viewId)) {
        batch.addProblem(
          problem(
            'document/invalid-view-layout',
            `Instance "${instance.id}" lists the view "${entry.viewId}" more than once.`,
            pointer,
          ),
          instance.id,
        );
        return;
      }
      seen.add(entry.viewId);
      if (!Object.hasOwn(declared, entry.viewId)) {
        batch.addProblem(
          problem(
            'document/invalid-view-layout',
            `Instance "${instance.id}" references the view "${entry.viewId}", which ${instance.device} does not declare.`,
            pointer,
          ),
          instance.id,
        );
      }
    });
  }
  if (!batch.empty) {
    throw failure();
  }

  let nets: readonly FusedNet[];
  try {
    nets = deriveFusedTopology(document, manifests).nets;
  } catch (cause) {
    batch.add(cause, 'net/reference-conflict');
    throw failure();
  }

  for (const [deviceId, device] of devices) {
    const definition = device.package.manifest.model;
    if (definition === undefined) {
      continue;
    }
    const loaded = await loadModelModule(device, definition.entry, input, batch);
    if (loaded === undefined) {
      continue;
    }
    devices.set(deviceId, { ...device, model: loaded });
  }
  if (!batch.empty) {
    throw failure();
  }

  const instances: PreparedInstance[] = [];
  for (const [index, instance] of document.instances.entries()) {
    const device = devices.get(instance.device);
    const model = device?.model;
    if (device === undefined || model === undefined) {
      continue;
    }
    try {
      const resolution = await resolveInstanceProperties({
        instanceId: instance.id,
        package: device.package,
        descriptors: device.package.manifest.properties ?? {},
        overrides: instance.properties ?? {},
        irProperties: propertyDeclarations(model.ir),
        pointer: ['instances', String(index), 'properties'],
        ...(input.resolveResource === undefined ? {} : { resolveResource: input.resolveResource }),
        ...(input.projects === undefined ? {} : { projects: input.projects }),
      });
      instances.push({
        instanceId: instance.id,
        deviceId: instance.device,
        props: resolution.props,
        boardProps: resolution.boardProps,
      });
    } catch (cause) {
      batch.add(cause, 'runtime/prepare-failed', instance.id);
    }
  }
  if (!batch.empty) {
    throw failure();
  }

  const modeled = new Set(instances.map((instance) => instance.instanceId));
  const boardNets = nets
    .map((net) => ({
      ...net,
      pins: net.pins.filter((pin) => modeled.has(pin.instance)),
    }))
    .filter((net) => net.pins.length > 0);

  return Object.freeze({
    document,
    devices,
    instances: Object.freeze(instances),
    nets: Object.freeze(boardNets),
  });
}

async function loadModelModule(
  device: PreparedDevice,
  entry: string,
  input: PrepareInput,
  batch: DiagnosticBatch,
): Promise<PreparedModel | undefined> {
  let namespace: unknown;
  try {
    namespace = await input.loadModule(device.package.source, entry);
  } catch (cause) {
    batch.addProblem(
      problem(
        'model/execution-failed',
        `Cannot load ${device.deviceId}/${entry}: ${messageOf(cause)}`,
      ),
    );
    return undefined;
  }
  const candidate = namespace as { model?: unknown; create?: unknown } | null;
  if (typeof namespace !== 'object' && typeof namespace !== 'function') {
    batch.add(
      problem(
        'model/invalid-interface',
        `${device.deviceId}/${entry} must export the model IR and a create factory.`,
      ),
      'model/invalid-interface',
    );
    return undefined;
  }
  if (candidate?.model === undefined || candidate.create === undefined) {
    batch.add(
      problem(
        'model/invalid-interface',
        `${device.deviceId}/${entry} must export "model" and "create".`,
      ),
      'model/invalid-interface',
    );
    return undefined;
  }
  if (typeof candidate.create !== 'function') {
    batch.add(
      problem(
        'model/invalid-interface',
        `${device.deviceId}/${entry} exports a non-function "create".`,
      ),
      'model/invalid-interface',
    );
    return undefined;
  }

  let ir: DeviceIR;
  try {
    ir = validateDeviceIR(candidate.model);
  } catch (cause) {
    batch.add(cause, 'model/invalid-interface');
    return undefined;
  }

  // Same rules as the SDK build: pins, property types, nullability, enum members and literal
  // defaults must agree before any factory sees the module.
  const disagreements = checkModelAgreement(device.package.manifest, ir);
  if (disagreements.length > 0) {
    for (const entry of disagreements) {
      batch.addProblem(entry);
    }
    return undefined;
  }

  return { ir, create: candidate.create as FusedModelFactory };
}

function propertyDeclarations(ir: DeviceIR): ReadonlyMap<string, ValueTypeIR> {
  const declarations = new Map<string, ValueTypeIR>();
  for (const declaration of ir.declarations) {
    if (declaration.kind === 'property') {
      declarations.set(declaration.name, declaration.type);
    }
  }
  return declarations;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
