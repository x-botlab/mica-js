/** Reading and validation of the unified device manifest (RFC 0020). */
import { FusedDocumentError } from './diagnostics';
import type { FusedDiagnostic, FusedDiagnosticCode } from './diagnostics';
import { readGeometry2D } from './geometry';
import { readPropertyDescriptors } from './manifest-properties';
import type { Geometry2D } from './types/geometry';
import type {
  HtmlViewDefinition,
  PinDeclaration,
  UnifiedDeviceEntries,
  UnifiedDeviceManifest,
  View2DDefinition,
} from './types/manifest';
import type { MethodDefinition, ModelDefinition, ValueType } from './types/model';
import {
  extensionProblem,
  isCodiconName,
  isDesignatorPrefix,
  isEventKey,
  isMemberKey,
  isNameSegment,
  isPinId,
  isSemVer,
  packagePathProblem,
} from './rules';
import { readTypeDeclarations, readValueType } from './value-type';
import {
  deepFreeze,
  forbidUnknownFields,
  hasErrors,
  hasOwn,
  isRecord,
  parseJsonInput,
  readObjectField,
  readStringField,
  report,
} from './read';

const DEVICE_ROOT_FIELDS = [
  'publisher',
  'name',
  'version',
  'description',
  'license',
  'engines',
  'displayName',
  'icon',
  'designatorPrefix',
  'entries',
  'properties',
  'pins',
  'model',
  'view2d',
  'view',
] as const;

/**
 * Package-manager fields are tolerated because a device manifest is also a published
 * `package.json`; they never override a device field.
 */
const PACKAGE_MANAGER_FIELDS = [
  '$schema',
  'author',
  'bugs',
  'bundleDependencies',
  'bundledDependencies',
  'contributors',
  'cpu',
  'dependencies',
  'devDependencies',
  'directories',
  'exports',
  'files',
  'funding',
  'homepage',
  'imports',
  'keywords',
  'main',
  'man',
  'module',
  'optionalDependencies',
  'os',
  'packageManager',
  'peerDependencies',
  'peerDependenciesMeta',
  'private',
  'publishConfig',
  'repository',
  'scripts',
  'sideEffects',
  'type',
  'types',
  'typings',
  'workspaces',
] as const;

/**
 * Parses a unified device manifest (RFC 0020).
 *
 * Strings are parsed as JSON text; any other value is validated as-is.
 *
 * @throws {FusedDocumentError} with the diagnostic code and JSON Pointer of every violation.
 */
export function parseUnifiedManifest(input: unknown): UnifiedDeviceManifest {
  const diagnostics: FusedDiagnostic[] = [];
  const parsed = parseJsonInput(input, diagnostics);
  if (!parsed.ok) {
    throw new FusedDocumentError(diagnostics);
  }
  const manifest = readManifest(parsed.value, diagnostics);
  if (manifest === undefined || hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }
  return deepFreeze(manifest);
}

function readManifest(
  value: unknown,
  diagnostics: FusedDiagnostic[],
): UnifiedDeviceManifest | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'json/not-object', 'Manifest must be a JSON object.', []);
    return undefined;
  }
  forbidUnknownFields(value, [...DEVICE_ROOT_FIELDS, ...PACKAGE_MANAGER_FIELDS], [], diagnostics);

  const publisher = readIdentity(value, 'publisher', diagnostics);
  const name = readIdentity(value, 'name', diagnostics);
  const version = readVersion(value, diagnostics);
  const description = readStringField(value, 'description', [], diagnostics, false);
  const license = readStringField(value, 'license', [], diagnostics, false);
  const engines = readEngines(value, [], diagnostics);
  const displayName = readStringField(value, 'displayName', [], diagnostics, true, {
    nonEmpty: true,
  });
  const icon = readIcon(value, [], diagnostics);
  const designatorPrefix = readDesignatorPrefix(value, [], diagnostics);
  const entries = hasOwn(value, 'entries')
    ? readEntries(value['entries'], ['entries'], diagnostics)
    : undefined;
  const properties = hasOwn(value, 'properties')
    ? readPropertyDescriptors(value['properties'], ['properties'], diagnostics)
    : undefined;
  const pins = hasOwn(value, 'pins') ? readPins(value['pins'], ['pins'], diagnostics) : undefined;
  const modelDeclared = hasOwn(value, 'model');
  const model = modelDeclared ? readModel(value['model'], ['model'], diagnostics) : undefined;
  const pinIds = Object.keys(pins ?? {});
  const view2d = hasOwn(value, 'view2d')
    ? readView2d(value['view2d'], ['view2d'], diagnostics, pinIds)
    : undefined;
  const view = hasOwn(value, 'view')
    ? readViewMap(value['view'], ['view'], diagnostics)
    : undefined;

  if (pinIds.length > 0 && !modelDeclared) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'A device that declares pins must declare its model.',
      ['model'],
    );
  }

  if (
    publisher === undefined ||
    name === undefined ||
    version === undefined ||
    engines === undefined ||
    displayName === undefined ||
    (hasOwn(value, 'icon') && icon === undefined) ||
    (hasOwn(value, 'designatorPrefix') && designatorPrefix === undefined) ||
    (hasOwn(value, 'entries') && entries === undefined) ||
    (hasOwn(value, 'properties') && properties === undefined) ||
    (hasOwn(value, 'pins') && pins === undefined) ||
    (modelDeclared && model === undefined) ||
    (hasOwn(value, 'view2d') && view2d === undefined) ||
    (hasOwn(value, 'view') && view === undefined)
  ) {
    return undefined;
  }

  return {
    publisher,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    ...(license === undefined ? {} : { license }),
    engines,
    displayName,
    ...(icon === undefined ? {} : { icon }),
    ...(designatorPrefix === undefined ? {} : { designatorPrefix }),
    ...(entries === undefined ? {} : { entries }),
    ...(properties === undefined ? {} : { properties }),
    ...(pins === undefined ? {} : { pins }),
    ...(model === undefined ? {} : { model }),
    ...(view2d === undefined ? {} : { view2d }),
    ...(view === undefined ? {} : { view }),
  };
}

function readIdentity(
  value: Record<string, unknown>,
  key: 'publisher' | 'name',
  diagnostics: FusedDiagnostic[],
): string | undefined {
  const identity = readStringField(value, key, [], diagnostics, true, { nonEmpty: true });
  if (identity === undefined) {
    return undefined;
  }
  if (!isNameSegment(identity)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      `Field "${key}" must match [a-z0-9]+(?:-[a-z0-9]+)*.`,
      [key],
    );
    return undefined;
  }
  return identity;
}

function readVersion(
  value: Record<string, unknown>,
  diagnostics: FusedDiagnostic[],
): string | undefined {
  const version = readStringField(value, 'version', [], diagnostics, true, { nonEmpty: true });
  if (version === undefined) {
    return undefined;
  }
  if (!isSemVer(version)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "version" must be a full SemVer version.',
      ['version'],
    );
    return undefined;
  }
  return version;
}

function readEngines(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): { readonly mica: string } | undefined {
  const engines = readObjectField(value, 'engines', path, diagnostics);
  if (engines === undefined) {
    return undefined;
  }
  const mica = readStringField(engines, 'mica', [...path, 'engines'], diagnostics, true, {
    nonEmpty: true,
  });
  return mica === undefined ? undefined : { mica };
}

function readIcon(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): string | undefined {
  return readPackageFilePath(
    value,
    'icon',
    path,
    diagnostics,
    ['.png', '.svg'],
    'package/invalid-icon',
    false,
  );
}

function readDesignatorPrefix(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): string | undefined {
  const prefix = readStringField(value, 'designatorPrefix', path, diagnostics, false, {
    nonEmpty: true,
  });
  if (prefix === undefined) {
    return undefined;
  }
  if (!isDesignatorPrefix(prefix)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "designatorPrefix" must be a non-empty alphanumeric prefix.',
      [...path, 'designatorPrefix'],
    );
    return undefined;
  }
  return prefix;
}

function readEntries(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): UnifiedDeviceEntries | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "entries" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['view3d'], path, diagnostics);
  const view3d = hasOwn(value, 'view3d')
    ? readPackageFilePath(value, 'view3d', path, diagnostics, ['.js'], 'package/invalid-path')
    : undefined;
  if (hasOwn(value, 'view3d') && view3d === undefined) {
    return undefined;
  }
  return { ...(view3d === undefined ? {} : { view3d }) };
}

function readPins(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Readonly<Record<string, PinDeclaration>> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "pins" must be an object.', path);
    return undefined;
  }
  const pins: Record<string, PinDeclaration> = Object.create(null) as Record<
    string,
    PinDeclaration
  >;
  let failed = false;
  for (const [pinId, raw] of Object.entries(value)) {
    const pinPath = [...path, pinId];
    if (!isPinId(pinId)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        `Pin id ${JSON.stringify(pinId)} is not a legal model pin name.`,
        pinPath,
      );
      failed = true;
      continue;
    }
    if (!isRecord(raw)) {
      report(diagnostics, 'schema/invalid-type', 'Pin declaration must be an object.', pinPath);
      failed = true;
      continue;
    }
    forbidUnknownFields(raw, ['label', 'description'], pinPath, diagnostics);
    const label = readStringField(raw, 'label', pinPath, diagnostics, false, { nonEmpty: true });
    const description = readStringField(raw, 'description', pinPath, diagnostics, false, {
      nonEmpty: true,
    });
    if (hasOwn(raw, 'label') && label === undefined) {
      failed = true;
      continue;
    }
    if (hasOwn(raw, 'description') && description === undefined) {
      failed = true;
      continue;
    }
    pins[pinId] = {
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
    };
  }
  return failed ? undefined : pins;
}

function readModel(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): ModelDefinition | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "model" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['entry', 'types', 'methods', 'events'], path, diagnostics);
  const entry = readPackageFilePath(
    value,
    'entry',
    path,
    diagnostics,
    ['.js'],
    'package/invalid-path',
  );

  const declared = new Set<string>();
  let types: Readonly<Record<string, ValueType>> | undefined;
  let failed = false;
  const rawTypes = hasOwn(value, 'types')
    ? readObjectField(value, 'types', path, diagnostics)
    : undefined;
  if (hasOwn(value, 'types') && rawTypes === undefined) {
    failed = true;
  } else if (rawTypes !== undefined) {
    const declarations = readTypeDeclarations(rawTypes, [...path, 'types'], diagnostics);
    types = declarations.types;
    for (const typeName of declarations.names) {
      declared.add(typeName);
    }
  }

  const methods = hasOwn(value, 'methods')
    ? readMethods(value['methods'], [...path, 'methods'], diagnostics, declared)
    : undefined;
  if (hasOwn(value, 'methods') && methods === undefined) {
    failed = true;
  }
  const events = hasOwn(value, 'events')
    ? readEvents(value['events'], [...path, 'events'], diagnostics, declared)
    : undefined;
  if (hasOwn(value, 'events') && events === undefined) {
    failed = true;
  }

  if (failed || entry === undefined) {
    return undefined;
  }
  return {
    entry,
    ...(types === undefined ? {} : { types }),
    ...(methods === undefined ? {} : { methods }),
    ...(events === undefined ? {} : { events }),
  };
}

function readMethods(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  declared: ReadonlySet<string>,
): Readonly<Record<string, MethodDefinition>> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "methods" must be an object.', path);
    return undefined;
  }
  const methods: Record<string, MethodDefinition> = Object.create(null) as Record<
    string,
    MethodDefinition
  >;
  let failed = false;
  for (const [key, raw] of Object.entries(value)) {
    const methodPath = [...path, key];
    if (!isMemberKey(key)) {
      report(
        diagnostics,
        'model/invalid-interface',
        `Method name ${JSON.stringify(key)} must match [A-Za-z][A-Za-z0-9]*.`,
        methodPath,
      );
      failed = true;
      continue;
    }
    if (!isRecord(raw)) {
      report(
        diagnostics,
        'schema/invalid-type',
        'Method declaration must be an object.',
        methodPath,
      );
      failed = true;
      continue;
    }
    forbidUnknownFields(raw, ['params', 'returns'], methodPath, diagnostics);
    const params = readRequiredValueType(raw, 'params', methodPath, diagnostics, declared);
    const returns = readRequiredValueType(raw, 'returns', methodPath, diagnostics, declared);
    if (params === undefined || returns === undefined) {
      failed = true;
      continue;
    }
    methods[key] = { params, returns };
  }
  return failed ? undefined : methods;
}

function readEvents(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  declared: ReadonlySet<string>,
): Readonly<Record<string, ValueType>> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "events" must be an object.', path);
    return undefined;
  }
  const events: Record<string, ValueType> = Object.create(null) as Record<string, ValueType>;
  let failed = false;
  for (const [key, raw] of Object.entries(value)) {
    const eventPath = [...path, key];
    if (!isEventKey(key)) {
      report(
        diagnostics,
        'model/invalid-interface',
        `Event name ${JSON.stringify(key)} must use the onDidXxx form.`,
        eventPath,
      );
      failed = true;
      continue;
    }
    const type = readValueType(raw, eventPath, diagnostics, declared);
    if (type === undefined) {
      failed = true;
      continue;
    }
    events[key] = type;
  }
  return failed ? undefined : events;
}

function readRequiredValueType(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  declared: ReadonlySet<string>,
): ValueType | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    return undefined;
  }
  return readValueType(value[key], fieldPath, diagnostics, declared);
}

function readView2d(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  pins: readonly string[],
): View2DDefinition | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "view2d" must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['geometry', 'entry'], path, diagnostics);

  let geometry: Geometry2D | string | undefined;
  if (!hasOwn(value, 'geometry')) {
    report(diagnostics, 'schema/missing-field', 'Missing required field "geometry".', [
      ...path,
      'geometry',
    ]);
  } else if (typeof value['geometry'] === 'string') {
    geometry = readPackageFilePath(
      value,
      'geometry',
      path,
      diagnostics,
      ['.json'],
      'package/invalid-path',
    );
  } else {
    geometry = readGeometry2D(value['geometry'], [...path, 'geometry'], diagnostics, pins);
  }
  const entry = hasOwn(value, 'entry')
    ? readPackageFilePath(value, 'entry', path, diagnostics, ['.js'], 'package/invalid-path')
    : undefined;

  if (geometry === undefined || (hasOwn(value, 'entry') && entry === undefined)) {
    return undefined;
  }
  return { geometry, ...(entry === undefined ? {} : { entry }) };
}

function readViewMap(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Readonly<Record<string, HtmlViewDefinition>> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "view" must be an object.', path);
    return undefined;
  }
  const views: Record<string, HtmlViewDefinition> = Object.create(null) as Record<
    string,
    HtmlViewDefinition
  >;
  let failed = false;
  for (const [viewId, raw] of Object.entries(value)) {
    const viewPath = [...path, viewId];
    if (!isMemberKey(viewId)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        `View id ${JSON.stringify(viewId)} must match [A-Za-z][A-Za-z0-9]*.`,
        viewPath,
      );
      failed = true;
      continue;
    }
    const view = readHtmlView(raw, viewPath, diagnostics);
    if (view === undefined) {
      failed = true;
      continue;
    }
    views[viewId] = view;
  }
  return failed ? undefined : views;
}

function readHtmlView(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): HtmlViewDefinition | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'HTML view declaration must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['title', 'entry', 'defaultLocation', 'icon'], path, diagnostics);
  const title = readStringField(value, 'title', path, diagnostics, true, { nonEmpty: true });
  const entry = readPackageFilePath(
    value,
    'entry',
    path,
    diagnostics,
    ['.html'],
    'package/invalid-path',
  );
  const defaultLocation = readStringField(value, 'defaultLocation', path, diagnostics, false, {
    nonEmpty: true,
  });
  const icon = readStringField(value, 'icon', path, diagnostics, false, { nonEmpty: true });

  let failed = false;
  let location: HtmlViewDefinition['defaultLocation'];
  if (defaultLocation !== undefined) {
    if (defaultLocation === 'sidebar' || defaultLocation === 'floating') {
      location = defaultLocation;
    } else {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Field "defaultLocation" must be "sidebar" or "floating".',
        [...path, 'defaultLocation'],
      );
      failed = true;
    }
  }
  if (icon !== undefined && !isCodiconName(icon)) {
    report(diagnostics, 'package/invalid-manifest', 'Field "icon" must be a Codicons icon name.', [
      ...path,
      'icon',
    ]);
    failed = true;
  }
  if (failed || title === undefined || entry === undefined) {
    return undefined;
  }
  return {
    title,
    entry,
    ...(location === undefined ? {} : { defaultLocation: location }),
    ...(icon === undefined ? {} : { icon }),
  };
}

function readPackageFilePath(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  extensions: readonly string[],
  code: FusedDiagnosticCode,
  required = true,
): string | undefined {
  const file = readStringField(value, key, path, diagnostics, required, { nonEmpty: true });
  if (file === undefined) {
    return undefined;
  }
  const pathProblem = packagePathProblem(file);
  if (pathProblem !== undefined) {
    report(diagnostics, code, `Field "${key}" ${pathProblem}.`, [...path, key]);
    return undefined;
  }
  const extensionIssue = extensionProblem(file, extensions);
  if (extensionIssue !== undefined) {
    report(diagnostics, code, `Field "${key}" ${extensionIssue}.`, [...path, key]);
    return undefined;
  }
  return file;
}
