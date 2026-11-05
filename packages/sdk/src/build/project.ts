import { isAbsolute, relative, resolve } from 'node:path';
import { build, type InlineConfig } from 'vite';
import type { loadProjectConfig } from './config.js';
import { micaSdk } from './vite.js';

type Project = Awaited<ReturnType<typeof loadProjectConfig>>;

function viteConfig(project: Project): InlineConfig {
  const { root, config } = project;
  const source = resolve(root, config.sourceDir ?? 'src');
  const output = resolve(root, config.outDir ?? 'dist');
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === '' ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
    );
  };
  if (contains(output, root) || contains(output, source) || contains(source, output))
    throw new Error('outDir must be separate from the project root and sourceDir.');
  return {
    configFile: false,
    root,
    base: config.base ?? '/',
    publicDir: false,
    appType: 'custom',
    resolve: {
      alias: Object.fromEntries(
        Object.entries(config.alias ?? {}).map(([key, path]) => [key, resolve(root, path)]),
      ),
    },
    plugins: [micaSdk({ sourceDir: config.sourceDir ?? 'src' })],
    build: { outDir: config.outDir ?? 'dist' },
  };
}

export async function buildProject(project: Project): Promise<void> {
  await build(viteConfig(project));
}
