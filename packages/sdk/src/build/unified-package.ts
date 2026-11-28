import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { homedir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import { build, normalizePath, type AliasOptions } from 'vite';
import {
  assertSelfContained,
  MINIFY_OUTPUT,
  modelExpression,
  stripModelSource,
} from './content.js';
import type { UnifiedDeviceManifest } from '@mica-js/document/fused';
import type { LoadedDevicePackage } from './unified-manifest.js';
import { readProgramDirectory } from '../fused/node.js';
import {
  findSource,
  isContained,
  isFile,
  packagePath,
  sourceCandidates,
  sourcePaths,
} from './unified-paths.js';

/** One emitted package file; `path` is the package-root-relative POSIX path. */
export interface DevicePackageFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface CollectDeviceOptions {
  /** Project root; bundling runs with this directory as the Vite root. */
  readonly root: string;
  /** Source directory whose contents form the package root. */
  readonly sourceDir: string;
  readonly device: LoadedDevicePackage;
  readonly aliases?: AliasOptions;
  /** Minifies every emitted module; defaults to `true`. */
  readonly minify?: boolean;
}

export interface ReleaseFile {
  readonly size: number;
  readonly integrity: string;
}

export interface ReleaseManifest {
  readonly id: string;
  readonly version: string;
  readonly files: Readonly<Record<string, ReleaseFile>>;
}

const HTML_REFERENCE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Builds every package file of a unified device.
 *
 * Each declared JS entry becomes one self-contained ESM module; declared and referenced assets are
 * copied at their package path; HTML is copied together with its relative resources, and a
 * referenced script module is bundled like any other entry. The authored manifest is emitted as
 * the package manifest, so the package never ships different content than the validated manifest.
 */
export async function collectDevicePackage(
  options: CollectDeviceOptions,
): Promise<readonly DevicePackageFile[]> {
  const sourceRoot = resolve(options.root, options.sourceDir);
  const device = options.device;
  const manifest = device.manifest;
  const claims = new Map<string, { origin: string; data: Uint8Array }>();
  const scanned = new Set<string>();

  const claim = (path: string, origin: string, data: Uint8Array): void => {
    packagePath(path, 'package file');
    const existing = claims.get(path);
    if (existing !== undefined) {
      if (existing.origin === origin) return;
      throw new Error(
        `Two sources produce the package file '${path}': ${existing.origin} and ${origin}`,
      );
    }
    claims.set(path, { origin, data });
  };

  const claimSource = async (path: string, field: string): Promise<void> => {
    const source = await findSource(sourceRoot, path, field);
    claim(path, source, new Uint8Array(await readFile(source)));
  };

  const emitModule = async (input: {
    readonly artifact: string;
    readonly label: string;
    readonly requiredNamed: readonly string[];
    readonly defaultExport?: boolean;
    readonly virtual?: string;
  }): Promise<void> => {
    const source =
      input.virtual === undefined
        ? await findSource(sourceRoot, input.artifact, input.label)
        : undefined;
    const bundled = await bundleModule({
      root: options.root,
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      minify: options.minify ?? true,
      label: input.label,
      input: source ?? '',
      ...(input.virtual === undefined ? {} : { virtual: input.virtual }),
    });
    const missing = input.requiredNamed.filter((name) => !bundled.exports.includes(name));
    if (missing.length > 0)
      throw new Error(`${input.label}: the module must export ${missing.join(', ')}`);
    if (input.defaultExport === true && !bundled.exports.includes('default'))
      throw new Error(`${input.label}: the module must have a default export`);
    claim(input.artifact, source ?? `${input.label} (generated)`, Buffer.from(bundled.code));
  };

  const emitReference = async (from: string, raw: string, label: string): Promise<void> => {
    const target = resolveReference(from, raw, label);
    if (target === undefined || scanned.has(target)) return;
    scanned.add(target);
    if (/\.m?js$/i.test(target)) {
      await emitModule({
        artifact: target,
        label: `module '${target}' referenced by ${label}`,
        requiredNamed: [],
      });
      return;
    }
    const source = await findSource(
      sourceRoot,
      target,
      `resource '${target}' referenced by ${label}`,
    );
    const data = new Uint8Array(await readFile(source));
    claim(target, source, data);
    if (/\.css$/i.test(target)) {
      for (const reference of cssReferences(Buffer.from(data).toString('utf8')))
        await emitReference(packageDirectory(target), reference, `stylesheet '${target}'`);
    }
  };

  claim(
    'package.json',
    'device manifest',
    Buffer.from(`${JSON.stringify(device.authored, null, 2)}\n`),
  );

  const model = manifest.model;
  if (model !== undefined) {
    if (device.model === undefined) {
      await emitModule({
        artifact: model.entry,
        label: `model entry '${model.entry}'`,
        requiredNamed: ['model', 'create'],
      });
    } else {
      const adapter = await findOptionalSource(sourceRoot, model.entry);
      const ir = modelExpression(stripModelSource(device.model));
      const declaresMembers =
        Object.keys(model.methods ?? {}).length > 0 || Object.keys(model.events ?? {}).length > 0;
      if (adapter === undefined && declaresMembers)
        throw new Error(
          `model entry '${model.entry}': the manifest declares model methods or events, so the entry needs an implementation module (expected ${sourceCandidates(model.entry).join(' or ')} in ${sourceRoot})`,
        );
      const virtual =
        adapter === undefined
          ? `export const model = ${ir};\nexport function create() {\n  return { methods: {}, sync() {}, dispose() {} };\n}\n`
          : `export const model = ${ir};\nexport { create } from ${JSON.stringify(normalizePath(adapter))};\n`;
      await emitModule({
        artifact: model.entry,
        label: `model entry '${model.entry}'`,
        requiredNamed: ['model', 'create'],
        virtual,
      });
    }
  }

  if (manifest.view2d?.entry !== undefined)
    await emitModule({
      artifact: manifest.view2d.entry,
      label: `view2d entry '${manifest.view2d.entry}'`,
      requiredNamed: [],
      defaultExport: true,
    });
  const view3d = manifest.entries?.view3d;
  if (view3d !== undefined)
    await emitModule({
      artifact: view3d,
      label: `view3d entry '${view3d}'`,
      requiredNamed: [],
    });

  if (device.geometryFile !== undefined) await claimSource(device.geometryFile, 'view2d.geometry');
  if (device.geometry?.bodyImage !== undefined)
    await claimSource(device.geometry.bodyImage, 'view2d.geometry.bodyImage');
  if (manifest.icon !== undefined) await claimSource(manifest.icon, 'icon');

  for (const [name, property] of Object.entries(manifest.properties ?? {})) {
    const reference = property.default;
    if (reference === null || typeof reference !== 'object') continue;
    if (reference.mode !== 'package' || typeof reference.src !== 'string') continue;
    if (property.type === 'program' && property.loader === 'filesystem') {
      const files = await readProgramDirectory(sourceRoot, reference.src);
      if (files.length === 0)
        throw new Error(`Program default directory '${reference.src}' has no files to publish.`);
      for (const file of files) {
        const path = `${reference.src}/${file.path}`;
        claim(path, resolve(sourceRoot, ...path.split('/')), file.data);
      }
      continue;
    }
    await claimSource(reference.src, `properties.${name}.default`);
  }

  for (const path of await listAssets(resolve(sourceRoot, 'assets')))
    await claimSource(`assets/${path}`, 'assets');

  for (const [id, view] of Object.entries(manifest.view ?? {})) {
    await emitHtml(view.entry, `view '${id}'`);
  }

  async function emitHtml(entry: string, label: string): Promise<void> {
    const source = await findSource(sourceRoot, entry, label);
    const data = new Uint8Array(await readFile(source));
    claim(entry, source, data);
    for (const reference of htmlReferences(Buffer.from(data).toString('utf8')))
      await emitReference(packageDirectory(entry), reference, label);
  }

  return [...claims.entries()]
    .map(([path, value]) => ({ path, data: value.data }))
    .sort((left, right) => compare(left.path, right.path));
}

/** Builds the release file list with real byte sizes and SHA-256 digests. */
export function createRelease(
  manifest: UnifiedDeviceManifest,
  files: readonly DevicePackageFile[],
): ReleaseManifest {
  const entries = [...files].sort((left, right) => compare(left.path, right.path));
  const records: Record<string, ReleaseFile> = {};
  for (const file of entries)
    records[file.path] = {
      size: file.data.byteLength,
      integrity: `sha256:${createHash('sha256').update(file.data).digest('hex')}`,
    };
  return {
    id: `${manifest.publisher}:${manifest.name}`,
    version: manifest.version,
    files: records,
  };
}

export function renderRelease(release: ReleaseManifest): string {
  return `${JSON.stringify(release, null, 2)}\n`;
}

/** SHA-256 fingerprint of a rendered release file, identifying one published package build. */
export function releaseIntegrity(release: ReleaseManifest): string {
  return `sha256:${createHash('sha256').update(renderRelease(release)).digest('hex')}`;
}

export interface WriteDeviceOptions {
  /** Output directory that is reset before the package files are written. */
  readonly outDir: string;
  readonly files: readonly DevicePackageFile[];
  readonly release: ReleaseManifest;
  /** Absolute files and directories that the output reset must never touch. */
  readonly protect?: readonly string[];
}

/**
 * Validates an output directory that is going to be deleted and recreated.
 *
 * The directory may not be a filesystem root, the home directory or one of its ancestors, and it
 * may not contain any protected path such as the project root, the source directory or the
 * manifest. Returns the resolved directory.
 *
 * @throws When resetting the directory could remove sources, tooling state or user data.
 */
export function assertSafeOutput(outDir: string, protect: readonly string[] = []): string {
  const target = resolve(outDir);
  if (target === parse(target).root)
    throw new Error(`Refusing to use the filesystem root as outDir: ${target}`);
  const home = resolve(homedir());
  if (isContained(target, home))
    throw new Error(`Refusing to use ${target} as outDir: it contains the home directory`);
  for (const path of protect) {
    const guarded = resolve(path);
    if (guarded === target)
      throw new Error(`Refusing to use ${target} as outDir: it is a protected path`);
    if (isContained(target, guarded))
      throw new Error(`Refusing to use ${target} as outDir: it contains ${guarded}`);
  }
  return target;
}

/**
 * Replaces the output directory with the package files and writes `release.json` beside them.
 *
 * The release file itself is not part of `files`, so it never describes itself. The directory is
 * validated by {@link assertSafeOutput} before anything is removed.
 */
export async function writeDevicePackage(options: WriteDeviceOptions): Promise<void> {
  const outDir = assertSafeOutput(options.outDir, options.protect ?? []);
  const { files, release } = options;
  await rm(outDir, { recursive: true, force: true });
  for (const file of files) {
    const target = resolve(outDir, ...file.path.split('/'));
    if (!isContained(outDir, target) || target === resolve(outDir))
      throw new Error(`Package file '${file.path}' resolves outside ${outDir}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
  await writeFile(resolve(outDir, 'release.json'), renderRelease(release), 'utf8');
}

interface BundleRequest {
  readonly root: string;
  readonly aliases?: AliasOptions;
  readonly minify: boolean;
  readonly label: string;
  /** Absolute path of a real module; empty when {@link BundleRequest.virtual} is used. */
  readonly input: string;
  readonly virtual?: string;
}

const VIRTUAL_ENTRY = 'mica-unified-entry';

/** Bundles one entry into a single self-contained ESM module. */
async function bundleModule(
  request: BundleRequest,
): Promise<{ readonly code: string; readonly exports: readonly string[] }> {
  const entry = request.virtual === undefined ? request.input : VIRTUAL_ENTRY;
  const bundled = await build({
    configFile: false,
    root: request.root,
    publicDir: false,
    logLevel: 'silent',
    resolve: {
      ...(request.aliases === undefined ? {} : { alias: request.aliases }),
      conditions: ['source', 'module', 'browser', 'production'],
    },
    plugins: [
      {
        name: 'mica:unified-entry',
        enforce: 'pre',
        resolveId(id) {
          if (isBuiltin(id))
            throw new Error(
              `${request.label}: Node built-ins are unavailable in a device module: ${id}`,
            );
          if (id === VIRTUAL_ENTRY) return '\0' + VIRTUAL_ENTRY;
        },
        load(id) {
          if (id === '\0' + VIRTUAL_ENTRY) return request.virtual;
        },
      },
    ],
    build: {
      write: false,
      target: 'es2022',
      sourcemap: false,
      minify: request.minify,
      lib: { entry, formats: ['es'], fileName: () => 'module.js' },
      rolldownOptions: {
        input: entry,
        output: {
          codeSplitting: false,
          ...(request.minify ? { minify: MINIFY_OUTPUT } : {}),
        },
        onwarn(warning, warn) {
          if (warning.code === 'UNRESOLVED_IMPORT')
            throw new Error(`${request.label}: ${warning.message}`);
          warn(warning);
        },
      },
    },
  });
  if ('close' in bundled)
    throw new Error(`${request.label}: watch builds are not supported inside a package build`);
  const outputs = (Array.isArray(bundled) ? bundled : [bundled]).flatMap((result) => result.output);
  const chunk = outputs[0];
  if (outputs.length !== 1 || chunk?.type !== 'chunk')
    throw new Error(
      `${request.label}: the entry must produce exactly one JavaScript module (${outputs.map((item) => item.fileName).join(', ') || 'no output'})`,
    );
  if (chunk.imports.length > 0 || chunk.dynamicImports.some((name) => name !== chunk.fileName))
    throw new Error(
      `${request.label}: the module must be self-contained (imports: ${[...chunk.imports, ...chunk.dynamicImports].join(', ')})`,
    );
  assertSelfContained(chunk.code, request.label);
  return { code: chunk.code, exports: chunk.exports };
}

async function findOptionalSource(
  sourceRoot: string,
  artifact: string,
): Promise<string | undefined> {
  for (const candidate of sourcePaths(sourceRoot, artifact))
    if (await isFile(candidate)) return candidate;
  return undefined;
}

/** Resolves an HTML or CSS reference into a package path, or `undefined` for external URLs. */
function resolveReference(from: string, raw: string, label: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.startsWith('#') || value.startsWith('//')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined;
  if (value.startsWith('/'))
    throw new Error(`${label}: '${raw}' must be a relative reference inside the package`);
  const path = value.split(/[?#]/).shift() ?? '';
  const segments = from.length === 0 ? [] : from.split('/');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0)
        throw new Error(`${label}: '${raw}' resolves outside the package root`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error(`${label}: '${raw}' does not name a package file`);
  return packagePath(segments.join('/'), label);
}

function htmlReferences(text: string): readonly string[] {
  return [...text.matchAll(HTML_REFERENCE)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function cssReferences(text: string): readonly string[] {
  const references = [...text.matchAll(CSS_URL)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  for (const match of text.matchAll(CSS_IMPORT)) references.push(match[1] ?? match[2] ?? '');
  return references;
}

function packageDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Lists every regular file below `directory` as a POSIX path relative to it. */
async function listAssets(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(resolve(current, entry.name), path);
      else if (entry.isFile()) found.push(path);
      else throw new Error(`assets/${path}: only regular files are published`);
    }
  };
  await visit(directory, '');
  return found;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
