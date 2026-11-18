#!/usr/bin/env node
/**
 * Canonical workbench document of the CT107D example and its dependency lock (`.sch` v2).
 *
 * The document is generated, but it is also a tracked example that a user may edit in the
 * workbench. Consequently:
 * - `--write` creates a fresh document and refuses to replace an existing file without `--force`;
 * - `--refresh-lock` updates only `dependencies` from the built device release and preserves every
 *   other field; this is the normal way to follow a rebuilt device package;
 * - `--check` (default) verifies the tracked document against the built package and never writes.
 *
 * The lock is read from `device/dist/release.json` through `readDirectoryPackage`; this script
 * never reimplements the release identity.
 */
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  deriveFusedTopology,
  parseFusedDocument,
  parseGeometry2D,
  parseStrictJson,
} from '@mica-js/document/fused';
import { openDevicePackage } from '@mica-js/sdk/fused';
import { readDirectoryPackage } from '@mica-js/sdk/fused/node';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(SCRIPT_ROOT, '..');
export const DEVICE_DIST = join(PACKAGE_ROOT, 'device', 'dist');
export const DOCUMENT_PATH = join(PACKAGE_ROOT, 'ct107d.sch');

export const DEVICE_ID = 'example:ct107d-board';
export const INSTANCE_ID = '7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f';
export const VCC_REFERENCE_ID = '8b3a2f10-6c4d-4e9a-b7f2-1d5c9e0a3b48';
export const GND_REFERENCE_ID = 'c4d5e6f7-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
export const PROGRAM_SOURCE = 'assets/seg7-dynamic.hex';
export const PROGRAM_BIN_SOURCE = 'assets/ct107d-demo.bin';

const USAGE = `Usage: node scripts/document.mjs [--check | --write | --refresh-lock | --print] [options]

Modes:
  --check         verify the document against device/dist (default)
  --write         create a fresh canonical document; refuses to replace an existing file
  --refresh-lock  update only dependencies from device/dist, preserving document edits
  --print         print the canonical document to stdout

Options:
  --out <file>    document path (default: examples/ct107d/ct107d.sch)
  --force         allow --write to replace an existing document
  -h, --help      show this help`;

function fail(message) {
  throw new Error(message);
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseJsonText(text, label) {
  try {
    return parseStrictJson(text);
  } catch (cause) {
    throw new Error(
      `${label} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`,
      {
        cause,
      },
    );
  }
}

function parseArgs(argv) {
  const options = { mode: 'check', out: DOCUMENT_PATH, force: false, help: false };
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (
      argument === '--check' ||
      argument === '--write' ||
      argument === '--refresh-lock' ||
      argument === '--print'
    ) {
      const next = argument.slice(2);
      if (mode !== undefined && mode !== next) fail('Choose exactly one document mode');
      mode = next;
      continue;
    }
    if (argument === '--out') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('-')) fail('--out requires a path');
      options.out = resolve(value);
      continue;
    }
    fail(`Unknown argument ${argument}\n\n${USAGE}`);
  }
  if (mode !== undefined) options.mode = mode;
  if (options.mode !== 'write' && options.force) fail('--force is only valid with --write');
  return options;
}

/** Reads the built device release and verifies it through the SDK before reading any resource. */
export async function readRelease(directory = DEVICE_DIST) {
  let raw;
  try {
    raw = await readDirectoryPackage(directory);
  } catch (cause) {
    throw new Error(
      `Cannot read ${directory}: ${cause instanceof Error ? cause.message : cause}\n` +
        'Run `pnpm run build:fused` first.',
      { cause },
    );
  }
  const verified = await openDevicePackage({ open: async () => raw }, raw.lock);
  const manifest = verified.manifest;
  if (manifest.properties?.firmware === undefined) {
    fail('The device manifest does not declare the firmware property');
  }
  const view2d = manifest.view2d;
  if (view2d === undefined) fail('The device manifest does not declare view2d geometry');
  let geometryValue;
  if (typeof view2d.geometry === 'string') {
    const path = view2d.geometry;
    if (!Object.hasOwn(verified.files, path)) fail(`The device package does not declare ${path}`);
    geometryValue = parseJsonText(decodeText(await verified.read(path)), path);
  } else {
    geometryValue = view2d.geometry;
  }
  const geometry = parseGeometry2D(geometryValue, Object.keys(manifest.pins ?? {}));
  return { lock: verified.lock, manifest, geometry, files: verified.files, read: verified.read };
}

function checkDeviceContract(release) {
  const pins = Object.keys(release.manifest.pins ?? {}).sort();
  if (pins.length !== 2 || pins[0] !== 'GND' || pins[1] !== 'VCC') {
    fail(
      `The fused device must declare exactly VCC and GND pins, got ${pins.join(', ') || 'none'}`,
    );
  }
  const geometryPins = Object.keys(release.geometry.pins).sort();
  if (geometryPins.join('\0') !== pins.join('\0')) {
    fail(
      `Geometry pins (${geometryPins.join(', ')}) differ from manifest pins (${pins.join(', ')})`,
    );
  }
  if (release.geometry.bodyImage !== undefined) {
    if (!Object.hasOwn(release.files, release.geometry.bodyImage)) {
      fail(`The device package does not declare bodyImage ${release.geometry.bodyImage}`);
    }
  }
  const descriptor = release.manifest.properties?.firmware;
  if (!record(descriptor) || descriptor.type !== 'program') {
    fail('properties.firmware must be a program property');
  }
  if (descriptor.loader !== 'memory') fail('properties.firmware.loader must be "memory"');
  const formats = Array.isArray(descriptor.formats) ? descriptor.formats : [];
  for (const format of ['bin', 'hex']) {
    if (!formats.includes(format)) fail(`properties.firmware.formats must include "${format}"`);
  }
  const space = descriptor.addressSpaces?.code;
  if (!record(space) || space.start !== 0 || space.size !== 61440) {
    fail('properties.firmware.addressSpaces.code must be [0, 61440)');
  }
  if (!record(descriptor.defaults) || descriptor.defaults.addressSpace !== 'code') {
    fail('properties.firmware.defaults.addressSpace must be "code"');
  }
}

/** The canonical single-instance document used by the workbench demo. */
export function createDocument(release) {
  return {
    version: 2,
    dependencies: {
      [DEVICE_ID]: {
        version: release.lock.version,
        integrity: release.lock.integrity,
      },
    },
    instances: [
      {
        id: INSTANCE_ID,
        device: DEVICE_ID,
        designator: 'U1',
        placement: { x: 0, y: 0, rotation: 0 },
        properties: {
          clockFrequency: 12_000_000,
          firmware: { mode: 'package', src: PROGRAM_SOURCE },
        },
      },
    ],
    nodes: [],
    wires: [],
    labels: [],
    references: [
      {
        id: VCC_REFERENCE_ID,
        target: { kind: 'pin', instance: INSTANCE_ID, pin: 'VCC' },
        voltage: 5,
        symbol: 'power',
        label: { name: 'VCC' },
      },
      {
        id: GND_REFERENCE_ID,
        target: { kind: 'pin', instance: INSTANCE_ID, pin: 'GND' },
        voltage: 0,
        symbol: 'ground',
        label: { name: 'GND' },
      },
    ],
    display: { body: true, designators: false },
  };
}

function findReference(document, pin, voltage, symbol) {
  const matches = document.references.filter(
    (reference) =>
      reference.target.kind === 'pin' &&
      reference.target.instance === INSTANCE_ID &&
      reference.target.pin === pin,
  );
  if (matches.length !== 1) fail(`Expected exactly one ${pin} voltage reference`);
  const reference = matches[0];
  if (reference.voltage !== voltage || reference.symbol !== symbol) {
    fail(`The ${pin} reference must be ${String(voltage)} V with symbol "${symbol}"`);
  }
}

/**
 * Validates one document against the release and returns its parsed immutable form.
 *
 * @throws with every contract violation, including a dependency lock that no longer matches.
 */
export async function verifyDocument(document, release) {
  checkDeviceContract(release);
  const parsed = parseFusedDocument(document);
  const dependencies = Object.keys(parsed.dependencies);
  if (dependencies.length !== 1 || dependencies[0] !== DEVICE_ID) {
    fail(`The document must lock exactly ${DEVICE_ID}, got ${dependencies.join(', ') || 'none'}`);
  }
  const dependency = parsed.dependencies[DEVICE_ID];
  if (
    dependency.version !== release.lock.version ||
    dependency.integrity !== release.lock.integrity
  ) {
    fail(
      `The document locks ${DEVICE_ID}@${dependency.version} ${dependency.integrity}, but ` +
        `device/dist is ${release.lock.version} ${release.lock.integrity}. ` +
        'Run `pnpm run document:lock` to refresh only the lock.',
    );
  }
  if (parsed.instances.length !== 1) fail('The document must contain exactly one instance');
  const instance = parsed.instances[0];
  if (instance.id !== INSTANCE_ID) {
    fail(`The board instance id must stay ${INSTANCE_ID}, got ${instance.id}`);
  }
  if (instance.device !== DEVICE_ID) {
    fail(`The board instance must use ${DEVICE_ID}, got ${instance.device}`);
  }
  findReference(parsed, 'VCC', 5, 'power');
  findReference(parsed, 'GND', 0, 'ground');

  const firmware = instance.properties?.firmware;
  if (!record(firmware) || firmware.mode !== 'package' || typeof firmware.src !== 'string') {
    fail('The board instance must reference its firmware as a package resource');
  }
  if (!Object.hasOwn(release.files, firmware.src)) {
    fail(`The device package does not declare firmware ${firmware.src}`);
  }
  await release.read(firmware.src);

  if (parsed.nodes.length > 0 || parsed.wires.length > 0 || parsed.labels.length > 0) {
    fail('The formal single-board document must not add nodes, wires or labels');
  }
  const topology = deriveFusedTopology(parsed, new Map([[DEVICE_ID, release.manifest]]));
  if (topology.nets.length !== 2) {
    fail(`The formal document must derive exactly two nets, got ${String(topology.nets.length)}`);
  }
  for (const pin of ['VCC', 'GND']) {
    const net = topology.nets.find((candidate) =>
      candidate.pins.some((member) => member.instance === INSTANCE_ID && member.pin === pin),
    );
    if (net === undefined) fail(`Derived topology has no net for ${pin}`);
    if (net.voltage !== (pin === 'VCC' ? 5 : 0)) {
      fail(`Derived ${pin} net must carry ${pin === 'VCC' ? '5' : '0'} V`);
    }
  }
  return parsed;
}

/** Replaces only the dependency table of a user-edited document. */
export async function refreshDocumentLock(raw, release) {
  if (!record(raw) || !record(raw.dependencies)) fail('The document has no dependencies table');
  const keys = Object.keys(raw.dependencies);
  if (keys.length !== 1 || keys[0] !== DEVICE_ID) {
    fail(`The document must lock exactly ${DEVICE_ID}, got ${keys.join(', ') || 'none'}`);
  }
  const next = globalThis.structuredClone(raw);
  next.dependencies = {
    [DEVICE_ID]: {
      version: release.lock.version,
      integrity: release.lock.integrity,
    },
  };
  await verifyDocument(next, release);
  return next;
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readDocumentFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') fail(`No document at ${path}; use --write to create one`);
    throw cause;
  }
  return { text, raw: parseJsonText(text, path) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const release = await readRelease();
  checkDeviceContract(release);
  const mode = options.mode;
  if (mode === 'print' || mode === 'write') {
    const document = createDocument(release);
    await verifyDocument(document, release);
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (mode === 'print') {
      process.stdout.write(text);
      return 0;
    }
    let existing = false;
    try {
      await readFile(options.out, 'utf8');
      existing = true;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    if (existing && !options.force) {
      fail(
        `Refusing to overwrite ${options.out}; it may contain user edits. ` +
          'Use --refresh-lock to update only the dependency lock, or --force to replace it.',
      );
    }
    await writeAtomic(options.out, text);
    console.log(
      `document: wrote ${options.out} (${DEVICE_ID}@${release.lock.version} ${release.lock.integrity})`,
    );
    return 0;
  }
  const { text, raw } = await readDocumentFile(options.out);
  if (mode === 'refresh-lock') {
    const next = await refreshDocumentLock(raw, release);
    const updated = `${JSON.stringify(next, null, 2)}\n`;
    if (updated !== text) await writeAtomic(options.out, updated);
    console.log(
      `document: ${updated === text ? 'lock already current' : 'refreshed lock only'} ` +
        `${DEVICE_ID}@${release.lock.version}`,
    );
    return 0;
  }
  await verifyDocument(raw, release);
  console.log(
    `document: ok ${options.out} (${DEVICE_ID}@${release.lock.version}, one instance, VCC 5 V / GND 0 V)`,
  );
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(`document: ${cause instanceof Error ? cause.message : String(cause)}`);
      process.exitCode = 1;
    },
  );
}
