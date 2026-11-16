/** Reading and validation of the fused `.sch` version 2 document (RFC 0024). */
import { isUuidV4 } from '../format/uuid';
import { FusedDocumentError } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';
import { readPropertyValue } from './resource';
import { readPoint2D } from './geometry';
import { FUSED_DOCUMENT_VERSION } from './types/document';
import type {
  ConnectionNode,
  ConnectionWire,
  DeviceDependency,
  Endpoint,
  FusedDisplaySettings,
  FusedDocument,
  FusedInstance,
  HtmlViewLayout,
  InstanceViewLayout,
  NetLabel,
  Placement2D,
  SidebarViewLayout,
  VoltageReference,
} from './types/document';
import type { PropertyValue } from './types/property';
import { deviceIdProblem, integrityProblem, isMemberKey, isSemVer } from './rules';
import {
  deepFreeze,
  forbidUnknownFields,
  hasErrors,
  hasOwn,
  isRecord,
  parseJsonInput,
  readArrayField,
  readBooleanField,
  readIntegerField,
  readNumberField,
  readObjectField,
  readStringField,
  report,
} from './read';

const DOCUMENT_FIELDS = [
  'version',
  'dependencies',
  'instances',
  'nodes',
  'wires',
  'labels',
  'references',
  'display',
] as const;

interface Collected<T> {
  readonly items: readonly { readonly value: T; readonly path: readonly string[] }[];
  readonly failed: boolean;
}

/**
 * Parses a fused `.sch` version 2 document (RFC 0024).
 *
 * Strings are parsed as JSON text; any other value is validated as-is.
 *
 * @throws {FusedDocumentError} with the diagnostic code and JSON Pointer of every violation.
 */
export function parseFusedDocument(input: unknown): FusedDocument {
  const diagnostics: FusedDiagnostic[] = [];
  const parsed = parseJsonInput(input, diagnostics);
  if (!parsed.ok) {
    throw new FusedDocumentError(diagnostics);
  }
  const document = readDocument(parsed.value, diagnostics);
  if (document === undefined || hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }
  return deepFreeze(document);
}

function readDocument(value: unknown, diagnostics: FusedDiagnostic[]): FusedDocument | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'json/not-object', 'Fused schematic must be a JSON object.', []);
    return undefined;
  }
  forbidUnknownFields(value, DOCUMENT_FIELDS, [], diagnostics);

  const version = readVersion(value, diagnostics);
  const dependencies = readDependencies(
    readObjectField(value, 'dependencies', [], diagnostics),
    ['dependencies'],
    diagnostics,
  );
  const instances = readCollection(value, 'instances', [], diagnostics, readInstance);
  const nodes = readCollection(value, 'nodes', [], diagnostics, readNode);
  const wires = readCollection(value, 'wires', [], diagnostics, readWire);
  const labels = readCollection(value, 'labels', [], diagnostics, readLabel);
  const references = readCollection(value, 'references', [], diagnostics, readReference);
  const display = hasOwn(value, 'display')
    ? readDisplay(value['display'], ['display'], diagnostics)
    : undefined;

  checkDuplicateIds(instances, nodes, wires, labels, references, diagnostics);
  checkDuplicateDesignators(instances, diagnostics);

  const instanceIds = new Set(instances.items.map((item) => item.value.id));
  const nodeIds = new Set(nodes.items.map((item) => item.value.id));

  if (dependencies !== undefined) {
    for (const item of instances.items) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, item.value.device)) {
        report(
          diagnostics,
          'document/unlocked-device',
          `Instance device "${item.value.device}" is not locked by "dependencies".`,
          [...item.path, 'device'],
        );
      }
    }
  }

  for (const item of wires.items) {
    const fromPath = [...item.path, 'from'];
    const toPath = [...item.path, 'to'];
    checkEndpoint(item.value.from, fromPath, instanceIds, nodeIds, diagnostics);
    checkEndpoint(item.value.to, toPath, instanceIds, nodeIds, diagnostics);
    if (sameEndpoint(item.value.from, item.value.to)) {
      report(
        diagnostics,
        'connection/self-edge',
        'A wire must not connect an endpoint to itself.',
        toPath,
      );
    }
  }
  for (const item of labels.items) {
    checkEndpoint(item.value.target, [...item.path, 'target'], instanceIds, nodeIds, diagnostics);
  }
  for (const item of references.items) {
    checkEndpoint(item.value.target, [...item.path, 'target'], instanceIds, nodeIds, diagnostics);
  }

  if (
    version === undefined ||
    dependencies === undefined ||
    instances.failed ||
    nodes.failed ||
    wires.failed ||
    labels.failed ||
    references.failed ||
    (hasOwn(value, 'display') && display === undefined)
  ) {
    return undefined;
  }

  return {
    version,
    dependencies,
    instances: instances.items.map((item) => item.value),
    nodes: nodes.items.map((item) => item.value),
    wires: wires.items.map((item) => item.value),
    labels: labels.items.map((item) => item.value),
    references: references.items.map((item) => item.value),
    ...(display === undefined ? {} : { display }),
  };
}

function readVersion(
  value: Record<string, unknown>,
  diagnostics: FusedDiagnostic[],
): typeof FUSED_DOCUMENT_VERSION | undefined {
  const version = readIntegerField(value, 'version', [], diagnostics);
  if (version === undefined) {
    return undefined;
  }
  if (version !== FUSED_DOCUMENT_VERSION) {
    report(
      diagnostics,
      'schema/unsupported-version',
      `Unsupported version ${String(version)}; expected ${String(FUSED_DOCUMENT_VERSION)}.`,
      ['version'],
    );
    return undefined;
  }
  return FUSED_DOCUMENT_VERSION;
}

function readCollection<T>(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  readItem: (
    raw: unknown,
    itemPath: readonly string[],
    itemDiagnostics: FusedDiagnostic[],
  ) => T | undefined,
): Collected<T> {
  const raw = readArrayField(value, key, path, diagnostics);
  if (raw === undefined) {
    return { items: [], failed: true };
  }
  const items: { readonly value: T; readonly path: readonly string[] }[] = [];
  let failed = false;
  raw.forEach((entry, index) => {
    const itemPath = [...path, key, String(index)];
    const item = readItem(entry, itemPath, diagnostics);
    if (item === undefined) {
      failed = true;
      return;
    }
    items.push({ value: item, path: itemPath });
  });
  return { items, failed };
}

function readDependencies(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Record<string, DeviceDependency> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const dependencies: Record<string, DeviceDependency> = Object.create(null) as Record<
    string,
    DeviceDependency
  >;
  let failed = false;
  for (const [deviceId, raw] of Object.entries(value)) {
    const dependencyPath = [...path, deviceId];
    const idProblem = deviceIdProblem(deviceId);
    if (idProblem !== undefined) {
      report(
        diagnostics,
        'schema/invalid-value',
        `Dependency key ${JSON.stringify(deviceId)} ${idProblem}.`,
        dependencyPath,
      );
      failed = true;
      continue;
    }
    if (!isRecord(raw)) {
      report(diagnostics, 'schema/invalid-type', 'Dependency must be an object.', dependencyPath);
      failed = true;
      continue;
    }
    forbidUnknownFields(raw, ['version', 'integrity'], dependencyPath, diagnostics);
    const version = readStringField(raw, 'version', dependencyPath, diagnostics, true, {
      nonEmpty: true,
    });
    if (version !== undefined && !isSemVer(version)) {
      report(
        diagnostics,
        'schema/invalid-value',
        'Dependency "version" must be a full SemVer version.',
        [...dependencyPath, 'version'],
      );
      failed = true;
    }
    const integrity = readStringField(raw, 'integrity', dependencyPath, diagnostics, true, {
      nonEmpty: true,
    });
    const integrityIssue = integrity === undefined ? undefined : integrityProblem(integrity);
    if (integrityIssue !== undefined) {
      report(diagnostics, 'schema/invalid-value', `Dependency "integrity" ${integrityIssue}.`, [
        ...dependencyPath,
        'integrity',
      ]);
      failed = true;
    }
    if (version === undefined || integrity === undefined || integrityIssue !== undefined) {
      failed = true;
      continue;
    }
    dependencies[deviceId] = { version, integrity };
  }
  return failed ? undefined : dependencies;
}

function readInstance(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): FusedInstance | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Instance must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(
    raw,
    ['id', 'device', 'designator', 'placement', 'properties', 'display', 'viewLayout'],
    path,
    diagnostics,
  );
  const id = readUuid(raw, 'id', path, diagnostics);
  const device = readStringField(raw, 'device', path, diagnostics, true, { nonEmpty: true });
  const deviceProblem = device === undefined ? undefined : deviceIdProblem(device);
  if (deviceProblem !== undefined) {
    report(diagnostics, 'schema/invalid-value', `Field "device" ${deviceProblem}.`, [
      ...path,
      'device',
    ]);
  }
  const designator = readStringField(raw, 'designator', path, diagnostics, false, {
    nonEmpty: true,
  });
  const placement = hasOwn(raw, 'placement')
    ? readPlacement(raw['placement'], [...path, 'placement'], diagnostics)
    : undefined;
  if (!hasOwn(raw, 'placement')) {
    report(diagnostics, 'schema/missing-field', 'Missing required field "placement".', [
      ...path,
      'placement',
    ]);
  }
  const properties = hasOwn(raw, 'properties')
    ? readProperties(raw['properties'], [...path, 'properties'], diagnostics)
    : undefined;
  const bodyDisplay = hasOwn(raw, 'display')
    ? readInstanceDisplay(raw['display'], [...path, 'display'], diagnostics)
    : undefined;
  const viewLayout = hasOwn(raw, 'viewLayout')
    ? readViewLayout(raw['viewLayout'], [...path, 'viewLayout'], diagnostics)
    : undefined;

  if (
    id === undefined ||
    device === undefined ||
    deviceProblem !== undefined ||
    placement === undefined ||
    (hasOwn(raw, 'properties') && properties === undefined) ||
    (hasOwn(raw, 'display') && bodyDisplay === undefined) ||
    (hasOwn(raw, 'viewLayout') && viewLayout === undefined) ||
    (hasOwn(raw, 'designator') && designator === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    device,
    ...(designator === undefined ? {} : { designator }),
    placement,
    ...(properties === undefined ? {} : { properties }),
    ...(bodyDisplay === undefined ? {} : { display: bodyDisplay }),
    ...(viewLayout === undefined ? {} : { viewLayout }),
  };
}

function readPlacement(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Placement2D | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Placement must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['x', 'y', 'rotation', 'width', 'height'], path, diagnostics);
  const x = readNumberField(raw, 'x', path, diagnostics);
  const y = readNumberField(raw, 'y', path, diagnostics);
  const rotation = readNumberField(raw, 'rotation', path, diagnostics);
  const hasWidth = hasOwn(raw, 'width');
  const hasHeight = hasOwn(raw, 'height');
  const width = readNumberField(raw, 'width', path, diagnostics, hasWidth);
  const height = readNumberField(raw, 'height', path, diagnostics, hasHeight);
  let failed = false;
  if (hasWidth !== hasHeight) {
    report(
      diagnostics,
      'schema/invalid-value',
      'Flexible placement must declare "width" and "height" together.',
      path,
    );
    failed = true;
  }
  if (width !== undefined && width <= 0) {
    report(diagnostics, 'schema/invalid-value', 'Field "width" must be positive.', [
      ...path,
      'width',
    ]);
    failed = true;
  }
  if (height !== undefined && height <= 0) {
    report(diagnostics, 'schema/invalid-value', 'Field "height" must be positive.', [
      ...path,
      'height',
    ]);
    failed = true;
  }
  if (failed || x === undefined || y === undefined || rotation === undefined) {
    return undefined;
  }
  return {
    x,
    y,
    rotation,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function readProperties(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Readonly<Record<string, PropertyValue>> | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Field "properties" must be an object.', path);
    return undefined;
  }
  const properties: Record<string, PropertyValue> = Object.create(null) as Record<
    string,
    PropertyValue
  >;
  let failed = false;
  for (const [key, value] of Object.entries(raw)) {
    const entryPath = [...path, key];
    if (!isMemberKey(key)) {
      report(
        diagnostics,
        'schema/invalid-value',
        `Property key ${JSON.stringify(key)} must match [A-Za-z][A-Za-z0-9]*.`,
        entryPath,
      );
      failed = true;
      continue;
    }
    const property = readPropertyValue(value, entryPath, diagnostics);
    if (property === undefined) {
      failed = true;
      continue;
    }
    properties[key] = property;
  }
  return failed ? undefined : properties;
}

function readInstanceDisplay(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): { readonly body?: boolean } | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Field "display" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['body'], path, diagnostics);
  const body = readBooleanField(raw, 'body', path, diagnostics, false);
  if (hasOwn(raw, 'body') && body === undefined) {
    return undefined;
  }
  return { ...(body === undefined ? {} : { body }) };
}

function readDisplay(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): FusedDisplaySettings | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Field "display" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['body', 'designators'], path, diagnostics);
  const body = readBooleanField(raw, 'body', path, diagnostics, false);
  const designators = readBooleanField(raw, 'designators', path, diagnostics, false);
  if (
    (hasOwn(raw, 'body') && body === undefined) ||
    (hasOwn(raw, 'designators') && designators === undefined)
  ) {
    return undefined;
  }
  return {
    ...(body === undefined ? {} : { body }),
    ...(designators === undefined ? {} : { designators }),
  };
}

function readViewLayout(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): InstanceViewLayout | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Field "viewLayout" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['properties', 'views'], path, diagnostics);
  const propertiesPath = [...path, 'properties'];
  const rawProperties = readObjectField(raw, 'properties', path, diagnostics);
  const properties =
    rawProperties === undefined
      ? undefined
      : readSidebarLayout(rawProperties, propertiesPath, diagnostics);

  const rawViews = readArrayField(raw, 'views', path, diagnostics);
  let failed = false;
  const views: HtmlViewLayout[] = [];
  const seen = new Set<string>();
  if (rawViews !== undefined) {
    rawViews.forEach((entry, index) => {
      const viewPath = [...path, 'views', String(index)];
      const view = readHtmlViewLayout(entry, viewPath, diagnostics);
      if (view === undefined) {
        failed = true;
        return;
      }
      if (seen.has(view.viewId)) {
        report(
          diagnostics,
          'document/invalid-view-layout',
          `View id "${view.viewId}" is laid out more than once.`,
          viewPath,
        );
        failed = true;
        return;
      }
      seen.add(view.viewId);
      views.push(view);
    });
  }
  if (failed || properties === undefined || rawViews === undefined) {
    return undefined;
  }
  return { properties, views };
}

function readSidebarLayout(
  raw: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): SidebarViewLayout | undefined {
  forbidUnknownFields(raw, ['height', 'collapsed'], path, diagnostics);
  const height = readNumberField(raw, 'height', path, diagnostics);
  const collapsed = readBooleanField(raw, 'collapsed', path, diagnostics);
  let failed = false;
  if (height !== undefined && height <= 0) {
    report(
      diagnostics,
      'document/invalid-view-layout',
      'Layout "height" must be a finite positive number.',
      [...path, 'height'],
    );
    failed = true;
  }
  if (failed || height === undefined || collapsed === undefined) {
    return undefined;
  }
  return { height, collapsed };
}

function readHtmlViewLayout(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): HtmlViewLayout | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'HTML view layout must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(
    raw,
    ['viewId', 'location', 'height', 'collapsed', 'floatingBounds'],
    path,
    diagnostics,
  );
  const viewId = readStringField(raw, 'viewId', path, diagnostics, true, { nonEmpty: true });
  const location = readStringField(raw, 'location', path, diagnostics, true, { nonEmpty: true });
  let failed = false;
  let resolvedLocation: HtmlViewLayout['location'] | undefined;
  if (location !== undefined) {
    if (location === 'sidebar' || location === 'floating') {
      resolvedLocation = location;
    } else {
      report(
        diagnostics,
        'document/invalid-view-layout',
        'Field "location" must be "sidebar" or "floating".',
        [...path, 'location'],
      );
      failed = true;
    }
  }
  const height = readNumberField(raw, 'height', path, diagnostics);
  const collapsed = readBooleanField(raw, 'collapsed', path, diagnostics);
  if (height !== undefined && height <= 0) {
    report(
      diagnostics,
      'document/invalid-view-layout',
      'Layout "height" must be a finite positive number.',
      [...path, 'height'],
    );
    failed = true;
  }
  let floatingBounds: HtmlViewLayout['floatingBounds'];
  if (hasOwn(raw, 'floatingBounds')) {
    const boundsPath = [...path, 'floatingBounds'];
    const rawBounds = raw['floatingBounds'];
    if (!isRecord(rawBounds)) {
      report(
        diagnostics,
        'document/invalid-view-layout',
        'Field "floatingBounds" must be an object.',
        boundsPath,
      );
      failed = true;
    } else {
      forbidUnknownFields(rawBounds, ['x', 'y', 'width', 'height'], boundsPath, diagnostics);
      const x = readNumberField(rawBounds, 'x', boundsPath, diagnostics);
      const y = readNumberField(rawBounds, 'y', boundsPath, diagnostics);
      const width = readNumberField(rawBounds, 'width', boundsPath, diagnostics);
      const boundsHeight = readNumberField(rawBounds, 'height', boundsPath, diagnostics);
      if (width !== undefined && width <= 0) {
        report(
          diagnostics,
          'document/invalid-view-layout',
          'Floating bounds "width" must be a finite positive number.',
          [...boundsPath, 'width'],
        );
        failed = true;
      }
      if (boundsHeight !== undefined && boundsHeight <= 0) {
        report(
          diagnostics,
          'document/invalid-view-layout',
          'Floating bounds "height" must be a finite positive number.',
          [...boundsPath, 'height'],
        );
        failed = true;
      }
      if (x !== undefined && y !== undefined && width !== undefined && boundsHeight !== undefined) {
        floatingBounds = { x, y, width, height: boundsHeight };
      } else {
        failed = true;
      }
    }
  }
  if (
    failed ||
    viewId === undefined ||
    resolvedLocation === undefined ||
    height === undefined ||
    collapsed === undefined
  ) {
    return undefined;
  }
  return {
    viewId,
    location: resolvedLocation,
    height,
    collapsed,
    ...(floatingBounds === undefined ? {} : { floatingBounds }),
  };
}

function readNode(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): ConnectionNode | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Node must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['id', 'kind', 'x', 'y'], path, diagnostics);
  const id = readUuid(raw, 'id', path, diagnostics);
  const kind = readStringField(raw, 'kind', path, diagnostics, true, { nonEmpty: true });
  const x = readNumberField(raw, 'x', path, diagnostics);
  const y = readNumberField(raw, 'y', path, diagnostics);
  let resolvedKind: ConnectionNode['kind'] | undefined;
  if (kind !== undefined) {
    if (kind === 'junction' || kind === 'free') {
      resolvedKind = kind;
    } else {
      report(diagnostics, 'schema/invalid-value', 'Field "kind" must be "junction" or "free".', [
        ...path,
        'kind',
      ]);
    }
  }
  if (id === undefined || resolvedKind === undefined || x === undefined || y === undefined) {
    return undefined;
  }
  return { id, kind: resolvedKind, x, y };
}

function readWire(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): ConnectionWire | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Wire must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['id', 'from', 'to', 'bends'], path, diagnostics);
  const id = readUuid(raw, 'id', path, diagnostics);
  const from = hasOwn(raw, 'from')
    ? readEndpoint(raw['from'], [...path, 'from'], diagnostics)
    : undefined;
  const to = hasOwn(raw, 'to') ? readEndpoint(raw['to'], [...path, 'to'], diagnostics) : undefined;
  const rawBends = readArrayField(raw, 'bends', path, diagnostics);
  const bends: { readonly x: number; readonly y: number }[] = [];
  let failed = false;
  if (rawBends !== undefined) {
    rawBends.forEach((entry, index) => {
      const point = readPoint2D(entry, [...path, 'bends', String(index)], diagnostics);
      if (point === undefined) {
        failed = true;
        return;
      }
      bends.push(point);
    });
  }
  if (id === undefined || from === undefined || to === undefined || rawBends === undefined) {
    return undefined;
  }
  if (failed) {
    return undefined;
  }
  return { id, from, to, bends };
}

function readEndpoint(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Endpoint | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Endpoint must be an object.', path);
    return undefined;
  }
  const kind = readStringField(raw, 'kind', path, diagnostics, true, { nonEmpty: true });
  if (kind === 'pin') {
    forbidUnknownFields(raw, ['kind', 'instance', 'pin'], path, diagnostics);
    const instance = readStringField(raw, 'instance', path, diagnostics, true, { nonEmpty: true });
    const pin = readStringField(raw, 'pin', path, diagnostics, true, { nonEmpty: true });
    return instance === undefined || pin === undefined ? undefined : { kind: 'pin', instance, pin };
  }
  if (kind === 'node') {
    forbidUnknownFields(raw, ['kind', 'node'], path, diagnostics);
    const node = readStringField(raw, 'node', path, diagnostics, true, { nonEmpty: true });
    return node === undefined ? undefined : { kind: 'node', node };
  }
  if (kind !== undefined) {
    report(diagnostics, 'schema/invalid-value', 'Field "kind" must be "pin" or "node".', [
      ...path,
      'kind',
    ]);
  }
  return undefined;
}

function readLabel(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): NetLabel | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Net label must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(raw, ['id', 'target', 'name', 'offset'], path, diagnostics);
  const id = readUuid(raw, 'id', path, diagnostics);
  const target = hasOwn(raw, 'target')
    ? readEndpoint(raw['target'], [...path, 'target'], diagnostics)
    : undefined;
  if (!hasOwn(raw, 'target')) {
    report(diagnostics, 'schema/missing-field', 'Missing required field "target".', [
      ...path,
      'target',
    ]);
  }
  const name = readStringField(raw, 'name', path, diagnostics, true, { nonEmpty: true });
  const offset = hasOwn(raw, 'offset')
    ? readPoint2D(raw['offset'], [...path, 'offset'], diagnostics)
    : undefined;
  if (
    id === undefined ||
    target === undefined ||
    name === undefined ||
    (hasOwn(raw, 'offset') && offset === undefined)
  ) {
    return undefined;
  }
  return { id, target, name, ...(offset === undefined ? {} : { offset }) };
}

function readReference(
  raw: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): VoltageReference | undefined {
  if (!isRecord(raw)) {
    report(diagnostics, 'schema/invalid-type', 'Voltage reference must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(
    raw,
    ['id', 'target', 'voltage', 'symbol', 'rotation', 'label'],
    path,
    diagnostics,
  );
  const id = readUuid(raw, 'id', path, diagnostics);
  const target = hasOwn(raw, 'target')
    ? readEndpoint(raw['target'], [...path, 'target'], diagnostics)
    : undefined;
  if (!hasOwn(raw, 'target')) {
    report(diagnostics, 'schema/missing-field', 'Missing required field "target".', [
      ...path,
      'target',
    ]);
  }
  const voltage = readNumberField(raw, 'voltage', path, diagnostics);
  const rawSymbol = readStringField(raw, 'symbol', path, diagnostics, false, { nonEmpty: true });
  let symbol: VoltageReference['symbol'];
  let failed = false;
  if (rawSymbol !== undefined) {
    if (rawSymbol === 'power' || rawSymbol === 'ground') {
      symbol = rawSymbol;
    } else {
      report(diagnostics, 'schema/invalid-value', 'Field "symbol" must be "power" or "ground".', [
        ...path,
        'symbol',
      ]);
      failed = true;
    }
  }
  const rotation = readNumberField(raw, 'rotation', path, diagnostics, false);
  if (symbol === 'ground' && voltage !== undefined && voltage !== 0) {
    report(diagnostics, 'schema/invalid-value', 'A ground symbol requires "voltage": 0.', [
      ...path,
      'voltage',
    ]);
    failed = true;
  }
  let label: VoltageReference['label'];
  if (hasOwn(raw, 'label')) {
    if (symbol === undefined) {
      report(diagnostics, 'schema/invalid-value', 'Field "label" requires a declared "symbol".', [
        ...path,
        'label',
      ]);
      failed = true;
    } else {
      const labelPath = [...path, 'label'];
      const rawLabel = raw['label'];
      if (!isRecord(rawLabel)) {
        report(diagnostics, 'schema/invalid-type', 'Field "label" must be an object.', labelPath);
        failed = true;
      } else {
        forbidUnknownFields(rawLabel, ['name', 'offset'], labelPath, diagnostics);
        const name = readStringField(rawLabel, 'name', labelPath, diagnostics, true, {
          nonEmpty: true,
        });
        const offset = hasOwn(rawLabel, 'offset')
          ? readPoint2D(rawLabel['offset'], [...labelPath, 'offset'], diagnostics)
          : undefined;
        if (name === undefined || (hasOwn(rawLabel, 'offset') && offset === undefined)) {
          failed = true;
        } else {
          label = { name, ...(offset === undefined ? {} : { offset }) };
        }
      }
    }
  }
  if (
    failed ||
    id === undefined ||
    target === undefined ||
    voltage === undefined ||
    (hasOwn(raw, 'rotation') && rotation === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    target,
    voltage,
    ...(symbol === undefined ? {} : { symbol }),
    ...(rotation === undefined ? {} : { rotation }),
    ...(label === undefined ? {} : { label }),
  };
}

function readUuid(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): string | undefined {
  const id = readStringField(value, key, path, diagnostics, true, { nonEmpty: true });
  if (id === undefined) {
    return undefined;
  }
  if (!isUuidV4(id)) {
    report(diagnostics, 'schema/invalid-value', `Field "${key}" must be a UUID v4.`, [
      ...path,
      key,
    ]);
    return undefined;
  }
  return id;
}

function checkEndpoint(
  endpoint: Endpoint,
  path: readonly string[],
  instanceIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
  diagnostics: FusedDiagnostic[],
): void {
  if (endpoint.kind === 'pin') {
    if (!instanceIds.has(endpoint.instance)) {
      report(
        diagnostics,
        'connection/unknown-endpoint',
        `Endpoint references unknown instance "${endpoint.instance}".`,
        [...path, 'instance'],
      );
    }
    return;
  }
  if (!nodeIds.has(endpoint.node)) {
    report(
      diagnostics,
      'connection/unknown-endpoint',
      `Endpoint references unknown node "${endpoint.node}".`,
      [...path, 'node'],
    );
  }
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  if (a.kind === 'pin') {
    return b.kind === 'pin' && a.instance === b.instance && a.pin === b.pin;
  }
  return b.kind === 'node' && a.node === b.node;
}

function checkDuplicateIds(
  instances: Collected<FusedInstance>,
  nodes: Collected<ConnectionNode>,
  wires: Collected<ConnectionWire>,
  labels: Collected<NetLabel>,
  references: Collected<VoltageReference>,
  diagnostics: FusedDiagnostic[],
): void {
  const seen = new Set<string>();
  const collections: readonly Collected<{ readonly id: string }>[] = [
    instances,
    nodes,
    wires,
    labels,
    references,
  ];
  for (const collection of collections) {
    for (const item of collection.items) {
      if (seen.has(item.value.id)) {
        report(
          diagnostics,
          'document/duplicate-id',
          `Id "${item.value.id}" is used more than once in the document.`,
          [...item.path, 'id'],
        );
        continue;
      }
      seen.add(item.value.id);
    }
  }
}

function checkDuplicateDesignators(
  instances: Collected<FusedInstance>,
  diagnostics: FusedDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const item of instances.items) {
    const designator = item.value.designator;
    if (designator === undefined) {
      continue;
    }
    if (seen.has(designator)) {
      report(
        diagnostics,
        'document/duplicate-designator',
        `Designator ${JSON.stringify(designator)} is used more than once.`,
        [...item.path, 'designator'],
      );
      continue;
    }
    seen.add(designator);
  }
}
