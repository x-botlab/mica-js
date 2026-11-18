#!/usr/bin/env node
/**
 * Prepares and serves the CT107D v2 workbench host.
 *
 * `prepare` copies exactly the bytes the headless runtime verifies: the unified device package
 * beside its `release.json`, the tracked canonical document, the editor's HTML-view environment and
 * a catalog of locked package files. It never writes the tracked document; the browser draft lives
 * in localStorage and "恢复演示" reloads the tracked copy.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild, createServer, preview as vitePreview } from 'vite';
import {
  DEVICE_DIST,
  DOCUMENT_PATH,
  PACKAGE_ROOT,
  readRelease,
  verifyDocument,
} from './document.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'workbench');
const PUBLIC = join(APP, 'public');
const VIEW_ENVIRONMENT = resolve(PACKAGE_ROOT, '..', '..', 'packages', 'editor', 'dist', 'view-environment');
const USAGE = `Usage: node scripts/workbench.mjs <prepare|dev|build|preview>

  prepare   copy device/dist, ct107d.sch and the view environment into workbench/public
  dev       prepare, then start Vite at http://127.0.0.1:5180/
  build     prepare, then build the host into workbench/dist
  preview   serve the built host at http://127.0.0.1:5181/ (does not rewrite public)`;

/** Relative POSIX paths of every regular file below `root`. */
async function filesUnder(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Generated output contains a non-regular file: ${path}`);
  }
  return files;
}

/** Writes only changed bytes, through a same-directory temporary and an atomic rename. */
async function writeIfChanged(path, bytes) {
  let current;
  try {
    current = await readFile(path);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }
  if (current !== undefined && current.equals(bytes)) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

/**
 * Mirrors one generated directory without removing the watched public root.
 *
 * Keeping `public/` itself and unchanged files in place means a running Vite dev server never
 * falls back from a momentarily missing `catalog.json`/`.sch` to its HTML entry.
 */
async function syncDirectory(source, target) {
  const desired = new Set();
  let written = 0;
  for (const path of await filesUnder(source)) {
    desired.add(path);
    if (await writeIfChanged(join(target, ...path.split('/')), await readFile(join(source, ...path.split('/'))))) {
      written += 1;
    }
  }
  for (const path of await filesUnder(target).catch((cause) => {
    if (cause?.code === 'ENOENT') return [];
    throw cause;
  })) {
    if (!desired.has(path)) {
      await rm(join(target, ...path.split('/')), { force: true });
      written += 1;
    }
  }
  return written;
}

async function prepare() {
  const release = await readRelease(DEVICE_DIST);
  const documentText = await readFile(DOCUMENT_PATH, 'utf8');
  const document = await verifyDocument(documentText, release);

  await mkdir(PUBLIC, { recursive: true });
  try {
    await stat(join(VIEW_ENVIRONMENT, 'index.html'));
  } catch {
    throw new Error(
      `Cannot copy the HTML-view environment from ${VIEW_ENVIRONMENT}. Build @mica-js/editor first.`,
    );
  }
  const written =
    (await syncDirectory(DEVICE_DIST, join(PUBLIC, 'device'))) +
    (await syncDirectory(VIEW_ENVIRONMENT, join(PUBLIC, 'environment'))) +
    Number(await writeIfChanged(join(PUBLIC, 'ct107d.sch'), Buffer.from(documentText))) +
    Number(
      await writeIfChanged(
        join(PUBLIC, 'catalog.json'),
        Buffer.from(
          `${JSON.stringify(
            [{ lock: release.lock, files: release.files, directory: 'device' }],
            null,
            2,
          )}\n`,
        ),
      ),
    );
  console.log(
    `workbench: prepared ${release.lock.id}@${release.lock.version} ` +
      `(${document.instances.length} instance, ${Object.keys(release.files).length} files, ` +
      `${written} file${written === 1 ? '' : 's'} changed)`,
  );
}

async function main(argv) {
  const command = argv[0] ?? 'dev';
  if (command === '-h' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (!['prepare', 'dev', 'build', 'preview'].includes(command)) {
    throw new Error(`Unknown command ${command}\n\n${USAGE}`);
  }
  if (command === 'preview') {
    try {
      await stat(join(APP, 'dist', 'index.html'));
    } catch {
      throw new Error('workbench/dist is missing; run `node scripts/workbench.mjs build` first.');
    }
    const server = await vitePreview({
      root: APP,
      configFile: join(APP, 'vite.config.ts'),
      preview: { host: '127.0.0.1', port: 5181, strictPort: true },
    });
    server.printUrls();
    return 0;
  }
  await prepare();
  if (command === 'prepare') return 0;
  if (command === 'build') {
    await viteBuild({ root: APP, configFile: join(APP, 'vite.config.ts') });
    console.log('workbench: built workbench/dist');
    return 0;
  }
  const server = await createServer({
    root: APP,
    configFile: join(APP, 'vite.config.ts'),
  });
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (cause) => {
    console.error(`workbench: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  },
);
