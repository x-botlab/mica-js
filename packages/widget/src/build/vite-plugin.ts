import type { Plugin } from 'vite';
import type { SandboxAlias } from '@mica-js/sandbox/vite';
import { bundleSelfContainedScript } from './bundle-script';

const AUDIO_WORKLET_QUERY = '?audio-worklet';
const AUDIO_WORKLET_CODE_QUERY = '?audio-worklet-code';
const AUDIO_WORKLET_PREFIX = '\0mica-widget-audio-worklet:';
const AUDIO_WORKLET_CODE_PREFIX = '\0mica-widget-audio-worklet-code:';

/**
 * File name of the worklet asset a *consumer-authored* `?audio-worklet` import emits. `base: './'`
 * makes Vite reference it relative to the importing module.
 */
export const WIDGET_AUDIO_WORKLET_FILE_NAME = 'widget-audio.worklet.js';

export interface WidgetPluginOptions {
  /**
   * Aliases applied while bundling the audio worklet. The worklet usually imports the RPC core, so
   * the entry must resolve workspace sources the same way the sandbox worker bundle does.
   */
  readonly aliases?: readonly SandboxAlias[];
}

/**
 * Bundles one worklet entry, once per entry and build, into a single minified classic script.
 *
 * `?audio-worklet` turns the result into the URL an `AudioContext.addModule()` call loads, and
 * `?audio-worklet-code` hands the script text to a package that inlines it into its own entry - the
 * two queries share the bundle, so a package never ships the same processor twice.
 */
function audioWorkletPlugin(explicitAliases: readonly SandboxAlias[]): Plugin {
  const bundles = new Map<string, Promise<string>>();
  let aliases: readonly SandboxAlias[] = explicitAliases;
  let command: 'serve' | 'build' = 'serve';
  let assetReference: string | undefined;

  return {
    name: 'mica-widget:audio-worklet',
    enforce: 'pre',
    configResolved(config) {
      command = config.command;
      const resolved = (config.resolve.alias ?? []).flatMap((alias) =>
        typeof alias.find === 'string'
          ? [{ find: alias.find, replacement: alias.replacement }]
          : [],
      );
      aliases = [...resolved, ...explicitAliases];
    },
    async resolveId(id, importer) {
      const query = id.endsWith(AUDIO_WORKLET_CODE_QUERY)
        ? AUDIO_WORKLET_CODE_QUERY
        : id.endsWith(AUDIO_WORKLET_QUERY)
          ? AUDIO_WORKLET_QUERY
          : undefined;
      if (query === undefined) return null;
      const resolved = await this.resolve(id.slice(0, -query.length), importer, {
        skipSelf: true,
      });
      if (!resolved) return null;
      return query === AUDIO_WORKLET_CODE_QUERY
        ? `${AUDIO_WORKLET_CODE_PREFIX}${resolved.id}`
        : `${AUDIO_WORKLET_PREFIX}${resolved.id}`;
    },
    async load(id) {
      const isCode = id.startsWith(AUDIO_WORKLET_CODE_PREFIX);
      if (!isCode && !id.startsWith(AUDIO_WORKLET_PREFIX)) return null;
      const entry = id.slice((isCode ? AUDIO_WORKLET_CODE_PREFIX : AUDIO_WORKLET_PREFIX).length);
      let bundled = bundles.get(entry);
      if (!bundled) {
        bundled = bundleWorklet(entry, aliases, command === 'build');
        bundles.set(entry, bundled);
      }
      const source = await bundled;
      if (isCode) return `export default ${JSON.stringify(source)};`;
      if (command === 'build') {
        assetReference ??= this.emitFile({
          type: 'asset',
          name: WIDGET_AUDIO_WORKLET_FILE_NAME,
          source,
        });
        return `export default import.meta.ROLLUP_FILE_URL_${assetReference};`;
      }
      return `export default URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: 'text/javascript' }));`;
    },
  };
}

/**
 * Bundles the worklet as one classic script. Minified IIFE output keeps the script small and makes
 * the self-containment assertion meaningful: a worklet is loaded through `addModule()`, which must
 * not need to resolve anything else.
 */
async function bundleWorklet(
  entry: string,
  aliases: readonly SandboxAlias[],
  minify: boolean,
): Promise<string> {
  const script = await bundleSelfContainedScript(entry, {
    aliases,
    minify,
    label: WIDGET_AUDIO_WORKLET_FILE_NAME,
  });
  return script;
}

/**
 * Consumer plugin for the two worklet queries.
 *
 * `import url from './worklet.ts?audio-worklet'` bundles the ordinary module into one
 * self-contained `AudioWorkletProcessor` script and resolves the import to its URL: development
 * turns the bundle into a Blob URL, a build emits it as an asset and returns the URL the bundler
 * generated for that asset, so the library never pins a root-absolute path.
 *
 * `import code from './worklet.ts?audio-worklet-code'` resolves to the script text instead. A
 * package uses it to inline its own processor, so consumers need neither the query nor a published
 * `*.worklet.js` asset. `@mica-js/widget` ships its processor this way; the queries stay public for
 * projects that author their own worklet module.
 */
export function micaWidgetPlugins(options: WidgetPluginOptions = {}): Plugin[] {
  return [audioWorkletPlugin(options.aliases ?? [])];
}
