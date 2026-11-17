/** Reading and validation of device 2D geometry (RFC 0022). */
import { FusedDocumentError } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';
import type { Geometry2D, PinGeometry2D, Point2D, Rect2D } from './types/geometry';
import { extensionProblem, isPinId, packagePathProblem } from './rules';
import {
  deepFreeze,
  forbidUnknownFields,
  hasErrors,
  hasOwn,
  isRecord,
  parseJsonInput,
  readBooleanField,
  readNumberField,
  readObjectField,
  readStringField,
  report,
  compareStrings,
} from './read';

/**
 * Parses a `Geometry2D` declaration (RFC 0022).
 *
 * `pins` is the authoritative pin id set; when given, the geometry pin keys must match it exactly.
 *
 * @throws {FusedDocumentError} with the diagnostic code and JSON Pointer of every violation.
 */
export function parseGeometry2D(value: unknown, pins?: readonly string[]): Geometry2D {
  const diagnostics: FusedDiagnostic[] = [];
  const parsed = parseJsonInput(value, diagnostics);
  const geometry = parsed.ok ? readGeometry2D(parsed.value, [], diagnostics, pins) : undefined;
  if (geometry === undefined || hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }
  return deepFreeze(geometry);
}

/** Reads one geometry value at `path`; `undefined` when it does not match the contract. */
export function readGeometry2D(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  pins: readonly string[] | undefined,
): Geometry2D | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Geometry must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(
    value,
    ['sizing', 'bounds', 'bodyBounds', 'bodyImage', 'pins', 'designator'],
    path,
    diagnostics,
  );

  const sizing = readSizing(value, path, diagnostics);
  const bounds = readRect2D(
    readObjectField(value, 'bounds', path, diagnostics),
    [...path, 'bounds'],
    diagnostics,
  );
  const bodyBounds = readRect2D(
    readObjectField(value, 'bodyBounds', path, diagnostics),
    [...path, 'bodyBounds'],
    diagnostics,
  );
  const bodyImage = readBodyImage(value, path, diagnostics);
  const pinGeometry = readPins(value, path, diagnostics);
  const designator = hasOwn(value, 'designator')
    ? readPoint2D(value['designator'], [...path, 'designator'], diagnostics)
    : undefined;

  if (bounds !== undefined && bodyBounds !== undefined && !rectInside(bodyBounds, bounds)) {
    report(diagnostics, 'view2d/invalid-geometry', 'The body bounds must lie inside the bounds.', [
      ...path,
      'bodyBounds',
    ]);
  }
  if (pinGeometry !== undefined && pins !== undefined) {
    checkPinIds(pinGeometry, pins, path, diagnostics);
  }

  if (
    sizing === undefined ||
    bounds === undefined ||
    bodyBounds === undefined ||
    pinGeometry === undefined ||
    (hasOwn(value, 'designator') && designator === undefined)
  ) {
    return undefined;
  }
  return {
    sizing,
    bounds,
    bodyBounds,
    ...(bodyImage === undefined ? {} : { bodyImage }),
    pins: pinGeometry,
    ...(designator === undefined ? {} : { designator }),
  };
}

function readSizing(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Geometry2D['sizing'] | undefined {
  const sizing = readStringField(value, 'sizing', path, diagnostics, true, { nonEmpty: true });
  if (sizing === undefined) {
    return undefined;
  }
  if (sizing !== 'physical' && sizing !== 'flexible') {
    report(
      diagnostics,
      'view2d/invalid-geometry',
      'Field "sizing" must be "physical" or "flexible".',
      [...path, 'sizing'],
    );
    return undefined;
  }
  return sizing;
}

function readBodyImage(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): string | undefined {
  const bodyImage = readStringField(value, 'bodyImage', path, diagnostics, false, {
    nonEmpty: true,
  });
  if (bodyImage === undefined) {
    return undefined;
  }
  const pathProblem = packagePathProblem(bodyImage);
  if (pathProblem !== undefined) {
    report(diagnostics, 'view2d/invalid-geometry', `Field "bodyImage" ${pathProblem}.`, [
      ...path,
      'bodyImage',
    ]);
    return undefined;
  }
  const extensionIssue = extensionProblem(bodyImage, ['.png', '.svg']);
  if (extensionIssue !== undefined) {
    report(diagnostics, 'view2d/invalid-geometry', `Field "bodyImage" ${extensionIssue}.`, [
      ...path,
      'bodyImage',
    ]);
    return undefined;
  }
  return bodyImage;
}

function readPins(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Record<string, PinGeometry2D> | undefined {
  const rawPins = readObjectField(value, 'pins', path, diagnostics);
  if (rawPins === undefined) {
    return undefined;
  }
  const pins: Record<string, PinGeometry2D> = Object.create(null) as Record<string, PinGeometry2D>;
  let failed = false;
  for (const [pinId, raw] of Object.entries(rawPins)) {
    const pinPath = [...path, 'pins', pinId];
    if (!isPinId(pinId)) {
      report(
        diagnostics,
        'view2d/invalid-geometry',
        `Pin id ${JSON.stringify(pinId)} is not a legal model pin name.`,
        pinPath,
      );
      failed = true;
      continue;
    }
    const pin = readPinGeometry(raw, pinPath, diagnostics);
    if (pin === undefined) {
      failed = true;
      continue;
    }
    pins[pinId] = pin;
  }
  return failed ? undefined : pins;
}

function readPinGeometry(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): PinGeometry2D | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Pin geometry must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['position', 'outward', 'label'], path, diagnostics);

  const position = readPoint2D(
    readObjectField(value, 'position', path, diagnostics),
    [...path, 'position'],
    diagnostics,
  );
  const outward = readPoint2D(
    readObjectField(value, 'outward', path, diagnostics),
    [...path, 'outward'],
    diagnostics,
  );
  if (outward !== undefined && outward.x === 0 && outward.y === 0) {
    report(diagnostics, 'view2d/invalid-geometry', 'Field "outward" must be a non-zero vector.', [
      ...path,
      'outward',
    ]);
    return undefined;
  }

  let label: PinGeometry2D['label'];
  if (hasOwn(value, 'label')) {
    const rawLabel = value['label'];
    const labelPath = [...path, 'label'];
    if (!isRecord(rawLabel)) {
      report(diagnostics, 'schema/invalid-type', 'Field "label" must be an object.', labelPath);
      return undefined;
    }
    forbidUnknownFields(rawLabel, ['position', 'visible'], labelPath, diagnostics);
    const labelPosition = readPoint2D(
      readObjectField(rawLabel, 'position', labelPath, diagnostics),
      [...labelPath, 'position'],
      diagnostics,
    );
    const visible = readBooleanField(rawLabel, 'visible', labelPath, diagnostics, false);
    if (labelPosition === undefined) {
      return undefined;
    }
    label = { position: labelPosition, ...(visible === undefined ? {} : { visible }) };
  }

  if (position === undefined || outward === undefined) {
    return undefined;
  }
  return { position, outward, ...(label === undefined ? {} : { label }) };
}

function readRect2D(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Rect2D | undefined {
  if (value === undefined) {
    return undefined;
  }
  forbidUnknownFields(value, ['x', 'y', 'width', 'height'], path, diagnostics);
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const width = readNumberField(value, 'width', path, diagnostics);
  const height = readNumberField(value, 'height', path, diagnostics);
  if (width !== undefined && width <= 0) {
    report(diagnostics, 'schema/invalid-value', 'Field "width" must be positive.', [
      ...path,
      'width',
    ]);
    return undefined;
  }
  if (height !== undefined && height <= 0) {
    report(diagnostics, 'schema/invalid-value', 'Field "height" must be positive.', [
      ...path,
      'height',
    ]);
    return undefined;
  }
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

export function readPoint2D(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Point2D | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Point must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['x', 'y'], path, diagnostics);
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function rectInside(inner: Rect2D, outer: Rect2D): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function checkPinIds(
  geometry: Readonly<Record<string, PinGeometry2D>>,
  declared: readonly string[],
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): void {
  const geometryIds = Object.keys(geometry).sort(compareStrings);
  const declaredIds = [...declared].sort(compareStrings);
  const missing = declaredIds.filter((pin) => !geometryIds.includes(pin));
  const extra = geometryIds.filter((pin) => !declaredIds.includes(pin));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const details = [
    missing.length === 0 ? undefined : `missing ${missing.map(quote).join(', ')}`,
    extra.length === 0 ? undefined : `undeclared ${extra.map(quote).join(', ')}`,
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join('; ');
  report(
    diagnostics,
    'view2d/pin-mismatch',
    `Geometry pins must match the device pins: ${details}.`,
    [...path, 'pins'],
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}
