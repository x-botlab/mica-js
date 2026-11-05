import type { Plugin, ResolvedConfig } from 'vite';
import { buildContent } from './content.js';
import { prepare } from './prepare.js';

export interface MicaSdkOptions {
  /** Source directory relative to the Vite root; defaults to src. */
  readonly sourceDir?: string;
}

const entryId = 'virtual:mica-sdk-empty';

/** Builds independent two-file devices/widgets for the SDK CLI. */
export function micaSdk(options: MicaSdkOptions = {}): Plugin {
  let config: ResolvedConfig;
  const compile = async () => {
    await prepare({ root: config.root, ...options });
    return buildContent({
      root: config.root,
      ...options,
      aliases: config.resolve.alias,
      minify: config.build.minify !== false,
    });
  };

  return {
    name: 'mica:sdk',
    config(_config, environment) {
      if (environment.command !== 'build') return;
      return {
        publicDir: false,
        build: {
          sourcemap: false,
          copyPublicDir: false,
          lib: { entry: entryId, formats: ['es'], fileName: () => '__mica_sdk__.js' },
          rolldownOptions: { input: entryId },
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === entryId) return '\0' + entryId;
    },
    load(id) {
      if (id === '\0' + entryId) return 'export {};';
    },
    async buildStart() {
      if (config.command !== 'build') return;
      for (const file of await compile()) this.emitFile({ type: 'asset', ...file });
    },
    generateBundle(_options, bundle) {
      if (config.command !== 'build') return;
      for (const [name, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.facadeModuleId === '\0' + entryId)
          delete bundle[name];
        else if (
          output.type === 'chunk' ||
          !/^(devices\/[A-Za-z0-9-]+\/device|widgets\/[A-Za-z0-9-]+\/widget)\.(js|json)$/.test(name)
        )
          this.error(`Unexpected content artifact: ${name}`);
      }
    },
  };
}
