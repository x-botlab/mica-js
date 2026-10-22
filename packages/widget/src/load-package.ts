import { parsePayloadType } from '@mica-js/core/canvas';
import { WidgetLoadError, type WidgetLoadErrorCode } from './errors';
import type { PortDefinition, PropertyDefinition, WidgetDefinition, WidgetModule } from './types';

/** Read-only view of the files that make up one package. */
export interface PackageFiles {
  /** Human-readable label used in diagnostics. */
  readonly label: string;
  /** Reads a package-relative POSIX path and resolves to its bytes. */
  read(path: string): Promise<Uint8Array>;
}

export interface WidgetPackage {
  readonly id: string;
  readonly version: string;
  /** SHA-256 (hex) over the implementation sources concatenated in widget-id order. */
  readonly contentHash: string;
  readonly modules: Readonly<Record<string, WidgetModule>>;
}

const PACKAGE_JSON = 'package.json';
const JSON_EXTENSION = '.json';
const IMPLEMENTATION_EXTENSION = '.js';
/** Package and widget ids are stable kebab-case identifiers (see #1). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface WidgetEntry {
  readonly id: string;
  readonly path: string;
  readonly displayName: string | undefined;
  readonly description: string | undefined;
}

interface PackageManifest {
  readonly id: string;
  readonly version: string;
  readonly widgets: readonly WidgetEntry[];
}

/**
 * Reads a package manifest, every declared widget definition and its paired implementation.
 * Only the three declared path kinds are read; the package is never enumerated.
 *
 * @throws {WidgetLoadError}
 */
export async function loadWidgetPackage(files: PackageFiles): Promise<WidgetPackage> {
  const manifest = await readManifest(files);
  const modules: Record<string, WidgetModule> = {};
  const sources: string[] = [];

  for (const entry of manifest.widgets) {
    const definition = await readDefinition(files, manifest.id, entry);
    const implementationPath = toImplementationPath(entry.path);
    const code = await readImplementation(files, manifest.id, entry.id, implementationPath);
    assertSelfContained(code, manifest.id, implementationPath);
    modules[entry.id] = { definition, code };
    sources.push(code);
  }

  const contentHash = await sha256Hex(sources.join(''), manifest.id);
  return { id: manifest.id, version: manifest.version, contentHash, modules };
}

async function readManifest(files: PackageFiles): Promise<PackageManifest> {
  let bytes: Uint8Array;
  try {
    bytes = await files.read(PACKAGE_JSON);
  } catch (cause) {
    throw new WidgetLoadError(
      'widget/package-not-found',
      `Package ${JSON.stringify(files.label)} has no readable ${PACKAGE_JSON}.`,
      { path: PACKAGE_JSON, cause },
    );
  }

  const manifest = requireObject(
    parseJson(bytes, 'widget/invalid-manifest', PACKAGE_JSON, undefined, PACKAGE_JSON),
    'widget/invalid-manifest',
    `${PACKAGE_JSON} must be a JSON object`,
    undefined,
    PACKAGE_JSON,
  );

  const id = manifest['name'];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `${PACKAGE_JSON} must declare a kebab-case "name".`,
      { path: PACKAGE_JSON },
    );
  }

  const version = manifest['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Package ${JSON.stringify(id)} must declare a non-empty "version".`,
      { packageId: id, path: PACKAGE_JSON },
    );
  }

  const widgetsValue = manifest['widgets'];
  const widgets =
    widgetsValue === undefined
      ? {}
      : requireObject(
          widgetsValue,
          'widget/invalid-manifest',
          `Package ${JSON.stringify(id)} "widgets" must be an object`,
          id,
          PACKAGE_JSON,
        );

  const entries = Object.keys(widgets)
    .sort()
    .map((widgetId) => readEntry(widgets[widgetId], widgetId, id));

  return { id, version, widgets: entries };
}

function readEntry(value: unknown, widgetId: string, packageId: string): WidgetEntry {
  if (!ID_PATTERN.test(widgetId)) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Package ${JSON.stringify(packageId)} declares widget id ${JSON.stringify(widgetId)}; ids must be kebab-case.`,
      { packageId, path: PACKAGE_JSON },
    );
  }

  const entry = requireObject(
    value,
    'widget/invalid-manifest',
    `Widget ${JSON.stringify(widgetId)} entry must be an object`,
    packageId,
    PACKAGE_JSON,
  );

  const path = entry['path'];
  if (typeof path !== 'string') {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Widget ${JSON.stringify(widgetId)} must declare a string "path".`,
      { packageId, path: PACKAGE_JSON },
    );
  }
  const problem = packagePathProblem(path);
  if (problem !== undefined) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Widget ${JSON.stringify(widgetId)} path ${JSON.stringify(path)} ${problem}.`,
      { packageId, path },
    );
  }
  if (!path.endsWith(JSON_EXTENSION)) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Widget ${JSON.stringify(widgetId)} path ${JSON.stringify(path)} must point at a ${JSON_EXTENSION} description.`,
      { packageId, path },
    );
  }

  return {
    id: widgetId,
    path,
    displayName: optionalString(entry, 'displayName', packageId, path),
    description: optionalString(entry, 'description', packageId, path),
  };
}

async function readDefinition(
  files: PackageFiles,
  packageId: string,
  entry: WidgetEntry,
): Promise<WidgetDefinition> {
  let bytes: Uint8Array;
  try {
    bytes = await files.read(entry.path);
  } catch (cause) {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `Widget ${JSON.stringify(entry.id)} declares a missing definition at ${JSON.stringify(entry.path)}.`,
      { packageId, path: entry.path, cause },
    );
  }

  const record = requireObject(
    parseJson(bytes, 'widget/invalid-definition', entry.path, packageId, entry.path),
    'widget/invalid-definition',
    `Widget definition ${JSON.stringify(entry.path)} must be a JSON object`,
    packageId,
    entry.path,
  );

  const properties = readProperties(record['properties'], packageId, entry.path);
  const ports = readPorts(record['ports'], packageId, entry.path);

  return {
    properties,
    ports,
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  };
}

function readProperties(
  value: unknown,
  packageId: string,
  path: string,
): Readonly<Record<string, PropertyDefinition>> {
  if (value === undefined) {
    return {};
  }
  const record = requireObject(
    value,
    'widget/invalid-definition',
    `"properties" in ${JSON.stringify(path)} must be an object`,
    packageId,
    path,
  );

  const properties: Record<string, PropertyDefinition> = {};
  for (const [key, raw] of Object.entries(record)) {
    const descriptor = requireObject(
      raw,
      'widget/invalid-definition',
      `Property ${JSON.stringify(key)} in ${JSON.stringify(path)} must be an object`,
      packageId,
      path,
    );
    const type = descriptor['type'];
    if (typeof type !== 'string' || type.length === 0) {
      throw new WidgetLoadError(
        'widget/invalid-definition',
        `Property ${JSON.stringify(key)} in ${JSON.stringify(path)} must declare a non-empty string "type".`,
        { packageId, path },
      );
    }
    properties[key] = { ...descriptor, type };
  }
  return properties;
}

function readPorts(
  value: unknown,
  packageId: string,
  path: string,
): Readonly<Record<string, PortDefinition>> {
  if (value === undefined) {
    return {};
  }
  const record = requireObject(
    value,
    'widget/invalid-definition',
    `"ports" in ${JSON.stringify(path)} must be an object`,
    packageId,
    path,
  );

  const ports: Record<string, PortDefinition> = {};
  for (const [key, raw] of Object.entries(record)) {
    const descriptor = requireObject(
      raw,
      'widget/invalid-definition',
      `Port ${JSON.stringify(key)} in ${JSON.stringify(path)} must be an object`,
      packageId,
      path,
    );

    const direction = descriptor['direction'];
    if (direction !== 'input' && direction !== 'output') {
      throw new WidgetLoadError(
        'widget/invalid-definition',
        `Port ${JSON.stringify(key)} in ${JSON.stringify(path)} must declare "direction" as "input" or "output".`,
        { packageId, path },
      );
    }

    const typeName = descriptor['type'];
    if (typeof typeName !== 'string') {
      throw new WidgetLoadError(
        'widget/invalid-definition',
        `Port ${JSON.stringify(key)} in ${JSON.stringify(path)} must declare a string "type".`,
        { packageId, path },
      );
    }
    const type = parsePayloadType(typeName);
    if (type === undefined) {
      throw new WidgetLoadError(
        'widget/invalid-definition',
        `Port ${JSON.stringify(key)} in ${JSON.stringify(path)} declares unknown payload type ${JSON.stringify(typeName)}.`,
        { packageId, path },
      );
    }

    const title = portText(descriptor, 'title', key, packageId, path);
    const description = portText(descriptor, 'description', key, packageId, path);
    ports[key] = {
      direction,
      type,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    };
  }
  return ports;
}

async function readImplementation(
  files: PackageFiles,
  packageId: string,
  widgetId: string,
  path: string,
): Promise<string> {
  try {
    return decode(await files.read(path));
  } catch (cause) {
    throw new WidgetLoadError(
      'widget/no-implementation',
      `Widget ${JSON.stringify(widgetId)} in package ${JSON.stringify(packageId)} has no implementation at ${JSON.stringify(path)}.`,
      { packageId, path, cause },
    );
  }
}

/** Rejects absolute paths, drive letters, backslashes and escaping `..` segments. */
function packagePathProblem(path: string): string | undefined {
  if (path.length === 0) {
    return 'must not be empty';
  }
  if (path.startsWith('/')) {
    return 'must be relative to the package root';
  }
  if (/^[A-Za-z]:/.test(path)) {
    return 'must not carry a drive letter';
  }
  if (path.includes('\\')) {
    return 'must use POSIX separators';
  }
  if (path.split('/').includes('..')) {
    return 'must stay inside the package';
  }
  return undefined;
}

function toImplementationPath(definitionPath: string): string {
  return definitionPath.slice(0, -JSON_EXTENSION.length) + IMPLEMENTATION_EXTENSION;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  packageId: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new WidgetLoadError(
      'widget/invalid-manifest',
      `"${key}" in ${JSON.stringify(path)} must be a string.`,
      { packageId, path },
    );
  }
  return value;
}

function portText(
  record: Record<string, unknown>,
  key: 'title' | 'description',
  portId: string,
  packageId: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new WidgetLoadError(
      'widget/invalid-definition',
      `Port ${JSON.stringify(portId)} "${key}" in ${JSON.stringify(path)} must be a string.`,
      { packageId, path },
    );
  }
  return value;
}

function parseJson(
  bytes: Uint8Array,
  code: WidgetLoadErrorCode,
  what: string,
  packageId: string | undefined,
  path: string,
): unknown {
  try {
    return JSON.parse(decode(bytes)) as unknown;
  } catch (cause) {
    throw new WidgetLoadError(code, `${what} is not valid JSON.`, {
      path,
      cause,
      ...(packageId === undefined ? {} : { packageId }),
    });
  }
}

function requireObject(
  value: unknown,
  code: WidgetLoadErrorCode,
  message: string,
  packageId: string | undefined,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WidgetLoadError(code, `${message}.`, {
      path,
      ...(packageId === undefined ? {} : { packageId }),
    });
  }
  return value as Record<string, unknown>;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function assertSelfContained(code: string, packageId: string, path: string): void {
  const source = stripCommentsAndLiterals(code);
  if (STATIC_IMPORT.test(source) || REEXPORT_FROM.test(source)) {
    throw new WidgetLoadError(
      'widget/not-self-contained',
      `Implementation ${JSON.stringify(path)} must be a self-contained module: import and re-export statements are not allowed.`,
      { packageId, path },
    );
  }
  if (!DEFAULT_EXPORT.test(source)) {
    throw new WidgetLoadError(
      'widget/load-failed',
      `Implementation ${JSON.stringify(path)} must export a default widget factory.`,
      { packageId, path },
    );
  }
}

const STATIC_IMPORT = /(?:^|[^\w$.])import\s*(?:\(|[\w$*{'"])/;
const REEXPORT_FROM =
  /(?:^|[^\w$.])export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[\s\S]*?\}|[A-Za-z_$][\w$]*\s*,\s*\{[\s\S]*?\})\s*from\b/;
const DEFAULT_EXPORT =
  /(?:^|[^\w$.])export\s+default\b|(?:^|[^\w$.])export\s*\{[^}]*\bdefault\b[^}]*\}/;

/**
 * Blanks comments and string/template contents so keyword checks cannot match their text.
 * Quote characters are kept, so `import 'x'` still reads as an import.
 */
function stripCommentsAndLiterals(code: string): string {
  let result = '';
  let index = 0;

  while (index < code.length) {
    const char = code[index] ?? '';
    const next = code[index + 1];

    if (char === '/' && next === '/') {
      while (index < code.length && code[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) {
        result += code[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      result += char;
      index += 1;
      while (index < code.length && code[index] !== char) {
        if (code[index] === '\\') {
          result += '  ';
          index += 2;
          continue;
        }
        result += code[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < code.length) {
        result += char;
        index += 1;
      }
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

async function sha256Hex(text: string, packageId: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new WidgetLoadError(
      'widget/load-failed',
      'Computing the widget package content hash requires Web Crypto (globalThis.crypto.subtle).',
      { packageId, path: PACKAGE_JSON },
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
