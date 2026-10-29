import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WIDGET_AUDIO_WORKLET_FILE_NAME, micaWidgetPlugins } from './vite-plugin';

const importer = fileURLToPath(new URL('../index.ts', import.meta.url));
const workletEntry = fileURLToPath(new URL('../guest/audio/entry.ts', import.meta.url));
const workletId = `\0mica-widget-audio-worklet:${workletEntry}`;

interface ResolveCall {
  readonly source: string;
  readonly skipSelf: boolean | undefined;
}

function resolverFor(id: string, calls: ResolveCall[]) {
  return async (source: string, _importer: string, options?: { skipSelf?: boolean }) => {
    calls.push({ source, skipSelf: options?.skipSelf });
    return { id };
  };
}

interface EmittedAsset {
  readonly type: string;
  readonly name: string;
  readonly source: string;
}

function pluginHandle(command: 'serve' | 'build') {
  const plugin = micaWidgetPlugins()[0]!;
  const configResolved = plugin.configResolved as unknown as (config: {
    command: 'serve' | 'build';
    resolve: { alias: unknown[] };
  }) => void;
  configResolved({ command, resolve: { alias: [] } });

  const emitted: EmittedAsset[] = [];
  const context = {
    emitFile: (asset: EmittedAsset) => {
      emitted.push(asset);
      return `ref-${emitted.length}`;
    },
  };
  const resolveId = plugin.resolveId as unknown as (
    this: { resolve: ReturnType<typeof resolverFor> },
    id: string,
    importer: string,
  ) => Promise<string | null>;
  const load = plugin.load as unknown as (
    this: typeof context,
    id: string,
  ) => Promise<string | null>;

  return { plugin, resolveId, load, context, emitted };
}

describe('micaWidgetPlugins', () => {
  it('only provides the consumer audio worklet transform', () => {
    const plugins = micaWidgetPlugins();

    expect(plugins.map(({ name }) => name)).toEqual(['mica-widget:audio-worklet']);
    expect(plugins[0]?.enforce).toBe('pre');
  });

  it('strips the query before resolving the worklet entry', async () => {
    const { resolveId } = pluginHandle('build');
    const calls: ResolveCall[] = [];

    const id = await resolveId.call(
      { resolve: resolverFor(workletEntry, calls) },
      './guest/audio/entry.ts?audio-worklet',
      importer,
    );

    expect(id).toBe(workletId);
    expect(calls).toEqual([{ source: './guest/audio/entry.ts', skipSelf: true }]);
  });

  it('leaves specifiers without the query alone', async () => {
    const { resolveId } = pluginHandle('build');
    const calls: ResolveCall[] = [];

    const id = await resolveId.call(
      { resolve: resolverFor(workletEntry, calls) },
      workletEntry,
      importer,
    );

    expect(id).toBeNull();
    expect(calls).toEqual([]);
  });

  it('ignores modules that are not the worklet virtual module', async () => {
    const { load, context } = pluginHandle('build');

    expect(await load.call(context, importer)).toBeNull();
  });

  it('serves the worklet as a blob URL that registers the processor', async () => {
    const { load, context, emitted } = pluginHandle('serve');

    const code = (await load.call(context, workletId)) ?? '';

    expect(code).toMatch(
      /^export default URL\.createObjectURL\(new Blob\(\[.*\], \{ type: 'text\/javascript' \}\)\);$/s,
    );
    expect(code).toContain('registerProcessor');
    expect(emitted).toEqual([]);
  });

  it('emits one self-contained asset and returns its file URL in a build', async () => {
    const { load, context, emitted } = pluginHandle('build');

    const first = await load.call(context, workletId);
    const second = await load.call(context, workletId);

    expect(first).toBe('export default import.meta.ROLLUP_FILE_URL_ref-1;');
    expect(second).toBe(first);
    expect(emitted).toHaveLength(1);
    const asset = emitted[0]!;
    expect(asset.type).toBe('asset');
    expect(asset.name).toBe(WIDGET_AUDIO_WORKLET_FILE_NAME);
    expect(asset.source).toContain('registerProcessor');
    expect(asset.source).not.toMatch(/^\s*import\s/m);
  });
});
