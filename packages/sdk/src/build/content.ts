import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { compileDDL } from '@mica-js/ddl';
import { build, normalizePath, type AliasOptions } from 'vite';
import { parseAst } from 'rolldown/parseAst';
import { validateMetadata } from '../metadata/index.js';

function assertSelfContained(code: string, label: string): void {
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      record.type === 'ImportDeclaration' ||
      record.type === 'ImportExpression' ||
      ((record.type === 'ExportNamedDeclaration' || record.type === 'ExportAllDeclaration') &&
        record.source) ||
      (record.type === 'MetaProperty' && (record.meta as { name?: string }).name === 'import')
    )
      throw new Error(`${label}: implementation contains a runtime module or asset reference`);
    for (const child of Object.values(record)) visit(child);
  };
  visit(parseAst(code));
}

export interface ContentBuildOptions {
  readonly root: string;
  readonly sourceDir?: string;
  readonly aliases?: AliasOptions;
  readonly minify?: boolean;
}

export interface ContentFile {
  readonly fileName: string;
  readonly source: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// JSON alone loses the IR's non-finite numbers and negative zero.
export function modelExpression(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (value instanceof Uint8Array) return `new Uint8Array(${modelExpression(Array.from(value))})`;
  if (Array.isArray(value)) return `[${value.map(modelExpression).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .map(
        ([key, item]) =>
          `${key === '__proto__' ? '["__proto__"]' : JSON.stringify(key)}:${modelExpression(item)}`,
      )
      .join(',')}}`;
  throw new TypeError(`Cannot serialize model value: ${typeof value}`);
}

/** Builds each registration separately so no shared chunk or runtime import escapes. */
export async function buildContent(options: ContentBuildOptions): Promise<readonly ContentFile[]> {
  const files: ContentFile[] = [];
  for (const kind of ['device', 'widget'] as const) {
    const category = `${kind}s`;
    const directory = resolve(options.root, options.sourceDir ?? 'src', category);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const base = resolve(directory, id);
      const jsonPath = resolve(base, `${kind}.json`);
      const metadata: unknown = JSON.parse(await readFile(jsonPath, 'utf8'));
      validateMetadata(metadata, kind, id);
      let source: string;
      const entryId = 'virtual:mica-content-entry';
      if (kind === 'device') {
        const ddlPath = resolve(base, 'model.ddl');
        const model = await compileDDL(await readFile(ddlPath, 'utf8'), {
          uri: `mica:devices/${id}/model.ddl`,
        });
        const adapter = resolve(base, 'index.ts');
        source = `export const model = ${modelExpression(model)};\n`;
        source += (await exists(adapter))
          ? `export { default as create } from ${JSON.stringify(normalizePath(adapter))};\n`
          : 'export function create() { return { sync() {}, dispose() {} }; }\n';
      } else {
        source = `export { default } from ${JSON.stringify(normalizePath(resolve(base, 'index.ts')))};\n`;
      }
      const bundled = await build({
        configFile: false,
        root: options.root,
        publicDir: false,
        logLevel: 'silent',
        resolve: {
          ...(options.aliases === undefined ? {} : { alias: options.aliases }),
          conditions: ['source', 'module', 'browser', 'production'],
        },
        plugins: [
          {
            name: 'mica:content-entry',
            enforce: 'pre',
            resolveId(id) {
              if (isBuiltin(id))
                throw new Error(`Node built-ins are unavailable in content modules: ${id}`);
              if (id === entryId) return '\0' + entryId;
            },
            load(id) {
              if (id === '\0' + entryId) return source;
            },
          },
        ],
        build: {
          write: false,
          target: 'es2022',
          sourcemap: false,
          minify: options.minify ?? false,
          lib: { entry: entryId, formats: ['es'], fileName: () => `${kind}.js`, cssFileName: kind },
          rolldownOptions: {
            input: entryId,
            output: { codeSplitting: false },
            onwarn(warning, warn) {
              if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
              warn(warning);
            },
          },
        },
      });
      if ('close' in bundled)
        throw new Error('Watch builds are not supported inside a content build');
      const outputs = (Array.isArray(bundled) ? bundled : [bundled]).flatMap(
        (result) => result.output,
      );
      const chunk = outputs[0];
      if (
        outputs.length !== 1 ||
        chunk?.type !== 'chunk' ||
        chunk.imports.length ||
        chunk.dynamicImports.some((name) => name !== chunk.fileName)
      )
        throw new Error(
          `${category}/${id}: implementation must produce exactly one self-contained JavaScript module (${outputs.map((item) => item.fileName).join(', ')}; imports: ${chunk?.type === 'chunk' ? [...chunk.imports, ...chunk.dynamicImports].join(', ') : 'n/a'})`,
        );
      assertSelfContained(chunk.code, `${category}/${id}`);
      const expectedExports = kind === 'device' ? ['create', 'model'] : ['default'];
      if (expectedExports.some((name) => !chunk.exports.includes(name)))
        throw new Error(`${category}/${id}: missing implementation export`);
      files.push(
        {
          fileName: `${category}/${id}/${kind}.json`,
          source: `${JSON.stringify(metadata, null, 2)}\n`,
        },
        { fileName: `${category}/${id}/${kind}.js`, source: chunk.code },
      );
    }
  }
  return files;
}
