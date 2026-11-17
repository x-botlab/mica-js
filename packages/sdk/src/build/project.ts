import { isAbsolute, relative, resolve } from 'node:path';
import { build, type InlineConfig } from 'vite';
import type { loadProjectConfig } from './config.js';
import { buildDeviceProject } from './unified-build.js';
import { micaSdk } from './vite.js';

type Project = Awaited<ReturnType<typeof loadProjectConfig>>;

interface Directories {
  readonly source: string;
  readonly output: string;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
  );
}

/** Resolves the source and output directories and rejects layouts that could delete sources. */
function resolveDirectories(project: Project): Directories {
  const { root, config } = project;
  const source = resolve(root, config.sourceDir ?? 'src');
  const output = resolve(root, config.outDir ?? 'dist');
  if (contains(output, root) || contains(output, source) || contains(source, output))
    throw new Error('outDir must be separate from the project root and sourceDir.');
  return { source, output };
}

function viteConfig(project: Project, directories: Directories): InlineConfig {
  const { root, config } = project;
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
    build: { outDir: directories.output },
  };
}

/**
 * Builds the project.
 *
 * A project that configures `device` builds one unified device package; every other project builds
 * standalone Device and Widget artifacts.
 */
export async function buildProject(project: Project): Promise<void> {
  const directories = resolveDirectories(project);
  if (project.config.device !== undefined) {
    await buildDeviceProject(project, directories.output);
    return;
  }
  await build(viteConfig(project, directories));
}
