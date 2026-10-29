import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { micaSandboxPlugins } from '../vite.plugins';

const SANDBOX_QUERY = '?sandbox-worker';

const importer = fileURLToPath(new URL('./index.ts', import.meta.url));
const tsEntry = fileURLToPath(new URL('./host/frame-document.ts', import.meta.url));
const jsEntry = fileURLToPath(new URL('../test/fixtures/guest.js', import.meta.url));

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

function pluginHandle() {
  const plugin = micaSandboxPlugins()[0]!;
  const resolveId = plugin.resolveId as unknown as (
    this: { resolve: ReturnType<typeof resolverFor> },
    id: string,
    importer: string,
  ) => Promise<string | null>;
  const load = plugin.load as (id: string) => Promise<string | null>;
  return { resolveId, load };
}

const forms = [
  {
    name: 'a TypeScript entry',
    specifier: './host/frame-document.ts?sandbox-worker',
    resolvedId: tsEntry,
    entry: `\0mica-sandbox-worker:${tsEntry}`,
    className: 'FrameDocumentSandbox',
    marker: 'buildFrameDocument',
  },
  {
    name: 'a JavaScript worker entry',
    specifier: '../test/fixtures/guest.js?sandbox-worker',
    resolvedId: jsEntry,
    entry: `\0mica-sandbox-worker:${jsEntry}`,
    className: 'GuestSandbox',
    marker: 'answer: 42',
  },
  {
    name: 'an extensionless entry',
    specifier: './host/frame-document?sandbox-worker',
    resolvedId: tsEntry,
    entry: `\0mica-sandbox-worker:${tsEntry}`,
    className: 'FrameDocumentSandbox',
    marker: 'buildFrameDocument',
  },
];

describe('micaSandboxPlugins', () => {
  it('only provides the consumer sandbox worker transform', () => {
    const plugins = micaSandboxPlugins();

    expect(plugins.map(({ name }) => name)).toEqual(['mica-sandbox:worker']);
  });

  describe.each(forms)('$name', ({ specifier, resolvedId, entry, className, marker }) => {
    it('strips the query before resolving, whatever the module extension', async () => {
      const calls: ResolveCall[] = [];
      const { resolveId } = pluginHandle();

      const virtualId = await resolveId.call(
        { resolve: resolverFor(resolvedId, calls) },
        specifier,
        importer,
      );

      expect(virtualId).toBe(entry);
      expect(calls).toEqual([
        { source: specifier.slice(0, -SANDBOX_QUERY.length), skipSelf: true },
      ]);
    });

    it('generates a SandboxWorker subclass with a self-contained entry bundle', async () => {
      const calls: ResolveCall[] = [];
      const { resolveId, load } = pluginHandle();
      const virtualId = await resolveId.call(
        { resolve: resolverFor(resolvedId, calls) },
        specifier,
        importer,
      );

      const generated = await load(virtualId!);

      expect(generated).toContain(`export default class ${className} extends SandboxWorker`);
      expect(generated).toContain("import { SandboxWorker } from '@mica-js/sandbox'");
      // The class body is nothing but the constructor: id, name, ready, state, onError and
      // terminate all come from SandboxWorker, so the generated class stays structurally
      // compatible by inheritance.
      expect(generated).toContain(
        `export default class ${className} extends SandboxWorker {\n` +
          '  constructor(options = {}) {\n' +
          '    super(',
      );
      expect(generated).toMatch(/, options\);\n {2}\}\n\}\n$/);
      expect(generated).not.toContain('#worker');

      const match = generated!.match(/super\(("(?:\\.|[^"\\])*"), options\)/);
      expect(match).not.toBeNull();
      const bundledEntry = JSON.parse(match![1]!) as string;
      expect(bundledEntry).toContain(marker);
      // The Worker runs the bundle as a classic script, so it must not contain module syntax.
      expect(bundledEntry).not.toMatch(/\bfrom\s*["'][^"']+["']/);
      expect(bundledEntry).not.toMatch(/\bimport\s*\(/);
      expect(bundledEntry).not.toMatch(/^\s*(?:import|export)\s/m);
    });
  });

  it('ignores imports without the sandbox worker query', async () => {
    const { resolveId } = pluginHandle();
    const resolve = resolverFor(tsEntry, []);

    expect(await resolveId.call({ resolve }, './host/frame-document.ts', importer)).toBeNull();
    expect(await resolveId.call({ resolve }, './host/frame-document.sandbox', importer)).toBeNull();
    expect(
      await resolveId.call({ resolve }, './host/frame-document.ts?sandbox-worker-extra', importer),
    ).toBeNull();
  });
});
