/**
 * Verification every committed document state has to pass (RFC 0024).
 *
 * A mutation is only accepted once the candidate parses, every device it references opens as the
 * locked release with usable geometry, the per-instance view layouts name declared views, and the
 * explicit connection graph derives without name or voltage conflicts.
 */
import { deriveFusedTopology, parseFusedDocument } from '@mica-js/document/fused';
import type { FusedDocument, FusedTopology, UnifiedDeviceManifest } from '@mica-js/document/fused';
import type { IDeviceCache, IPreparedDevice } from '../devices';
import { routeDocumentWires } from '../wiring';
import { FusedSessionError } from './errors';
import type { IFusedSessionProblem } from './errors';

export interface IVerifiedFusedDocument {
  readonly document: FusedDocument;
  readonly devices: ReadonlyMap<string, IPreparedDevice>;
  readonly topology: FusedTopology;
}

export interface IVerifyFusedDocumentOptions {
  /**
   * Rebuilds every wire whose legs are no longer orthogonal, using the loaded device geometry.
   *
   * Content mutations route; a layout check must not change content, so it leaves wires alone.
   */
  readonly routeWires?: boolean;
  /** Document before the mutation, so moved anchors are absorbed the way a symbol drag absorbs them. */
  readonly previous?: FusedDocument;
}

/**
 * Parses and verifies one candidate document.
 *
 * @throws {FusedDocumentError} for contract violations, {PreparationError} for package problems and
 * {FusedSessionError} for a view layout the owning device does not declare.
 */
export async function verifyFusedDocument(
  value: unknown,
  devices: IDeviceCache,
  options: IVerifyFusedDocumentOptions = {},
): Promise<IVerifiedFusedDocument> {
  let document = parseFusedDocument(value);
  const prepared = await devices.prepareDocument(document);
  for (const instance of document.instances) {
    const properties = prepared.get(instance.device)?.manifest.properties;
    for (const [key, value] of Object.entries(instance.properties ?? {})) {
      if (
        value !== null &&
        typeof value === 'object' &&
        value.mode === 'project' &&
        properties?.[key]?.type !== 'program'
      )
        throw new FusedSessionError(
          'edit/invalid-document',
          `Only program properties can reference a project: ${instance.id}/${key}.`,
        );
    }
  }
  if (options.routeWires === true) {
    const routed = routeDocumentWires(document, prepared, options.previous);
    if (routed !== document) {
      document = parseFusedDocument(routed);
    }
  }
  checkViewLayouts(document, prepared);
  const manifests = new Map<string, UnifiedDeviceManifest>(
    [...prepared].map(([deviceId, device]) => [deviceId, device.manifest]),
  );
  const topology = deriveFusedTopology(document, manifests);
  return { document, devices: prepared, topology };
}

/**
 * Checks every saved layout against the views its device declares (RFC 0024).
 *
 * The document parser cannot do this: view ids live in the device manifest.
 */
function checkViewLayouts(
  document: FusedDocument,
  prepared: ReadonlyMap<string, IPreparedDevice>,
): void {
  const problems: IFusedSessionProblem[] = [];
  document.instances.forEach((instance, index) => {
    const layout = instance.viewLayout;
    if (layout === undefined) {
      return;
    }
    const declared = prepared.get(instance.device)?.manifest.view ?? {};
    layout.views.forEach((view, at) => {
      if (!Object.hasOwn(declared, view.viewId)) {
        problems.push({
          code: 'document/invalid-view-layout',
          message: `Instance "${instance.id}" lays out the view "${view.viewId}", which ${instance.device} does not declare.`,
          pointer: `/instances/${String(index)}/viewLayout/views/${String(at)}/viewId`,
        });
      }
    });
  });
  if (problems.length > 0) {
    throw new FusedSessionError(
      'edit/invalid-document',
      problems[0]?.message ?? 'A saved view layout is invalid.',
      { problems },
    );
  }
}
