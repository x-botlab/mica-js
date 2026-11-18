#!/usr/bin/env node
/**
 * Prepares and serves the CT107D v2 workbench host.
 *
 * `prepare` copies exactly the bytes the headless runtime verifies: the unified device package
 * beside its `release.json`, the tracked canonical document, the editor's HTML-view environment and
 * a catalog of locked package files. It never writes the tracked document; the browser draft lives
 * in localStorage and "恢复演示" reloads the tracked copy.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  preview   serve the built host at http://127.0.0.1:5181/`;

async function prepare() {
  const release = await readRelease(DEVICE_DIST);
  const documentText = await readFile(DOCUMENT_PATH, 'utf8');
  const document = await verifyDocument(documentText, release);

  await rm(PUBLIC, { recursive: true, force: true });
  await mkdir(PUBLIC, { recursive: true });
  await cp(DEVICE_DIST, join(PUBLIC, 'device'), { recursive: true });
  try {
    await cp(VIEW_ENVIRONMENT, join(PUBLIC, 'environment'), { recursive: true });
  } catch (cause) {
    throw new Error(
      `Cannot copy the HTML-view environment from ${VIEW_ENVIRONMENT}. ` +
        `Build @mica-js/editor first.\n${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  await writeFile(join(PUBLIC, 'ct107d.sch'), documentText);
  await writeFile(
    join(PUBLIC, 'catalog.json'),
    `${JSON.stringify(
      [{ lock: release.lock, files: release.files, directory: 'device' }],
      null,
      2,
    )}\n`,
  );
  console.log(
    `workbench: prepared ${release.lock.id}@${release.lock.version} ` +
      `(${document.instances.length} instance, ${Object.keys(release.files).length} files)`,
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
  await prepare();
  if (command === 'prepare') return 0;
  if (command === 'build') {
    await viteBuild({ root: APP, configFile: join(APP, 'vite.config.ts') });
    console.log('workbench: built workbench/dist');
    return 0;
  }
  if (command === 'preview') {
    const server = await vitePreview({
      root: APP,
      configFile: join(APP, 'vite.config.ts'),
      preview: { host: '127.0.0.1', port: 5181, strictPort: true },
    });
    server.printUrls();
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
