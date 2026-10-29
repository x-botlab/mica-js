import { build } from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';

const SANDBOX_QUERY = '?sandbox-worker';
const SANDBOX_CODE_QUERY = '?sandbox-worker-code';
const SANDBOX_PREFIX = '\0mica-sandbox-worker:';
const SANDBOX_CODE_PREFIX = '\0mica-sandbox-worker-code:';

/** One alias applied while resolving a guest entry bundle. */
export interface SandboxAlias {
  readonly find: string;
  readonly replacement: string;
}

export interface SandboxPluginOptions {
  /**
   * Extra aliases for guest entry bundling, merged after Vite's own `resolve.alias`. Use them when
   * the package ships a sandbox entry whose imports must resolve to workspace sources.
   */
  readonly aliases?: readonly SandboxAlias[];
}

function sandboxWorkerPlugin(explicitAliases: readonly SandboxAlias[]): Plugin {
  const bundles = new Map<string, Promise<string>>();
  let aliases: readonly SandboxAlias[] = explicitAliases;
  let config: ResolvedConfig | undefined;

  return {
    name: 'mica-sandbox:worker',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      const declared = (resolved.resolve.alias ?? []).flatMap((alias) =>
        typeof alias.find === 'string'
          ? [{ find: alias.find, replacement: alias.replacement }]
          : [],
      );
      aliases = [...declared, ...explicitAliases];
    },
    async resolveId(id, importer) {
      const query = id.endsWith(SANDBOX_CODE_QUERY)
        ? SANDBOX_CODE_QUERY
        : id.endsWith(SANDBOX_QUERY)
          ? SANDBOX_QUERY
          : undefined;
      if (query === undefined) return null;
      const resolved = await this.resolve(id.slice(0, -query.length), importer, {
        skipSelf: true,
      });
      if (!resolved) return null;
      return query === SANDBOX_CODE_QUERY
        ? `${SANDBOX_CODE_PREFIX}${resolved.id}`
        : `${SANDBOX_PREFIX}${resolved.id}`;
    },
    async load(id) {
      const isCode = id.startsWith(SANDBOX_CODE_PREFIX);
      if (!isCode && !id.startsWith(SANDBOX_PREFIX)) return null;
      const entry = id.slice((isCode ? SANDBOX_CODE_PREFIX : SANDBOX_PREFIX).length);
      let bundled = bundles.get(entry);
      if (!bundled) {
        bundled = bundleSelfContainedScript(entry, aliases, {
          minify: config?.command === 'build',
        }).then((code) => {
          config?.logger.info(`mica-sandbox: bundled guest entry ${describeEntry(entry)}`);
          return code;
        });
        bundles.set(entry, bundled);
      }
      const code = await bundled;
      // A package that ships its guest inline imports the code string and builds the worker itself.
      if (isCode) return `export default ${JSON.stringify(code)};`;
      return `import { SandboxWorker } from '@mica-js/sandbox';\n\
export default class ${sandboxClassName(entry)} extends SandboxWorker {\n\
  constructor(options = {}) {\n\
    super(${JSON.stringify(code)}, options);\n\
  }\n\
}\n`;
    },
  };
}

function sandboxClassName(entry: string): string {
  return `${toPascalCase(entryName(entry))}Sandbox`;
}

function describeEntry(entry: string): string {
  return entry.replace(/\\/g, '/').split('/').at(-1) ?? entry;
}

function entryName(entry: string): string {
  return describeEntry(entry).replace(/\.[^.]+$/, '');
}

function toPascalCase(value: string): string {
  const name = value
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
  return /^[A-Za-z_$]/.test(name) ? name : `Sandbox${name}`;
}

interface BundleOptions {
  readonly minify: boolean;
}

/**
 * Bundles one sandbox entry into a single classic script: IIFE output, no code splitting, every
 * dependency inlined. Production builds also minify the result and assert that no module syntax
 * survived, because the Worker executes the script without a module loader.
 */
async function bundleSelfContainedScript(
  entry: string,
  aliases: readonly SandboxAlias[],
  options: BundleOptions,
): Promise<string> {
  const alias: Record<string, string> = {};
  for (const item of aliases) alias[item.find] = item.replacement;
  const result = await build({
    input: entry,
    external: [],
    resolve: { conditionNames: ['source', 'import', 'browser', 'default'], alias },
    output: {
      format: 'iife',
      codeSplitting: false,
      name: 'MicaSandboxGuest',
      minify: options.minify,
    },
    write: false,
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === 'chunk');
  if (chunks.length !== 1) {
    throw new Error(`mica-sandbox: expected one self-contained entry bundle for "${entry}"`);
  }
  return chunks[0]!.code;
}

/**
 * Consumer plugin: `import Guest from './guest?sandbox-worker'` bundles the ordinary module and
 * replaces the import with a `SandboxWorker` subclass whose constructor supplies that bundle. The
 * module becomes the worker script itself, so it must be self-contained and register its own
 * `self.addEventListener('message')` handler. The query works on any module specifier — `.ts`,
 * `.js` or extensionless — because only the query is inspected and Vite resolves the remaining
 * specifier. Production builds minify the bundle, so the worker script stays small.
 */
export function micaSandboxPlugins(options: SandboxPluginOptions = {}): Plugin[] {
  return [sandboxWorkerPlugin(options.aliases ?? [])];
}
