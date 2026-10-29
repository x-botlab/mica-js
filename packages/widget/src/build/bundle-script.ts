import { build } from 'rolldown';
import type { SandboxAlias } from '@mica-js/sandbox/vite';

/** One entry bundled into a single classic script. */
export interface SelfContainedScriptOptions {
  /** Workspace aliases applied while bundling, so the artifact never resolves a stale `dist`. */
  readonly aliases: readonly SandboxAlias[];
  /** Minify the bundle. Published standalone scripts are always minified. */
  readonly minify: boolean;
  /** Artifact name reported when the bundle still contains module syntax. */
  readonly label: string;
}

/**
 * Bundles one entry into a single classic script: IIFE output, no code splitting, every dependency
 * inlined. A Worker and an `AudioWorkletProcessor` both run such a file without a module loader, so
 * the result is asserted to be self-contained before it is published.
 */
export async function bundleSelfContainedScript(
  entry: string,
  options: SelfContainedScriptOptions,
): Promise<string> {
  const alias: Record<string, string> = {};
  for (const item of options.aliases) alias[item.find] = item.replacement;
  const result = await build({
    input: entry,
    external: [],
    ...(options.aliases.length === 0 ? {} : { resolve: { alias } }),
    output: {
      format: 'iife',
      codeSplitting: false,
      name: 'MicaWidgetStandalone',
      minify: options.minify,
    },
    write: false,
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((output) => output.output).find((item) => item.type === 'chunk');
  if (chunk === undefined || chunk.type !== 'chunk') {
    throw new Error(`@mica-js/widget: ${options.label} produced no bundle for "${entry}"`);
  }
  return chunk.code;
}
