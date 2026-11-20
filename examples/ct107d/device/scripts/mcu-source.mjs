import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVICES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'devices');
export const MCU_ROOT = join(DEVICES, 'iap15f2k61s2');
export const MCU_DIST = join(DEVICES, 'dist', 'iap15f2k61s2');
export const MCU_ARTIFACT = join(MCU_DIST, 'model.js');
/** Content-identity stamp lives outside the device package root and under ignored dist/. */
export const MCU_STAMP = join(DEVICES, 'dist', 'iap15f2k61s2.source.json');
/** Local source files imported by the MCU package but outside its project root. */
export const MCU_LOCAL_DEPENDENCIES = [join(DEVICES, 'shared', 'serial.ts')];

function files(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.mica') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else result.push(path);
  }
  return result;
}

function hashFiles(root, paths, hash) {
  for (const path of paths.sort()) {
    hash.update(`${relative(root, path).split('\\').join('/')}\0`);
    hash.update(readFileSync(path));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function mcuSourceHash() {
  for (const dependency of MCU_LOCAL_DEPENDENCIES)
    if (!existsSync(dependency)) throw new Error(`Missing MCU local dependency ${dependency}`);
  const sources = [
    join(MCU_ROOT, 'package.json'),
    ...files(MCU_ROOT).filter((path) => !path.endsWith('package.json')),
    ...MCU_LOCAL_DEPENDENCIES,
  ].filter((path) => existsSync(path) && statSync(path).isFile());

  return hashFiles(MCU_ROOT, sources, createHash('sha256'));
}

/** Content identity of the built MCU package, not just its source tree. */
export function mcuArtifactHash() {
  if (!existsSync(MCU_DIST)) return undefined;
  const artifacts = files(MCU_DIST).filter((path) => statSync(path).isFile());

  return artifacts.length === 0 ? undefined : hashFiles(MCU_DIST, artifacts, createHash('sha256'));
}

export function readMcuStamp() {
  try {
    const value = JSON.parse(readFileSync(MCU_STAMP, 'utf8'));
    return typeof value.source === 'string' && typeof value.artifact === 'string'
      ? { source: value.source, artifact: value.artifact }
      : undefined;
  } catch {
    return undefined;
  }
}
