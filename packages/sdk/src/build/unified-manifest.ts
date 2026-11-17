import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileDDL, type DeviceIR } from '@mica-js/ddl';
import { parseGeometry2D, parseUnifiedManifest } from '@mica-js/document/fused';
import type { Geometry2D, UnifiedDeviceManifest } from '@mica-js/document/fused';
import { checkModelAgreement } from '../fused/agreement.js';
import { isContained, isFile, packagePath } from './unified-paths.js';

export interface LoadedDevicePackage {
  /** Absolute path of the manifest file. */
  readonly manifestFile: string;
  /** Authored manifest value, emitted unchanged as the package manifest. */
  readonly authored: unknown;
  /** Validated manifest contract shared with hosts and the runtime. */
  readonly manifest: UnifiedDeviceManifest;
  /** Compiled model IR of the DDL source, when the project declares one. */
  readonly model?: DeviceIR;
  /** Absolute path of the DDL source. */
  readonly modelFile?: string;
  /** Resolved 2D geometry, which the build needs for the body image. */
  readonly geometry?: Geometry2D;
  /** Package path of the geometry JSON when the manifest references a file. */
  readonly geometryFile?: string;
}

export interface LoadDeviceOptions {
  readonly root: string;
  readonly sourceDir: string;
  /** Manifest path relative to the project root. */
  readonly manifest: string;
  /** DDL source path relative to the project root. */
  readonly model?: string;
}

/**
 * Reads, validates and compiles one unified device project.
 *
 * The manifest is parsed by the shared device contract, so a package the build accepts is the same
 * package a host loads. The DDL model is compiled but never executed, and it is cross-checked
 * against the manifest: pin sets, property types, nullability and literal defaults must agree.
 */
export async function loadDevicePackage(options: LoadDeviceOptions): Promise<LoadedDevicePackage> {
  const root = resolve(options.root);
  const sourceRoot = resolve(root, options.sourceDir);
  const manifestFile = resolve(root, options.manifest);
  const text = await readText(manifestFile, 'device manifest');
  let manifest: UnifiedDeviceManifest;
  try {
    manifest = parseUnifiedManifest(text);
  } catch (error) {
    throw new Error(`${manifestFile}: ${messageOf(error)}`, { cause: error });
  }
  // The text already passed the strict decoder inside parseUnifiedManifest (duplicate keys are
  // rejected there), so this second decode only captures the authored value for package emission.
  const authored: unknown = JSON.parse(text);

  let model: DeviceIR | undefined;
  let modelFile: string | undefined;
  if (options.model !== undefined) {
    modelFile = resolve(root, options.model);
    if (!(await isFile(modelFile)))
      throw new Error(`Cannot find the DDL model source ${modelFile}`);
    const source = await readFile(modelFile, 'utf8');
    try {
      model = await compileDDL(source, { uri: pathToFileURL(modelFile).href });
    } catch (error) {
      throw new Error(`${modelFile}: ${messageOf(error)}`, { cause: error });
    }
    assertModelAgreement(manifest, model, manifestFile);
  }

  const geometry = await loadGeometry(manifest, sourceRoot);
  return {
    manifestFile,
    authored,
    manifest,
    ...(model === undefined ? {} : { model }),
    ...(modelFile === undefined ? {} : { modelFile }),
    ...(geometry.geometry === undefined ? {} : { geometry: geometry.geometry }),
    ...(geometry.file === undefined ? {} : { geometryFile: geometry.file }),
  };
}

async function loadGeometry(
  manifest: UnifiedDeviceManifest,
  sourceRoot: string,
): Promise<{ readonly geometry?: Geometry2D; readonly file?: string }> {
  const view2d = manifest.view2d;
  if (view2d === undefined) return {};
  const pins = Object.keys(manifest.pins ?? {});
  if (typeof view2d.geometry !== 'string')
    return { geometry: parseGeometry(view2d.geometry, pins, 'view2d.geometry') };
  const path = packagePath(view2d.geometry, 'view2d.geometry');
  const source = resolve(sourceRoot, ...path.split('/'));
  if (!isContained(sourceRoot, source))
    throw new Error(`${path}: the geometry source escapes ${sourceRoot}`);
  const text = await readText(source, `geometry '${path}'`);
  return { geometry: parseGeometry(text, pins, path), file: path };
}

function parseGeometry(value: unknown, pins: readonly string[], label: string): Geometry2D {
  try {
    return parseGeometry2D(value, pins);
  } catch (error) {
    throw new Error(`${label}: ${messageOf(error)}`, { cause: error });
  }
}

/**
 * Fails the build when the compiled model and the manifest disagree.
 *
 * The rules are the runtime's pure checker (RFC 0020 / RFC 0021), so a package the build accepts is
 * the same package a runtime accepts. Every problem is reported with the manifest path and the
 * manifest field it belongs to.
 */
function assertModelAgreement(
  manifest: UnifiedDeviceManifest,
  model: DeviceIR,
  manifestFile: string,
): void {
  const problems = checkModelAgreement(manifest, model);
  if (problems.length === 0) return;
  const details = problems.map((entry) => {
    const field = manifestField(entry.pointer);
    return field === '' ? `- ${entry.message}` : `- ${field}: ${entry.message}`;
  });
  throw new Error(
    `${manifestFile}: the manifest and the compiled model disagree:\n${details.join('\n')}`,
  );
}

/** `/properties/debounce/default` → `properties.debounce.default`. */
function manifestField(pointer: string): string {
  return pointer
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.');
}

async function readText(file: string, label: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`Cannot read the ${label} ${file}: ${messageOf(error)}`, { cause: error });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
