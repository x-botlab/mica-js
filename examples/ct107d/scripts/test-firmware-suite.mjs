#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';
import { parseIntelHex, DEFAULT_CODE_SPACE_SIZE } from './firmware-hex.mjs';

/**
 * Opt-in CT107D full-firmware suite.
 *
 * The suite intentionally lives outside `vitest.config.ts`: the external course
 * programs are private, ignored `dist/` resources on this checkout. It loads the
 * formal fused artifact (`device/dist/model.js`) through `bench/fused.ts`, so
 * every project runs against one instance and one JIT.
 *
 * Usage:
 *   node scripts/test-firmware-suite.mjs --list
 *   node scripts/test-firmware-suite.mjs --only ct107s-ds18b20,ct107s-uart
 *   node scripts/test-firmware-suite.mjs --jobs 2 --out /tmp/opencode/ct107d-suite
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PROJECT_ROOT, '..', '..');
const DEFAULT_MANIFEST = join(SCRIPT_DIR, 'firmware-suite.manifest.json');
const DEFAULT_SOURCE_ROOT = join(REPO_ROOT, 'dist', '蓝桥杯单片机程序');
const DEFAULT_OUT_ROOT = join('/tmp', 'opencode', 'ct107d-firmware-suite');
const PS_PER_MS = 1_000_000_000;
const RESULT_SCHEMA = 1;

const GLYPHS = new Map(
  Object.entries({
    0x3f: '0',
    0x06: '1',
    0x5b: '2',
    0x4f: '3',
    0x66: '4',
    0x6d: '5',
    0x7d: '6',
    0x07: '7',
    0x7f: '8',
    0x6f: '9',
    0x40: '-',
    0x00: ' ',
    0x77: 'A',
    0x7c: 'b',
    0x39: 'C',
    0x5e: 'd',
    0x79: 'E',
    0x71: 'F',
    0x3d: 'G',
    0x76: 'H',
    0x30: 'I',
    0x1e: 'J',
    0x75: 'h',
    0x38: 'L',
    0x54: 'n',
    0x37: 'U',
    0x73: 'P',
    0x67: 'q',
    0x50: 'r',
    0x78: 't',
    0x3e: 'U',
    0x6e: 'y',
  }).map(([key, value]) => [Number(key), value]),
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function usage() {
  return `CT107D full-firmware suite

Options:
  --manifest <file>       manifest JSON (default: scripts/firmware-suite.manifest.json)
  --root <dir>            course-program root (default: <repo>/dist/蓝桥杯单片机程序)
  --out <dir>             report directory (default: /tmp/opencode/ct107d-firmware-suite/<run-id>)
  --only <id[,id...]>     run selected project ids only
  --category <name>       run one manifest category (repeatable)
  --jobs <n>              parallel isolated child processes (default: 1, max: 8)
  --execution <mode>      throughput (default) or precise
  --timeout-ms <n>        per-project child timeout (default: 180000)
  --worker <file>         internal/test worker override (not for normal runs)
  --list                  print inventory and exit
  --dry-run               validate inventory and print the plan without running
  --keep-going            keep remaining projects after a failure (default)
  --child <id> --result <file> --token <id>   internal child mode
  --help                  show this help

Outputs: summary.json, results.jsonl, report.md, projects/<id>.json
Exit codes: 0 every executable project behavior-pass; 1 any behavior/error failure;
2 any blocked project; 3 manifest/tool/output error; 4 only partial/limited/notCovered
projects (some behavior proven, but not a complete pass).`;
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    root: DEFAULT_SOURCE_ROOT,
    out: undefined,
    only: undefined,
    categories: [],
    jobs: 1,
    execution: 'throughput',
    timeoutMs: 180_000,
    list: false,
    dryRun: false,
    child: undefined,
    result: undefined,
    token: undefined,
    worker: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === '--manifest') options.manifest = resolve(value());
    else if (argument === '--root') options.root = resolve(value());
    else if (argument === '--out') options.out = resolve(value());
    else if (argument === '--only')
      options.only = value()
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    else if (argument === '--category') options.categories.push(value());
    else if (argument === '--jobs') options.jobs = Number(value());
    else if (argument === '--execution') options.execution = value();
    else if (argument === '--timeout-ms') options.timeoutMs = Number(value());
    else if (argument === '--list') options.list = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--keep-going') options.keepGoing = true;
    else if (argument === '--child') options.child = value();
    else if (argument === '--result') options.result = resolve(value());
    else if (argument === '--token') options.token = value();
    else if (argument === '--worker') options.worker = resolve(value());
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }

  if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 8)
    throw new RangeError('--jobs must be an integer within 1..8');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError('--timeout-ms must be a positive finite number');
  if (options.execution !== 'throughput' && options.execution !== 'precise')
    throw new RangeError('--execution must be throughput or precise');
  if (options.child !== undefined && options.result === undefined)
    throw new Error('--child requires --result');
  if (options.child !== undefined && typeof options.token !== 'string')
    throw new Error('--child requires --token');
  return options;
}

const ASSERTION_TYPES = new Set([
  'signal',
  'display',
  'snapshot',
  'eeprom',
  'rtc',
  'uart',
  'changes',
]);
const EVENT_ACTIONS = new Set([
  'setSwitch',
  'setJumper',
  'setTemperature',
  'setAnalogInput',
  'sendUart',
  'setIrCarrier',
  'setHallField',
  'setWiper',
  'setAmplifierInputs',
]);
const UART_CHANNELS = new Set(['uart1Tx', 'uart1Rx', 'probeTx', 'probeRx']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSERTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function requireComparator(project, assertion, label = 'assertion') {
  if (!hasComparator(assertion))
    throw new Error(`${project.id}: ${label} ${assertion.id ?? '<anonymous>'} needs a comparator`);
  if ('closeTo' in assertion) {
    if (!Number.isFinite(assertion.closeTo))
      throw new Error(`${project.id}: ${assertion.id}: closeTo must be finite`);
    if (
      assertion.tolerance !== undefined &&
      (!Number.isFinite(assertion.tolerance) || assertion.tolerance < 0)
    )
      throw new Error(`${project.id}: ${assertion.id}: tolerance must be nonnegative finite`);
  }
  for (const key of ['min', 'max'])
    if (key in assertion && !Number.isFinite(assertion[key]))
      throw new Error(`${project.id}: ${assertion.id}: ${key} must be finite`);
  if ('matches' in assertion && typeof assertion.matches !== 'string')
    throw new Error(`${project.id}: ${assertion.id}: matches must be a string`);
  if ('matches' in assertion) {
    try {
      new RegExp(assertion.matches);
    } catch (cause) {
      throw new Error(`${project.id}: ${assertion.id}: invalid matches regex`, { cause });
    }
  }
  if ('oneOf' in assertion && (!Array.isArray(assertion.oneOf) || assertion.oneOf.length === 0))
    throw new Error(`${project.id}: ${assertion.id}: oneOf must be a nonempty array`);
  if (
    'includes' in assertion &&
    typeof assertion.includes !== 'string' &&
    !Array.isArray(assertion.includes)
  )
    throw new Error(`${project.id}: ${assertion.id}: includes must be a string or array`);
}

function validateDisplayText(project, assertion, text) {
  if (typeof text !== 'string' || [...text].length !== 4)
    throw new Error(
      `${project.id}: ${assertion.id}: display text must be exactly 4 characters, got ${JSON.stringify(text)}`,
    );
}

function validateAssertion(project, assertion, runMs, ids) {
  if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion))
    throw new Error(`${project.id}: assertion must be an object`);
  if (typeof assertion.id !== 'string' || !ASSERTION_ID_PATTERN.test(assertion.id))
    throw new Error(`${project.id}: invalid assertion id ${JSON.stringify(assertion.id)}`);
  if (ids.has(assertion.id))
    throw new Error(`${project.id}: duplicate assertion id ${assertion.id}`);
  ids.add(assertion.id);
  if (!ASSERTION_TYPES.has(assertion.type))
    throw new Error(`${project.id}: ${assertion.id}: unknown assertion type ${assertion.type}`);
  if (
    assertion.atMs !== undefined &&
    (!Number.isSafeInteger(assertion.atMs) || assertion.atMs < 0 || assertion.atMs > runMs)
  )
    throw new Error(
      `${project.id}: ${assertion.id}: atMs must be a safe integer within 0..${runMs}`,
    );
  if (assertion.optional !== undefined)
    throw new Error(`${project.id}: ${assertion.id}: optional is not supported; use limited`);
  if (assertion.limited !== undefined && typeof assertion.limited !== 'boolean')
    throw new Error(`${project.id}: ${assertion.id}: limited must be boolean`);

  switch (assertion.type) {
    case 'signal':
      if (typeof assertion.key !== 'string' || assertion.key.length === 0)
        throw new Error(`${project.id}: ${assertion.id}: signal key must be nonempty`);
      requireComparator(project, assertion);
      break;
    case 'snapshot':
      if (typeof assertion.path !== 'string' || assertion.path.length === 0)
        throw new Error(`${project.id}: ${assertion.id}: snapshot path must be nonempty`);
      requireComparator(project, assertion);
      break;
    case 'display': {
      if (assertion.designator !== 'DS1' && assertion.designator !== 'DS2')
        throw new Error(`${project.id}: ${assertion.id}: display designator must be DS1 or DS2`);
      const hasText = 'text' in assertion;
      const hasMasks = 'masks' in assertion;
      if (hasText === hasMasks)
        throw new Error(`${project.id}: ${assertion.id}: display needs exactly one of text/masks`);
      if (hasText) {
        if (Array.isArray(assertion.text)) {
          if (assertion.text.length === 0)
            throw new Error(`${project.id}: ${assertion.id}: display text array is empty`);
          for (const text of assertion.text) validateDisplayText(project, assertion, text);
        } else validateDisplayText(project, assertion, assertion.text);
      }
      if (hasMasks) {
        if (
          !Array.isArray(assertion.masks) ||
          assertion.masks.length !== 4 ||
          assertion.masks.some((mask) => !Number.isInteger(mask) || mask < 0 || mask > 0xff)
        )
          throw new Error(
            `${project.id}: ${assertion.id}: display masks must be four bytes 0..255`,
          );
      }
      break;
    }
    case 'eeprom':
      if (!Number.isInteger(assertion.address) || assertion.address < 0 || assertion.address > 0xff)
        throw new Error(`${project.id}: ${assertion.id}: eeprom address must be a byte`);
      if (assertion.bcd !== undefined && typeof assertion.bcd !== 'boolean')
        throw new Error(`${project.id}: ${assertion.id}: bcd must be boolean`);
      requireComparator(project, assertion);
      break;
    case 'rtc': {
      const hasExpectation =
        'running' in assertion || 'datetime' in assertion || 'datetimeMatches' in assertion;
      if (!hasExpectation)
        throw new Error(
          `${project.id}: ${assertion.id}: rtc needs running/datetime/datetimeMatches`,
        );
      if ('running' in assertion && typeof assertion.running !== 'boolean')
        throw new Error(`${project.id}: ${assertion.id}: rtc.running must be boolean`);
      if ('datetime' in assertion && typeof assertion.datetime !== 'string')
        throw new Error(`${project.id}: ${assertion.id}: rtc.datetime must be a string`);
      if ('datetimeMatches' in assertion) {
        if (typeof assertion.datetimeMatches !== 'string')
          throw new Error(`${project.id}: ${assertion.id}: datetimeMatches must be a string`);
        try {
          new RegExp(assertion.datetimeMatches);
        } catch (cause) {
          throw new Error(`${project.id}: ${assertion.id}: invalid datetime regex`, { cause });
        }
      }
      break;
    }
    case 'uart': {
      if (!UART_CHANNELS.has(assertion.channel))
        throw new Error(
          `${project.id}: ${assertion.id}: uart channel must be one of ${[...UART_CHANNELS].join(', ')}`,
        );
      const hasExpectation =
        'ascii' in assertion ||
        'includesAscii' in assertion ||
        'hex' in assertion ||
        'length' in assertion ||
        'equalsChannel' in assertion;
      if (!hasExpectation)
        throw new Error(
          `${project.id}: ${assertion.id}: uart needs ascii/includesAscii/hex/length/equalsChannel`,
        );
      if ('ascii' in assertion && typeof assertion.ascii !== 'string')
        throw new Error(`${project.id}: ${assertion.id}: ascii must be a string`);
      if ('includesAscii' in assertion && typeof assertion.includesAscii !== 'string')
        throw new Error(`${project.id}: ${assertion.id}: includesAscii must be a string`);
      if ('equalsChannel' in assertion) {
        if (
          typeof assertion.equalsChannel !== 'string' ||
          !UART_CHANNELS.has(assertion.equalsChannel)
        )
          throw new Error(
            `${project.id}: ${assertion.id}: equalsChannel must be one of ${[...UART_CHANNELS].join(', ')}`,
          );
        if (assertion.equalsChannel === assertion.channel)
          throw new Error(`${project.id}: ${assertion.id}: equalsChannel must differ from channel`);
      }
      if ('hex' in assertion) {
        if (
          typeof assertion.hex !== 'string' ||
          !/^[0-9a-f]*$/i.test(assertion.hex) ||
          assertion.hex.length % 2 !== 0
        )
          throw new Error(`${project.id}: ${assertion.id}: hex must be even-length hex`);
      }
      if (
        'length' in assertion &&
        (!Number.isSafeInteger(assertion.length) || assertion.length < 0)
      )
        throw new Error(`${project.id}: ${assertion.id}: length must be a nonnegative integer`);
      break;
    }
    case 'changes':
      if (typeof assertion.key !== 'string' || assertion.key.length === 0)
        throw new Error(`${project.id}: ${assertion.id}: changes key must be nonempty`);
      requireComparator(project, assertion);
      break;
    default:
      throw new Error(`${project.id}: ${assertion.id}: unhandled assertion type`);
  }
}

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.version !== 1) throw new Error(`unsupported manifest version ${manifest.version}`);
  if (!Array.isArray(manifest.projects) || manifest.projects.length === 0)
    throw new Error('manifest.projects must be a nonempty array');

  const ids = new Set();
  const directories = new Set();
  for (const project of manifest.projects) {
    if (typeof project.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(project.id))
      throw new Error(`invalid project id: ${JSON.stringify(project.id)}`);
    if (ids.has(project.id)) throw new Error(`duplicate project id: ${project.id}`);
    ids.add(project.id);
    if (typeof project.name !== 'string' || project.name.length === 0)
      throw new Error(`${project.id}: missing name`);
    if (typeof project.category !== 'string' || project.category.length === 0)
      throw new Error(`${project.id}: missing category`);
    if (typeof project.programDir !== 'string' || project.programDir.length === 0)
      throw new Error(`${project.id}: missing programDir`);
    if (directories.has(project.programDir))
      throw new Error(`${project.id}: duplicate programDir ${project.programDir}`);
    directories.add(project.programDir);
    if (project.status === 'not-applicable') {
      if (typeof project.reason !== 'string' || project.reason.length === 0)
        throw new Error(`${project.id}: not-applicable requires a reason`);
      continue;
    }
    if (project.mode !== 'behavior' && project.mode !== 'smoke')
      throw new Error(`${project.id}: mode must be behavior or smoke`);
    if (!Number.isSafeInteger(project.clockFrequency) || project.clockFrequency <= 0)
      throw new Error(`${project.id}: invalid clockFrequency`);
    if (typeof project.clockEvidence !== 'string' || project.clockEvidence.length === 0)
      throw new Error(`${project.id}: missing clockEvidence`);
    if (typeof project.hex !== 'string' || project.hex.length === 0)
      throw new Error(`${project.id}: missing hex path (use status not-applicable for documents)`);
    if (
      !Array.isArray(project.sourceEvidence) ||
      project.sourceEvidence.length === 0 ||
      project.sourceEvidence.some((entry) => typeof entry !== 'string' || entry.length === 0)
    )
      throw new Error(`${project.id}: sourceEvidence must be a nonempty string array`);
    if (project.overrideStatus !== undefined) {
      const override = project.overrideStatus;
      if (
        override === null ||
        typeof override !== 'object' ||
        override.status !== 'blocked' ||
        typeof override.reason !== 'string' ||
        override.reason.length === 0
      )
        throw new Error(`${project.id}: overrideStatus must be a blocked status with a reason`);
      const hashKeys = ['expectedHexSha256', 'expectedSourceAggregateSha256'];
      if (!hashKeys.some((key) => key in override))
        throw new Error(`${project.id}: overrideStatus needs a source/HEX hash binding`);
      for (const key of hashKeys)
        if (
          key in override &&
          (typeof override[key] !== 'string' || !SHA256_PATTERN.test(override[key]))
        )
          throw new Error(`${project.id}: overrideStatus.${key} must be a lowercase SHA-256`);
    }
    const scenario = project.scenario;
    if (scenario === null || typeof scenario !== 'object')
      throw new Error(`${project.id}: missing scenario`);
    const scenarioProps = scenario.props ?? {};
    if (scenarioProps === null || typeof scenarioProps !== 'object' || Array.isArray(scenarioProps))
      throw new Error(`${project.id}: scenario.props must be an object`);
    if (
      Object.prototype.hasOwnProperty.call(scenarioProps, 'uartBaud') &&
      (!Number.isSafeInteger(scenarioProps.uartBaud) || scenarioProps.uartBaud < 1)
    )
      throw new Error(`${project.id}: scenario.props.uartBaud must be a positive safe integer`);
    if (!Number.isSafeInteger(scenario.runMs) || scenario.runMs < 0)
      throw new Error(`${project.id}: scenario.runMs must be a nonnegative safe integer`);
    if (!Array.isArray(scenario.events))
      throw new Error(`${project.id}: scenario.events must be []`);
    if (!Array.isArray(scenario.assertions))
      throw new Error(`${project.id}: scenario.assertions must be []`);
    if (scenario.notes !== undefined) {
      if (
        !Array.isArray(scenario.notes) ||
        scenario.notes.some((entry) => typeof entry !== 'string' || entry.length === 0)
      )
        throw new Error(`${project.id}: scenario.notes must be a string array`);
    }
    if (scenario.limitations !== undefined) {
      if (
        !Array.isArray(scenario.limitations) ||
        scenario.limitations.some((entry) => typeof entry !== 'string' || entry.length === 0)
      )
        throw new Error(`${project.id}: scenario.limitations must be a string array`);
    }
    if (scenario.notCovered !== undefined) {
      if (
        !Array.isArray(scenario.notCovered) ||
        scenario.notCovered.some((entry) => typeof entry !== 'string' || entry.length === 0)
      )
        throw new Error(`${project.id}: scenario.notCovered must be a string array`);
    }
    const assertionIds = new Set();
    for (const assertion of scenario.assertions)
      validateAssertion(project, assertion, scenario.runMs, assertionIds);
    for (const event of scenario.events) {
      if (!Number.isSafeInteger(event.atMs) || event.atMs < 0 || event.atMs > scenario.runMs)
        throw new Error(
          `${project.id}: event.atMs must be a safe integer within 0..${scenario.runMs}`,
        );
      if (!EVENT_ACTIONS.has(event.action))
        throw new Error(`${project.id}: unknown event action ${JSON.stringify(event.action)}`);
    }
    if (project.mode === 'behavior') {
      const functional = scenario.assertions.filter((assertion) => assertion.limited !== true);
      if (functional.length === 0)
        throw new Error(
          `${project.id}: behavior mode needs at least one non-limited functional assertion`,
        );
    }
  }
  return manifest;
}

function readArtifactProperties() {
  const path = join(PROJECT_ROOT, 'device', 'dist', 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(`artifact package manifest is not an object: ${path}`);
  const properties = manifest.properties;
  if (properties === undefined) return {};
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties))
    throw new Error(`artifact package properties must be an object: ${path}`);
  return properties;
}

function readUartBaudProperty(properties) {
  const property = properties?.uartBaud;
  if (property === undefined) return null;
  if (property === null || typeof property !== 'object' || Array.isArray(property))
    throw new Error('artifact uartBaud property must be an object');
  if (property.type !== 'number')
    throw new Error(
      `artifact uartBaud property must be number, got ${JSON.stringify(property.type)}`,
    );
  if (!Number.isFinite(property.min) || !Number.isFinite(property.max))
    throw new Error('artifact uartBaud property needs finite min/max');
  if (property.min > property.max)
    throw new Error('artifact uartBaud property min must not exceed max');
  if (
    !Number.isSafeInteger(property.default) ||
    property.default < property.min ||
    property.default > property.max
  )
    throw new Error('artifact uartBaud property default must be an in-range safe integer');
  return property;
}

function resolveUartBaud(project, property) {
  const props = project.scenario?.props ?? {};
  const declared = Object.prototype.hasOwnProperty.call(props, 'uartBaud');
  if (!declared) {
    if (property === null) return null;
    return { value: property.default, source: 'property.default' };
  }
  if (property === null)
    throw new Error(
      `${project.id}: scenario.props.uartBaud is declared but the artifact package has no uartBaud property`,
    );
  const value = props.uartBaud;
  if (!Number.isSafeInteger(value))
    throw new Error(`${project.id}: scenario.props.uartBaud must be a safe integer`);
  if (value < property.min || value > property.max)
    throw new Error(
      `${project.id}: scenario.props.uartBaud ${value} is outside artifact range ${property.min}..${property.max}`,
    );
  return { value, source: 'scenario.props' };
}

function preflightUartBaud(manifest, property) {
  const resolved = new Map();
  for (const project of manifest.projects) {
    if (project.status === 'not-applicable') continue;
    resolved.set(project.id, resolveUartBaud(project, property));
  }
  return resolved;
}

function walk(directory, predicate) {
  const result = [];
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path, predicate));
    else if (entry.isFile() && predicate(path, entry.name)) result.push(path);
  }
  return result;
}

function fileIdentity(path) {
  const bytes = readFileSync(path);
  const stats = statSync(path);
  return {
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    mtimeMs: stats.mtimeMs,
  };
}

function aggregateSourceIdentity(programDirectory, mainSource) {
  const files = walk(programDirectory, (path) => /\.(?:c|h)$/i.test(path)).sort();
  const entries = files.map((path) => {
    const identity = fileIdentity(path);
    return {
      path: relative(programDirectory, path).split('\\').join('/'),
      bytes: identity.bytes,
      sha256: identity.sha256,
    };
  });
  const digest = sha256(
    entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join('') +
      `\0main:${mainSource ?? ''}`,
  );
  return {
    aggregateSha256: digest,
    files: entries,
    mainSource: mainSource ?? null,
  };
}

function extractUvprojClock(path) {
  if (path === null) return undefined;
  const text = readFileSync(path, 'utf8');
  const match = /<Cpu>[^<]*CLOCK\((\d+)\)/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function findSingle(files, label, id) {
  if (files.length > 1)
    throw new Error(
      `${id}: ambiguous ${label}: ${files.map((path) => relative(REPO_ROOT, path)).join(', ')}`,
    );
  return files.length === 0 ? null : files[0];
}

function inventory(options, manifest) {
  const root = resolve(options.root);
  if (!existsSync(root)) throw new Error(`course-program root does not exist: ${root}`);

  const entries = new Map();
  const claimedHex = new Set();
  const claimedUvproj = new Set();
  const executable = [];

  for (const project of manifest.projects) {
    if (project.status === 'not-applicable') {
      entries.set(project.id, {
        project,
        executable: false,
        status: 'not-applicable',
        programDirectory: join(root, project.programDir),
      });
      continue;
    }

    const programDirectory = join(root, project.programDir);
    if (!existsSync(programDirectory) || !statSync(programDirectory).isDirectory()) {
      executable.push({
        project,
        executable: true,
        status: 'blocked',
        blockedReason: `program directory missing: ${programDirectory}`,
        programDirectory,
      });
      continue;
    }

    const uvprojFiles = walk(programDirectory, (path) => path.toLowerCase().endsWith('.uvproj'));
    const uvprojPath = findSingle(uvprojFiles, 'uvproj', project.id);
    if (uvprojPath !== null) claimedUvproj.add(uvprojPath);
    const hexFiles = walk(programDirectory, (path) => path.toLowerCase().endsWith('.hex'));
    const hexPath = findSingle(hexFiles, 'HEX', project.id);

    if (hexPath === null) {
      executable.push({
        project,
        executable: true,
        status: 'blocked',
        blockedReason: `no HEX under ${programDirectory}`,
        programDirectory,
        uvprojPath,
      });
      continue;
    }

    const declaredHex = resolve(programDirectory, project.hex);
    if (declaredHex !== hexPath) {
      executable.push({
        project,
        executable: true,
        status: 'error',
        error: `manifest HEX ${declaredHex} does not match discovered ${hexPath}`,
        programDirectory,
        uvprojPath,
      });
      continue;
    }
    claimedHex.add(hexPath);

    const mainSource = join(programDirectory, project.mainSource);
    if (!existsSync(mainSource)) {
      executable.push({
        project,
        executable: true,
        status: 'blocked',
        blockedReason: `main source missing: ${mainSource}`,
        programDirectory,
        uvprojPath,
        hexPath,
      });
      continue;
    }

    const hexText = readFileSync(hexPath, 'utf8');
    const image = parseIntelHex(hexText, {
      sourceName: relative(root, hexPath),
      addressSpaceSize: DEFAULT_CODE_SPACE_SIZE,
    });
    const hexIdentity = fileIdentity(hexPath);
    const sourceIdentity = aggregateSourceIdentity(programDirectory, project.mainSource);
    const uvprojIdentity = uvprojPath === null ? null : fileIdentity(uvprojPath);
    const uvprojClock = uvprojPath === null ? undefined : extractUvprojClock(uvprojPath);

    executable.push({
      project,
      executable: true,
      status: 'ready',
      programDirectory,
      uvprojPath,
      uvprojIdentity,
      uvprojClock,
      hexPath,
      hexIdentity,
      sourceIdentity,
      image,
    });
  }

  const allHex = walk(root, (path) => path.toLowerCase().endsWith('.hex'));
  const allUvproj = walk(root, (path) => path.toLowerCase().endsWith('.uvproj'));
  const unclaimedHex = allHex.filter((path) => !claimedHex.has(path));
  const unclaimedUvproj = allUvproj.filter((path) => !claimedUvproj.has(path));
  const missingClaimedHex = [...claimedHex].filter((path) => !allHex.includes(path));

  return {
    root,
    entries,
    executable,
    coverage: {
      projects: manifest.projects.length,
      executableProjects: manifest.projects.filter((project) => project.status !== 'not-applicable')
        .length,
      notApplicable: manifest.projects.filter((project) => project.status === 'not-applicable')
        .length,
      discoveredHex: allHex.length,
      discoveredUvproj: allUvproj.length,
      claimedHex: claimedHex.size,
      claimedUvproj: claimedUvproj.size,
      unclaimedHex: unclaimedHex.map((path) => relative(root, path)),
      unclaimedUvproj: unclaimedUvproj.map((path) => relative(root, path)),
      missingClaimedHex: missingClaimedHex.map((path) => relative(root, path)),
    },
  };
}

function isoNow() {
  return new Date().toISOString();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return `${stamp}-${process.pid}`;
}

function sanitizeLabel(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
}

function displayText(masks) {
  return masks.map((mask) => GLYPHS.get(mask & 0x7f) ?? '?').join('');
}

function textToBytes(text) {
  return Buffer.from(text, 'utf8');
}

function bytesToText(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

function getPath(root, path) {
  const segments = path.split('.');
  let value = root;
  for (const segment of segments) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && /^\d+$/.test(segment)) value = value[Number(segment)];
    else if (typeof value === 'object' && segment in value) value = value[segment];
    else return undefined;
  }
  return value;
}

const COMPARATOR_KEYS = Object.freeze([
  'equals',
  'closeTo',
  'min',
  'max',
  'matches',
  'oneOf',
  'includes',
]);

function hasComparator(assertion) {
  return COMPARATOR_KEYS.some((key) => key in assertion);
}

function decodeBcd(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) return undefined;
  const high = value >> 4;
  const low = value & 0x0f;
  if (high > 9 || low > 9) return undefined;
  return high * 10 + low;
}

function compareValue(actual, assertion) {
  const expected = {};
  let pass = true;
  let reason = '';

  if (!hasComparator(assertion)) return { pass: false, expected, reason: 'no comparison operator' };

  if ('equals' in assertion) {
    expected.equals = assertion.equals;
    pass = isDeepStrictEqual(actual, assertion.equals);
    if (!pass) reason = `equals ${JSON.stringify(assertion.equals)}`;
  }
  if ('closeTo' in assertion) {
    expected.closeTo = assertion.closeTo;
    if ('tolerance' in assertion) expected.tolerance = assertion.tolerance;
    const tolerance = assertion.tolerance ?? 1e-9;
    if (typeof actual !== 'number' || !Number.isFinite(actual)) pass = false;
    else pass = pass && Math.abs(actual - assertion.closeTo) <= tolerance;
    if (!pass) reason = reason || `closeTo ${assertion.closeTo} ± ${tolerance}`;
  }
  if ('min' in assertion) {
    expected.min = assertion.min;
    pass = pass && typeof actual === 'number' && actual >= assertion.min;
    if (!pass) reason = reason || `>= ${assertion.min}`;
  }
  if ('max' in assertion) {
    expected.max = assertion.max;
    pass = pass && typeof actual === 'number' && actual <= assertion.max;
    if (!pass) reason = reason || `<= ${assertion.max}`;
  }
  if ('matches' in assertion) {
    expected.matches = assertion.matches;
    const expression = new RegExp(assertion.matches);
    pass = pass && typeof actual === 'string' && expression.test(actual);
    if (!pass) reason = reason || `matches /${assertion.matches}/`;
  }
  if ('oneOf' in assertion) {
    expected.oneOf = assertion.oneOf;
    pass = pass && assertion.oneOf.some((item) => isDeepStrictEqual(actual, item));
    if (!pass) reason = reason || `oneOf ${JSON.stringify(assertion.oneOf)}`;
  }
  if ('includes' in assertion) {
    expected.includes = assertion.includes;
    if (typeof actual === 'string') pass = pass && actual.includes(assertion.includes);
    else if (Array.isArray(actual))
      pass = pass && actual.some((item) => isDeepStrictEqual(item, assertion.includes));
    else pass = false;
    if (!pass) reason = reason || `includes ${JSON.stringify(assertion.includes)}`;
  }

  return { pass, expected, reason };
}

function evaluateCheck(check) {
  return {
    id: check.id,
    atMs: check.atMs ?? null,
    type: check.type,
    pass: check.pass,
    limited: check.limited === true,
    expected: check.expected,
    actual: check.actual,
    detail: check.detail ?? null,
  };
}

async function runProject(options, manifest, id) {
  const project = manifest.projects.find((candidate) => candidate.id === id);
  if (project === undefined) throw new Error(`unknown project id: ${id}`);
  if (project.status === 'not-applicable') throw new Error(`${id} is not an executable project`);

  const startedWall = performance.now();
  const startedCpu = process.cpuUsage();

  const modulePath = pathToFileURL(join(PROJECT_ROOT, 'bench', 'fused.ts')).href;
  const importStartedWall = performance.now();
  const importStartedCpu = process.cpuUsage();
  const { createFusedCt107dBoard } = await import(modulePath);
  const importMs = performance.now() - importStartedWall;
  const importCpu = process.cpuUsage(importStartedCpu);
  const importCpuMs = (importCpu.user + importCpu.system) / 1000;

  const programDirectory = join(options.root, project.programDir);
  const hexPath = join(programDirectory, project.hex);
  const hexText = readFileSync(hexPath, 'utf8');
  const image = parseIntelHex(hexText, {
    sourceName: relative(options.root, hexPath),
    addressSpaceSize: DEFAULT_CODE_SPACE_SIZE,
  });

  const scenario = project.scenario;
  const uartBaud = resolveUartBaud(project, readUartBaudProperty(readArtifactProperties()));
  const props = {
    clockFrequency: project.clockFrequency,
    ...(scenario.props ?? {}),
  };
  if (uartBaud !== null) props.uartBaud = uartBaud.value;

  const assemblyStartedWall = performance.now();
  const assemblyStartedCpu = process.cpuUsage();
  let fused;
  try {
    fused = await createFusedCt107dBoard({
      firmware: image.bytes,
      props,
      execution: options.execution,
    });
  } catch (cause) {
    const assemblyCpu = process.cpuUsage(assemblyStartedCpu);
    return {
      schemaVersion: RESULT_SCHEMA,
      id: project.id,
      category: project.category,
      name: project.name,
      mode: project.mode,
      status: 'error',
      pass: false,
      error: {
        message: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      },
      clock: {
        frequencyHz: project.clockFrequency,
        evidence: project.clockEvidence,
        uvprojClockHz: null,
      },
      uartBaud,
      source: {
        programDir: project.programDir,
        mainSource: project.mainSource,
        hex: {
          path: project.hex,
          sha256: sha256(readFileSync(hexPath)),
          imageSha256: image.imageSha256,
          dataBytes: image.dataBytes,
          length: image.length,
        },
      },
      scenario,
      metrics: {
        wallMs: performance.now() - startedWall,
        cpuMs: (process.cpuUsage(startedCpu).user + process.cpuUsage(startedCpu).system) / 1000,
        importMs,
        importCpuMs,
        assemblyMs: performance.now() - assemblyStartedWall,
        assemblyCpuMs: (assemblyCpu.user + assemblyCpu.system) / 1000,
        simTimeMs: 0,
        checkpoints: [],
      },
      checks: [],
      assertions: { total: 0, passed: 0, failed: 0 },
    };
  }
  const assemblyMs = performance.now() - assemblyStartedWall;
  const assemblyCpu = process.cpuUsage(assemblyStartedCpu);
  const assemblyCpuMs = (assemblyCpu.user + assemblyCpu.system) / 1000;

  const observations = {
    topicMessages: 0,
    signalEvents: 0,
    bytesEvents: 0,
    uart1Tx: [],
    uart1Rx: [],
    probeTx: [],
    probeRx: [],
    displayUpdates: { DS1: 0, DS2: 0 },
    signalUpdates: {},
    bytesUpdates: {},
    latestSignals: new Map(),
    latestBytes: new Map(),
    lastTopicTimePs: 0,
  };

  const subscription = fused.board.topics.onDidReceive((message) => {
    observations.topicMessages += 1;
    observations.lastTopicTimePs = fused.board.time;
    if (message.topic === 'signal') {
      const value = message.payload;
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof value.designator === 'string' &&
        typeof value.port === 'string' &&
        typeof value.value === 'number'
      ) {
        observations.signalEvents += 1;
        const key = `${value.designator}/${value.port}`;
        observations.latestSignals.set(key, value.value);
        observations.signalUpdates[key] = (observations.signalUpdates[key] ?? 0) + 1;
        if (key.startsWith('DS1/digit')) observations.displayUpdates.DS1 += 1;
        else if (key.startsWith('DS2/digit')) observations.displayUpdates.DS2 += 1;
      }
    } else if (message.topic === 'bytes') {
      const value = message.payload;
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof value.designator === 'string' &&
        typeof value.port === 'string' &&
        (value.data instanceof Uint8Array || Array.isArray(value.data))
      ) {
        observations.bytesEvents += 1;
        const key = `${value.designator}/${value.port}`;
        const data = new Uint8Array(value.data);
        observations.latestBytes.set(key, data);
        observations.bytesUpdates[key] = (observations.bytesUpdates[key] ?? 0) + 1;
        if (key === 'UART_PROBE/tx') observations.probeTx.push(...data);
        else if (key === 'UART_PROBE/rx') observations.probeRx.push(...data);
      }
    } else if (message.topic === 'uart1.tx') {
      const data = message.payload?.data;
      if (data !== undefined) observations.uart1Tx.push(...new Uint8Array(data));
    } else if (message.topic === 'uart1.rx') {
      const data = message.payload?.data;
      if (data !== undefined) observations.uart1Rx.push(...new Uint8Array(data));
    }
  });

  const checkpoints = [];
  const checks = [];
  const events = [...scenario.events].sort(
    (left, right) => left.atMs - right.atMs || (left.order ?? 0) - (right.order ?? 0),
  );
  const assertionTimes = scenario.assertions
    .map((assertion) => assertion.atMs ?? scenario.runMs)
    .filter((value) => Number.isFinite(value));
  const allTimes = [
    ...new Set([...events.map((event) => event.atMs), ...assertionTimes, scenario.runMs]),
  ].sort((left, right) => left - right);

  const appliedEvents = [];
  let stepCount = 0;
  const runStartedCpu = process.cpuUsage();
  const runStartedWall = performance.now();

  const snapshotState = (atMs) => {
    const snapshot = fused.methods.getSnapshot?.(null);
    const rtc = fused.methods.getRtc?.(null);
    const eeprom = fused.methods.getEeprom?.(null);
    return {
      atMs,
      simTimePs: fused.board.time,
      status: fused.board.status,
      faults: [...fused.faults],
      snapshot,
      rtc,
      eeprom,
      signals: Object.fromEntries([...observations.latestSignals.entries()].sort()),
      signalUpdates: { ...observations.signalUpdates },
      displays: snapshot?.displays ?? null,
      uart: {
        uart1Tx: [...observations.uart1Tx],
        uart1Rx: [...observations.uart1Rx],
        probeTx: [...observations.probeTx],
        probeRx: [...observations.probeRx],
      },
    };
  };

  const applyEvent = (event) => {
    const params = event.params ?? {};
    const methods = fused.methods;
    let actual;
    try {
      switch (event.action) {
        case 'setSwitch':
          actual = methods.setSwitch({ designator: event.designator, pressed: event.pressed });
          break;
        case 'setJumper':
          actual = methods.setJumper({ designator: event.designator, closed: event.closed });
          break;
        case 'setTemperature':
          actual = methods.setTemperature({ value: event.value });
          break;
        case 'setAnalogInput':
          actual = methods.setAnalogInput({ channel: event.channel, value: event.value });
          break;
        case 'sendUart': {
          const data =
            event.hex !== undefined
              ? Buffer.from(event.hex, 'hex')
              : textToBytes(event.ascii ?? '');
          actual = methods.sendUart({ data: new Uint8Array(data) });
          break;
        }
        case 'setIrCarrier':
          actual = methods.setIrCarrier({ designator: event.designator, value: event.value });
          break;
        case 'setHallField':
          actual = methods.setHallField({ value: event.value });
          break;
        case 'setWiper':
          actual = methods.setWiper({ value: event.value });
          break;
        case 'setAmplifierInputs':
          actual = methods.setAmplifierInputs({ plus: event.plus, minus: event.minus });
          break;
        default:
          throw new Error(`unknown scenario action: ${event.action}`);
      }
    } catch (cause) {
      const error = new Error(
        `event ${event.action} at ${event.atMs}ms failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
      error.scenarioEvent = event;
      throw error;
    }
    appliedEvents.push({
      ...event,
      params,
      actualSimTimePs: fused.board.time,
      actualSimTimeMs: fused.board.time / PS_PER_MS,
      result: actual ?? null,
    });
  };

  let activeError;
  try {
    fused.board.runUntil(0);
    stepCount += 1;
    for (const atMs of allTimes) {
      const targetPs = Math.round(atMs * PS_PER_MS);
      if (fused.board.time < targetPs) {
        fused.board.runUntil(targetPs);
        stepCount += 1;
      }
      for (const event of events.filter((candidate) => candidate.atMs === atMs)) applyEvent(event);
      const state = snapshotState(atMs);
      checkpoints.push({
        atMs,
        simTimePs: state.simTimePs,
        status: state.status,
        faults: state.faults,
        displays: state.displays,
        latches: state.snapshot?.latches ?? null,
        temperature: state.snapshot?.temperature ?? null,
        pcf8591: state.snapshot?.pcf8591 ?? null,
        relay: state.snapshot?.relay ?? null,
        buzzer: state.snapshot?.buzzer ?? null,
        rtc: state.rtc ?? null,
        uart: {
          uart1Tx: Buffer.from(state.uart.uart1Tx).toString('hex'),
          uart1Rx: Buffer.from(state.uart.uart1Rx).toString('hex'),
          probeTx: Buffer.from(state.uart.probeTx).toString('hex'),
          probeRx: Buffer.from(state.uart.probeRx).toString('hex'),
        },
      });
      for (const assertion of scenario.assertions.filter(
        (candidate) => (candidate.atMs ?? scenario.runMs) === atMs,
      )) {
        checks.push({
          ...evaluateAssertion(assertion, state),
          limited: assertion.limited === true,
        });
      }
    }
  } catch (cause) {
    activeError = cause;
  }

  const runMs = performance.now() - runStartedWall;
  const runCpu = process.cpuUsage(runStartedCpu);
  const runCpuMs = (runCpu.user + runCpu.system) / 1000;
  const finalState = snapshotState(scenario.runMs);
  const finalSnapshot = finalState.snapshot ?? null;

  subscription.dispose();

  const runtime = fused.board;
  const internals = runtime;
  const jits = internals.jits ?? [];
  let directCompiles = 0;
  let directCalls = 0;
  let directFallbacks = 0;
  let directPrograms = 0;
  let cachedInstructions = 0;
  let pollingInstructions = 0;
  for (const jit of jits) {
    directCompiles += jit.directStats?.directCompiles ?? 0;
    directCalls += jit.directStats?.directCalls ?? 0;
    directFallbacks += jit.directStats?.directFallbacks ?? 0;
    directPrograms += jit.directPrograms?.size ?? 0;
    cachedInstructions += jit.cache?.size ?? 0;
    pollingInstructions += [...(jit.cache?.values() ?? [])].filter((entry) => entry.polling).length;
  }

  const guardChecks = [];
  const status = finalState.status;
  guardChecks.push({
    id: 'board-ready',
    type: 'status',
    atMs: scenario.runMs,
    pass: status === 'ready',
    expected: 'ready',
    actual: status,
    detail: status === 'ready' ? null : 'board did not reach ready',
  });
  guardChecks.push({
    id: 'no-faults',
    type: 'faults',
    atMs: scenario.runMs,
    pass: finalState.faults.length === 0,
    expected: [],
    actual: finalState.faults,
    detail: finalState.faults.length === 0 ? null : finalState.faults.join('; '),
  });
  guardChecks.push({
    id: 'single-instance',
    type: 'structure',
    atMs: scenario.runMs,
    pass: fused.instances === 1,
    expected: 1,
    actual: fused.instances,
    detail: fused.instances === 1 ? null : 'fused artifact must contain exactly one instance',
  });
  guardChecks.push({
    id: 'single-jit',
    type: 'structure',
    atMs: scenario.runMs,
    pass: fused.jits === 1,
    expected: 1,
    actual: fused.jits,
    detail: fused.jits === 1 ? null : 'fused artifact must contain exactly one JIT',
  });
  guardChecks.push({
    id: 'clock-frequency',
    type: 'structure',
    atMs: scenario.runMs,
    pass: fused.clockFrequency === project.clockFrequency,
    expected: project.clockFrequency,
    actual: fused.clockFrequency,
    detail:
      fused.clockFrequency === project.clockFrequency
        ? null
        : 'board clock does not match the manifest clock',
  });

  const functionalChecks = checks;
  const functionalFailures = functionalChecks.filter((check) => !check.pass && !check.limited);
  const functionalPasses = functionalChecks.filter((check) => check.pass && !check.limited);
  const limitedChecks = functionalChecks.filter((check) => check.limited);
  const guardFailures = guardChecks.filter((check) => !check.pass);
  const notCovered = Array.isArray(project.scenario.notCovered) ? project.scenario.notCovered : [];
  const assertions = {
    total: functionalChecks.length,
    passed: functionalPasses.length,
    failed: functionalFailures.length,
    limited: limitedChecks.length,
    notCovered: notCovered.length,
  };
  const guards = {
    total: guardChecks.length,
    passed: guardChecks.length - guardFailures.length,
    failed: guardFailures.length,
  };

  const limitations = Array.isArray(project.scenario.limitations)
    ? project.scenario.limitations
    : [];
  const statusOutcome =
    activeError !== undefined
      ? 'error'
      : guardFailures.length > 0
        ? 'error'
        : functionalFailures.length > 0
          ? project.mode === 'behavior'
            ? 'behavior-fail'
            : 'smoke-fail'
          : functionalChecks.length === 0
            ? 'error'
            : project.mode === 'behavior'
              ? limitedChecks.length > 0 || notCovered.length > 0
                ? 'behavior-partial'
                : 'behavior-pass'
              : 'smoke-pass';
  const guardError =
    activeError === undefined && guardFailures.length > 0
      ? new Error(
          `structure guard failed: ${guardFailures.map((check) => `${check.id}=${JSON.stringify(check.actual)}`).join(', ')}`,
        )
      : undefined;

  const runError = activeError ?? guardError;
  const statusFinal = statusOutcome;
  const passFinal = statusFinal === 'behavior-pass' || statusFinal === 'smoke-pass';
  const result = {
    schemaVersion: RESULT_SCHEMA,
    runToken: options.token,
    id: project.id,
    category: project.category,
    name: project.name,
    mode: project.mode,
    status: statusFinal,
    pass: passFinal,
    ...(runError === undefined
      ? {}
      : {
          error: {
            message: runError.message,
            stack: runError.stack,
            scenarioEvent: runError.scenarioEvent ?? null,
          },
        }),
    clock: {
      frequencyHz: project.clockFrequency,
      evidence: project.clockEvidence,
    },
    uartBaud,
    source: {
      programDir: project.programDir,
      mainSource: project.mainSource,
      evidence: project.sourceEvidence ?? [],
      hex: {
        path: project.hex,
        sourceSha256: image.sourceSha256,
        imageSha256: image.imageSha256,
        dataBytes: image.dataBytes,
        length: image.length,
        records: image.records,
        dataRecords: image.dataRecords,
        minAddress: image.minAddress,
        maxAddress: image.maxAddress,
        entry: image.entry ?? null,
      },
    },
    scenario: {
      props,
      execution: options.execution,
      runMs: scenario.runMs,
      events: scenario.events,
      assertions: scenario.assertions,
      notes: [...(project.notes ?? []), ...(scenario.notes ?? [])],
      limitations,
      notCovered,
    },
    timeline: appliedEvents,
    metrics: {
      wallMs: performance.now() - startedWall,
      cpuMs: (process.cpuUsage(startedCpu).user + process.cpuUsage(startedCpu).system) / 1000,
      importMs,
      importCpuMs,
      assemblyMs,
      assemblyCpuMs,
      runMs,
      runCpuMs,
      observeMs: 0,
      assertMs: 0,
      simTimePs: fused.board.time,
      simTimeMs: fused.board.time / PS_PER_MS,
      runUntilCalls: stepCount,
      checkpoints: checkpoints.map((checkpoint) => checkpoint.atMs),
      workload: {
        instances: fused.instances,
        jits: fused.jits,
        directCompiles,
        directCalls,
        directFallbacks,
        directPrograms,
        cachedInstructions,
        pollingInstructions,
      },
      observations: {
        topicMessages: observations.topicMessages,
        signalEvents: observations.signalEvents,
        bytesEvents: observations.bytesEvents,
        uart1TxBytes: observations.uart1Tx.length,
        uart1RxBytes: observations.uart1Rx.length,
        probeTxBytes: observations.probeTx.length,
        probeRxBytes: observations.probeRx.length,
        displayUpdates: observations.displayUpdates,
        signalKeys: Object.keys(observations.signalUpdates).length,
        bytesKeys: Object.keys(observations.bytesUpdates).length,
        lastTopicTimePs: observations.lastTopicTimePs,
      },
    },
    guards: guardChecks.map(evaluateCheck),
    guardCounts: guards,
    checks: functionalChecks.map(evaluateCheck),
    assertions,
    notCovered,
    observations: {
      finalStatus: status,
      finalFaults: finalState.faults,
      displays: finalState.displays,
      displayText: finalState.displays
        ? {
            DS1: displayText(finalState.displays.DS1 ?? []),
            DS2: displayText(finalState.displays.DS2 ?? []),
          }
        : null,
      latches: finalSnapshot?.latches ?? null,
      temperature: finalSnapshot?.temperature ?? null,
      pcf8591: finalSnapshot?.pcf8591 ?? null,
      relay: finalSnapshot?.relay ?? null,
      buzzer: finalSnapshot?.buzzer ?? null,
      rtc: finalState.rtc ?? null,
      uart: {
        uart1TxText: bytesToText(finalState.uart.uart1Tx),
        uart1TxHex: Buffer.from(finalState.uart.uart1Tx).toString('hex'),
        uart1RxText: bytesToText(finalState.uart.uart1Rx),
        uart1RxHex: Buffer.from(finalState.uart.uart1Rx).toString('hex'),
        probeTxText: bytesToText(finalState.uart.probeTx),
        probeTxHex: Buffer.from(finalState.uart.probeTx).toString('hex'),
        probeRxText: bytesToText(finalState.uart.probeRx),
        probeRxHex: Buffer.from(finalState.uart.probeRx).toString('hex'),
      },
      eepromHex: finalState.eeprom ? Buffer.from(finalState.eeprom).toString('hex') : null,
      checkpoints: checkpoints.map((checkpoint) => ({
        atMs: checkpoint.atMs,
        simTimePs: checkpoint.simTimePs,
        status: checkpoint.status,
        faults: checkpoint.faults,
        displays: checkpoint.displays,
        displayText: checkpoint.displays
          ? {
              DS1: displayText(checkpoint.displays.DS1 ?? []),
              DS2: displayText(checkpoint.displays.DS2 ?? []),
            }
          : null,
        latches: checkpoint.latches,
        temperature: checkpoint.temperature,
        pcf8591: checkpoint.pcf8591,
        rtc: checkpoint.rtc,
        uart: checkpoint.uart,
      })),
      signalUpdates: observations.signalUpdates,
      bytesUpdates: observations.bytesUpdates,
    },
  };

  fused.dispose();
  return result;
}

function evaluateAssertion(assertion, state) {
  const snapshot = state.snapshot ?? {};
  const rtc = state.rtc ?? null;
  const eeprom = state.eeprom ?? null;
  const atMs = assertion.atMs ?? state.atMs;
  const id = assertion.id ?? `${assertion.type}@${atMs}`;
  switch (assertion.type) {
    case 'signal': {
      const actual = state.signals[assertion.key];
      const compared = compareValue(actual, assertion);
      return {
        id,
        atMs,
        type: 'signal',
        pass: compared.pass,
        expected: { key: assertion.key, ...compared.expected },
        actual: { key: assertion.key, value: actual ?? null },
        detail: compared.reason || null,
      };
    }
    case 'display': {
      const designator = assertion.designator;
      const actualMasks = state.displays?.[designator] ?? null;
      let actualValue = actualMasks;
      let pass;
      let expected;
      if ('masks' in assertion) {
        expected = { masks: assertion.masks };
        pass = isDeepStrictEqual(actualMasks, assertion.masks);
      } else if ('text' in assertion) {
        expected = { text: assertion.text, masks: assertion.masks ?? undefined };
        const actualText = actualMasks === null ? null : displayText(actualMasks);
        actualValue = { text: actualText, masks: actualMasks };
        pass = Array.isArray(assertion.text)
          ? assertion.text.includes(actualText)
          : actualText === assertion.text;
      } else {
        pass = false;
        expected = { text: 'or masks' };
      }
      return {
        id,
        atMs,
        type: 'display',
        pass,
        expected,
        actual: { designator, value: actualValue },
        detail: pass ? null : `${designator} mismatch`,
      };
    }
    case 'snapshot': {
      const actual = getPath(snapshot, assertion.path);
      const compared = compareValue(actual, assertion);
      return {
        id,
        atMs,
        type: 'snapshot',
        pass: compared.pass,
        expected: { path: assertion.path, ...compared.expected },
        actual: { path: assertion.path, value: actual ?? null },
        detail: compared.reason || null,
      };
    }
    case 'eeprom': {
      const address = assertion.address;
      const raw = eeprom === null ? undefined : eeprom[address];
      const actual = assertion.bcd === true ? decodeBcd(raw) : raw;
      const compared = compareValue(actual, assertion);
      const invalidBcd = assertion.bcd === true && actual === undefined;
      return {
        id,
        atMs,
        type: 'eeprom',
        pass: !invalidBcd && compared.pass,
        expected: { address, ...(assertion.bcd ? { bcd: true } : {}), ...compared.expected },
        actual: { address, raw: raw ?? null, value: actual ?? null },
        detail: invalidBcd ? 'invalid BCD byte' : compared.reason || null,
      };
    }
    case 'rtc': {
      const actual = rtc;
      const hasExpectation =
        'running' in assertion || 'datetime' in assertion || 'datetimeMatches' in assertion;
      if (!hasExpectation)
        return {
          id,
          atMs,
          type: 'rtc',
          pass: false,
          expected: { rtc: 'running/datetime/datetimeMatches' },
          actual,
          detail: 'RTC assertion has no expected property',
        };
      let pass = true;
      const expected = {};
      if ('running' in assertion) {
        expected.running = assertion.running;
        pass = pass && actual?.running === assertion.running;
      }
      if ('datetime' in assertion) {
        expected.datetime = assertion.datetime;
        pass = pass && actual?.datetime === assertion.datetime;
      }
      if ('datetimeMatches' in assertion) {
        expected.datetimeMatches = assertion.datetimeMatches;
        const expression = new RegExp(assertion.datetimeMatches);
        pass = pass && typeof actual?.datetime === 'string' && expression.test(actual.datetime);
      }
      return {
        id,
        atMs,
        type: 'rtc',
        pass,
        expected,
        actual: actual ?? null,
        detail: pass ? null : 'RTC mismatch',
      };
    }
    case 'changes': {
      const actual = state.signalUpdates?.[assertion.key] ?? 0;
      const compared = compareValue(actual, assertion);
      return {
        id,
        atMs,
        type: 'changes',
        pass: compared.pass,
        expected: { key: assertion.key, ...compared.expected },
        actual: { key: assertion.key, changes: actual },
        detail: compared.reason || null,
      };
    }
    case 'uart': {
      const channel = assertion.channel;
      const bytes = state.uart?.[channel] ?? [];
      const actualText = bytesToText(bytes);
      const actualHex = Buffer.from(bytes).toString('hex');
      const hasExpectation =
        'ascii' in assertion ||
        'includesAscii' in assertion ||
        'hex' in assertion ||
        'length' in assertion ||
        'equalsChannel' in assertion;
      if (!hasExpectation || typeof channel !== 'string')
        return {
          id,
          atMs,
          type: 'uart',
          pass: false,
          expected: { channel: 'ascii/includesAscii/hex/length/equalsChannel' },
          actual: { channel: channel ?? null, text: actualText, hex: actualHex },
          detail: 'UART assertion has no channel/expected property',
        };
      let pass = true;
      const expected = {};
      if ('ascii' in assertion) {
        expected.ascii = assertion.ascii;
        pass = pass && actualText === assertion.ascii;
      }
      if ('includesAscii' in assertion) {
        expected.includesAscii = assertion.includesAscii;
        pass = pass && actualText.includes(assertion.includesAscii);
      }
      if ('hex' in assertion) {
        expected.hex = assertion.hex;
        pass = pass && actualHex.toLowerCase() === assertion.hex.toLowerCase();
      }
      if ('length' in assertion) {
        expected.length = assertion.length;
        pass = pass && bytes.length === assertion.length;
      }
      let equalsChannel;
      let equal;
      let referenceHex;
      let referenceLength;
      if ('equalsChannel' in assertion) {
        equalsChannel = assertion.equalsChannel;
        const other = state.uart?.[equalsChannel] ?? [];
        referenceHex = Buffer.from(other).toString('hex');
        referenceLength = other.length;
        equal = actualHex === referenceHex;
        expected.equalsChannel = equalsChannel;
        pass = pass && equal;
      }
      return {
        id,
        atMs,
        type: 'uart',
        pass,
        expected: { channel, ...expected },
        actual: {
          channel,
          text: actualText,
          hex: actualHex,
          length: bytes.length,
          ...(equalsChannel === undefined
            ? {}
            : { equalsChannel, equal, referenceHex, referenceLength }),
        },
        detail: pass
          ? null
          : equalsChannel !== undefined && !equal
            ? `${channel} != ${equalsChannel}`
            : `${channel} mismatch`,
      };
    }
    default:
      return {
        id,
        atMs,
        type: assertion.type,
        pass: false,
        expected: null,
        actual: null,
        detail: `unknown assertion type ${JSON.stringify(assertion.type)}`,
      };
  }
}

function applyOverrideStatus(project, result) {
  const override = project.overrideStatus;
  if (override === undefined) return result;
  const reject = (reason) => {
    result.overrideStatus = { ...override, applied: false, ignoredReason: reason };
    return result;
  };
  if (result.status === 'error') return reject('run ended in error; overrides cannot hide errors');
  if (result.status !== 'behavior-fail')
    return reject(`base status is ${result.status}; only an executed behavior-fail may be blocked`);
  if ((result.guardCounts?.failed ?? 0) > 0) return reject('structure guard failed');
  const hexHash = result.source?.hex?.fileSha256 ?? result.source?.hex?.sourceSha256;
  const sourceHash = result.source?.sourceAggregateSha256;
  if (override.expectedHexSha256 !== undefined && override.expectedHexSha256 !== hexHash)
    return reject('HEX SHA-256 does not match the bound mismatch artifact');
  if (
    override.expectedSourceAggregateSha256 !== undefined &&
    override.expectedSourceAggregateSha256 !== sourceHash
  )
    return reject('source aggregate SHA-256 does not match the bound mismatch source');
  result.status = 'blocked';
  result.pass = null;
  result.blockedReason = override.reason;
  result.overrideStatus = { ...override, applied: true };
  return result;
}

function makeRunDirectory(options) {
  const directory =
    options.out !== undefined
      ? options.out
      : join(
          DEFAULT_OUT_ROOT,
          `${runId()}${options.label ? `-${sanitizeLabel(options.label)}` : ''}`,
        );
  if (existsSync(directory)) {
    if (!statSync(directory).isDirectory())
      throw new Error(`output path exists and is not a directory: ${directory}`);
    if (readdirSync(directory).length > 0)
      throw new Error(
        `output directory is not empty: ${directory}; choose a new --out or remove it first`,
      );
  }
  return directory;
}

function nodeChildArgs() {
  const args = [];
  if (process.features.typescript !== 'strip') {
    if (process.allowedNodeEnvironmentFlags.has('--experimental-strip-types'))
      args.push('--experimental-strip-types');
  }
  return args;
}

function spawnProject(options, id, resultPath) {
  return new Promise((resolvePromise) => {
    const worker = options.worker ?? fileURLToPath(import.meta.url);
    const args = [
      ...nodeChildArgs(),
      worker,
      '--child',
      id,
      '--result',
      resultPath,
      '--manifest',
      options.manifest,
      '--root',
      options.root,
      '--execution',
      options.execution,
      '--token',
      options.token,
    ];
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const limit = 64 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...payload, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-limit);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-limit);
    });
    child.on('error', (error) => finish({ code: null, signal: null, error }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

async function runAll(options) {
  const manifest = readManifest(options.manifest);
  const inventoryResult = inventory(options, manifest);

  if (inventoryResult.coverage.unclaimedHex.length > 0) {
    throw new Error(
      `manifest does not cover ${inventoryResult.coverage.unclaimedHex.length} discovered HEX file(s): ${inventoryResult.coverage.unclaimedHex.join(', ')}`,
    );
  }
  if (inventoryResult.coverage.unclaimedUvproj.length > 0) {
    throw new Error(
      `manifest does not cover ${inventoryResult.coverage.unclaimedUvproj.length} discovered uvproj file(s): ${inventoryResult.coverage.unclaimedUvproj.join(', ')}`,
    );
  }
  if (inventoryResult.coverage.missingClaimedHex.length > 0) {
    throw new Error(
      `manifest claims missing HEX file(s): ${inventoryResult.coverage.missingClaimedHex.join(', ')}`,
    );
  }

  const selected = new Set(inventoryResult.executable.map((entry) => entry.project.id));
  let runnable = inventoryResult.executable;
  if (options.only !== undefined) {
    for (const id of options.only) {
      if (!manifest.projects.some((project) => project.id === id))
        throw new Error(`unknown project id in --only: ${id}`);
    }
    runnable = runnable.filter((entry) => options.only.includes(entry.project.id));
    for (const id of options.only) selected.add(id);
  }
  if (options.categories.length > 0) {
    runnable = runnable.filter((entry) => options.categories.includes(entry.project.category));
  }

  const selectedNotApplicable = manifest.projects
    .filter((project) => project.status === 'not-applicable')
    .filter((project) => (options.only === undefined ? true : options.only.includes(project.id)));

  if (options.list) {
    console.log(
      JSON.stringify({ inventory: inventoryResult.coverage, projects: manifest.projects }, null, 2),
    );
    return 0;
  }

  const uartBaudProperty = readUartBaudProperty(readArtifactProperties());
  const uartBaudByProject = preflightUartBaud(manifest, uartBaudProperty);

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          coverage: inventoryResult.coverage,
          runnable: runnable.map((entry) => ({
            id: entry.project.id,
            status: entry.status,
            mode: entry.project.mode,
            clockFrequency: entry.project.clockFrequency,
            uartBaud: uartBaudByProject.get(entry.project.id) ?? null,
            hex: entry.project.hex,
            blockedReason: entry.blockedReason,
          })),
          notApplicable: selectedNotApplicable.map((project) => ({
            id: project.id,
            reason: project.reason,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (options.worker !== undefined && !existsSync(options.worker))
    throw new Error(`worker does not exist: ${options.worker}`);
  const sourceManifestPath = options.manifest;
  const outputDirectory = makeRunDirectory(options);
  mkdirSync(join(outputDirectory, 'projects'), { recursive: true });
  const manifestBytes = readFileSync(sourceManifestPath);
  const manifestSnapshotPath = join(outputDirectory, 'manifest.snapshot.json');
  writeFileSync(manifestSnapshotPath, manifestBytes);
  options.manifest = manifestSnapshotPath;
  options.token ??= randomUUID();
  const runStartedAt = isoNow();
  const runStartedPerformance = performance.now();
  const runStartedCpu = process.cpuUsage();
  const results = [];

  for (const project of selectedNotApplicable) {
    results.push({
      schemaVersion: RESULT_SCHEMA,
      id: project.id,
      category: project.category,
      name: project.name,
      status: 'not-applicable',
      pass: null,
      mode: 'not-applicable',
      reason: project.reason,
      source: { programDir: project.programDir },
    });
  }

  const runToken = options.token;
  const makeErrorResult = (entry, message, extra = {}) => ({
    schemaVersion: RESULT_SCHEMA,
    runToken,
    id: entry.project.id,
    category: entry.project.category,
    name: entry.project.name,
    mode: entry.project.mode,
    status: 'error',
    pass: false,
    error: {
      message,
      ...extra,
    },
    clock: {
      frequencyHz: entry.project.clockFrequency,
      evidence: entry.project.clockEvidence,
    },
    uartBaud: uartBaudByProject.get(entry.project.id) ?? null,
    source: {
      programDir: entry.project.programDir,
      mainSource: entry.project.mainSource,
      evidence: entry.project.sourceEvidence ?? [],
      hex: { path: entry.project.hex },
    },
    scenario: entry.project.scenario,
    guards: [],
    guardCounts: { total: 0, passed: 0, failed: 0 },
    checks: [],
    assertions: { total: 0, passed: 0, failed: 0, limited: 0, notCovered: 0 },
    notCovered: entry.project.scenario.notCovered ?? [],
  });

  const queue = [...runnable];
  let completed = 0;
  const total = queue.length;
  const workers = Array.from(
    { length: Math.min(options.jobs, Math.max(1, queue.length)) },
    async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry === undefined) return;
        const id = entry.project.id;
        const resultPath = join(outputDirectory, 'projects', `${id}.json`);
        const started = performance.now();
        try {
          if (entry.status !== 'ready') {
            const result = {
              schemaVersion: RESULT_SCHEMA,
              runToken,
              id: entry.project.id,
              category: entry.project.category,
              name: entry.project.name,
              mode: entry.project.mode,
              status: entry.status === 'blocked' ? 'blocked' : 'error',
              pass: null,
              blockedReason: entry.blockedReason ?? null,
              error: entry.error ?? null,
              clock: {
                frequencyHz: entry.project.clockFrequency,
                evidence: entry.project.clockEvidence,
              },
              uartBaud: uartBaudByProject.get(entry.project.id) ?? null,
              source: {
                programDir: entry.project.programDir,
                mainSource: entry.project.mainSource,
                evidence: entry.project.sourceEvidence ?? [],
                hex: { path: entry.project.hex },
              },
              scenario: entry.project.scenario,
              guards: [],
              guardCounts: { total: 0, passed: 0, failed: 0 },
              checks: [],
              assertions: { total: 0, passed: 0, failed: 0, limited: 0, notCovered: 0 },
              notCovered: entry.project.scenario.notCovered ?? [],
            };
            writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
            results.push(result);
            completed += 1;
            console.log(
              `[${completed}/${total}] ${id} ${result.status}${result.blockedReason ? `: ${result.blockedReason}` : ''}`,
            );
            continue;
          }
          if (existsSync(resultPath))
            throw new Error(`refusing to reuse stale result file: ${resultPath}`);
          const childStarted = performance.now();
          const child = await spawnProject(options, id, resultPath);
          const childWallMs = performance.now() - childStarted;
          let result;
          if (!existsSync(resultPath)) {
            result = makeErrorResult(
              entry,
              `child produced no result (exit ${child.code}, signal ${child.signal}${child.error ? `, error ${child.error.message}` : ''})`,
              {
                stderr: child.stderr.slice(-4000),
                stdout: child.stdout.slice(-4000),
              },
            );
          } else {
            try {
              result = JSON.parse(readFileSync(resultPath, 'utf8'));
            } catch (cause) {
              result = makeErrorResult(
                entry,
                `child result is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
                { stderr: child.stderr.slice(-4000), stdout: child.stdout.slice(-4000) },
              );
            }
            if (result.runToken !== runToken && result.status !== 'error') {
              result = makeErrorResult(
                entry,
                `child result token mismatch: expected ${runToken}, got ${String(result.runToken)}`,
                { stderr: child.stderr.slice(-4000), stdout: child.stdout.slice(-4000) },
              );
            }
          }
          result.child = {
            exitCode: child.code,
            signal: child.signal,
            wallMs: childWallMs,
            stdoutTail: child.stdout.slice(-2000),
            stderrTail: child.stderr.slice(-4000),
          };
          if (!result.guardCounts && Array.isArray(result.guards)) {
            const passed = result.guards.filter((guard) => guard.pass === true).length;
            result.guardCounts = {
              total: result.guards.length,
              passed,
              failed: result.guards.length - passed,
            };
          }
          result.uartBaud = uartBaudByProject.get(entry.project.id) ?? result.uartBaud ?? null;
          result.source ??= {};
          result.source.programDir ??= entry.project.programDir;
          result.source.mainSource ??= entry.project.mainSource;
          result.source.evidence ??= entry.project.sourceEvidence ?? [];
          result.source.hex ??= {};
          if (entry.uvprojIdentity != null && entry.uvprojPath != null) {
            result.source.uvproj = {
              path: relative(options.root, entry.uvprojPath),
              bytes: entry.uvprojIdentity.bytes,
              sha256: entry.uvprojIdentity.sha256,
              clockHz: entry.uvprojClock ?? null,
            };
          }
          result.source.sourceAggregateSha256 = entry.sourceIdentity.aggregateSha256;
          result.source.sourceFiles = entry.sourceIdentity.files;
          result.source.hex.filePath = relative(options.root, entry.hexPath);
          result.source.hex.fileBytes = entry.hexIdentity.bytes;
          result.source.hex.fileSha256 = entry.hexIdentity.sha256;
          applyOverrideStatus(entry.project, result);
          results.push(result);
          writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
          completed += 1;
          const metrics = result.metrics ?? {};
          const guardCounts = result.guardCounts ?? { passed: 0, total: 0 };
          console.log(
            `[${completed}/${total}] ${id} ${result.status} sim=${Number(metrics.simTimeMs ?? 0).toFixed(0)}ms wall=${Number(metrics.wallMs ?? childWallMs).toFixed(0)}ms cpu=${Number(metrics.cpuMs ?? 0).toFixed(0)}ms checks=${result.assertions?.passed ?? 0}/${result.assertions?.total ?? 0} limited=${result.assertions?.limited ?? 0} guards=${guardCounts.passed}/${guardCounts.total}`,
          );
          if (result.status.endsWith('fail') || result.status === 'error') {
            const failures = (result.checks ?? []).filter((check) => !check.pass && !check.limited);
            for (const failure of failures)
              console.log(
                `    FAIL ${failure.id}: expected ${JSON.stringify(failure.expected)} actual ${JSON.stringify(failure.actual)}`,
              );
            if (result.error) console.log(`    ERROR ${result.error.message}`);
          }
        } catch (cause) {
          const result = makeErrorResult(
            entry,
            `orchestration error: ${cause instanceof Error ? cause.message : String(cause)}`,
            { stack: cause instanceof Error ? cause.stack : undefined },
          );
          results.push(result);
          writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
          completed += 1;
          console.log(`[${completed}/${total}] ${id} error: ${result.error.message}`);
        }
        void started;
      }
    },
  );
  await Promise.all(workers);

  results.sort((left, right) => {
    const categoryOrder = manifest.projects.map((project) => project.id);
    return categoryOrder.indexOf(left.id) - categoryOrder.indexOf(right.id);
  });

  const runFinishedAt = isoNow();
  const durationCpu = process.cpuUsage(runStartedCpu);
  const durationWallMs = performance.now() - runStartedPerformance;
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const executableResults = results.filter((result) => result.status !== 'not-applicable');
  const failures = results.filter(
    (result) => result.status.endsWith('fail') || result.status === 'error',
  );
  const blocked = results.filter((result) => result.status === 'blocked');
  const partial = results.filter((result) => result.status === 'behavior-partial');
  const notApplicable = results.filter((result) => result.status === 'not-applicable');
  const behaviorPassed = results.filter((result) => result.status === 'behavior-pass').length;
  const behaviorPartial = partial.length;
  const smokePassed = results.filter((result) => result.status === 'smoke-pass').length;
  const limitedChecks = results.reduce((sum, result) => sum + (result.assertions?.limited ?? 0), 0);
  const notCoveredChecks = results.reduce(
    (sum, result) => sum + (result.assertions?.notCovered ?? 0),
    0,
  );

  const summary = {
    schemaVersion: RESULT_SCHEMA,
    runId: basename(outputDirectory),
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    root: options.root,
    manifest: options.manifest,
    sourceManifest: sourceManifestPath,
    manifestSha256: sha256(manifestBytes),
    execution: options.execution,
    jobs: options.jobs,
    timeoutMs: options.timeoutMs,
    artifact: {
      model: relative(REPO_ROOT, join(PROJECT_ROOT, 'device', 'dist', 'model.js')),
      modelSha256: sha256(readFileSync(join(PROJECT_ROOT, 'device', 'dist', 'model.js'))),
      manifestSha256: sha256(readFileSync(join(PROJECT_ROOT, 'device', 'dist', 'package.json'))),
    },
    coverage: inventoryResult.coverage,
    counts,
    behaviorPassed,
    behaviorPartial,
    smokePassed,
    limitedChecks,
    notCoveredChecks,
    executable: executableResults.length,
    failed: failures.length,
    blocked: blocked.length,
    notApplicable: notApplicable.length,
    durationWallMs,
    durationCpuMs:
      (durationCpu.user + durationCpu.system) / 1000 +
      results.reduce((sum, result) => sum + (result.metrics?.cpuMs ?? 0), 0),
    emptyUvprojIds: results
      .filter((result) => result.source?.uvproj?.bytes === 0)
      .map((result) => result.id),
    failureIds: failures.map((result) => result.id),
    blockedIds: blocked.map((result) => result.id),
    partialIds: partial.map((result) => result.id),
    notApplicableIds: notApplicable.map((result) => result.id),
  };

  writeFileSync(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(outputDirectory, 'results.jsonl'),
    `${results.map((result) => JSON.stringify(result)).join('\n')}\n`,
  );
  writeFileSync(join(outputDirectory, 'report.md'), renderReport(summary, results));

  console.log('');
  console.log(
    `SUMMARY behavior-pass=${behaviorPassed} behavior-partial=${behaviorPartial} smoke-pass=${smokePassed} fail=${failures.length} blocked=${blocked.length} not-applicable=${notApplicable.length} limited-checks=${limitedChecks} not-covered=${notCoveredChecks} total=${results.length}`,
  );
  console.log(`REPORT ${outputDirectory}`);
  for (const failure of failures) {
    const reasons = (failure.checks ?? [])
      .filter((check) => !check.pass && !check.limited)
      .map((check) => `${check.id}: ${check.detail ?? 'mismatch'}`);
    console.log(
      `FAIL ${failure.id} ${failure.status} ${failure.error?.message ?? reasons.join(' | ')}`,
    );
  }
  for (const item of blocked) console.log(`BLOCKED ${item.id} ${item.blockedReason}`);
  for (const item of notApplicable) console.log(`N/A ${item.id} ${item.reason}`);

  if (failures.length > 0) return 1;
  if (blocked.length > 0) return 2;
  if (partial.length > 0) return 4;
  return 0;
}

function renderMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function renderReport(summary, results) {
  const lines = [];
  lines.push('# CT107D full-firmware suite report');
  lines.push('');
  lines.push(`- Run: \`${summary.runId}\``);
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Finished: ${summary.finishedAt}`);
  lines.push(`- Source root: \`${summary.root}\``);
  lines.push(`- Source manifest: \`${summary.sourceManifest}\``);
  lines.push(`- Manifest snapshot: \`${summary.manifest}\``);
  lines.push(`- Manifest SHA-256: \`${summary.manifestSha256}\``);
  lines.push(
    `- Execution: \`${summary.execution}\` (isolated child process per project; jobs=${summary.jobs})`,
  );
  lines.push(`- Artifact: \`${summary.artifact.model}\``);
  lines.push(`- Artifact model SHA-256: \`${summary.artifact.modelSha256}\``);
  lines.push(`- Artifact manifest SHA-256: \`${summary.artifact.manifestSha256}\``);
  lines.push(
    `- Wall/CPU: ${summary.durationWallMs.toFixed(0)} ms / ${summary.durationCpuMs.toFixed(0)} ms`,
  );
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`- Manifest projects: ${summary.coverage.projects}`);
  lines.push(`- Executable projects: ${summary.coverage.executableProjects}`);
  lines.push(
    `- Discovered HEX: ${summary.coverage.discoveredHex}; discovered uvproj: ${summary.coverage.discoveredUvproj}`,
  );
  lines.push(
    `- Claimed HEX: ${summary.coverage.claimedHex}; claimed uvproj: ${summary.coverage.claimedUvproj}`,
  );
  lines.push(
    `- Unclaimed HEX: ${summary.coverage.unclaimedHex.length}; unclaimed uvproj: ${summary.coverage.unclaimedUvproj.length}`,
  );
  lines.push(
    `- Empty (0-byte) uvproj: ${summary.emptyUvprojIds.length} (${summary.emptyUvprojIds.join(', ') || 'none'})`,
  );
  lines.push(`- Not applicable: ${summary.notApplicable} (${summary.notApplicableIds.join(', ')})`);
  lines.push('');
  lines.push('## Result counts');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('| --- | ---: |');
  for (const [status, count] of Object.entries(summary.counts).sort())
    lines.push(`| ${status} | ${count} |`);
  lines.push('');
  lines.push(
    `Behavior pass: **${summary.behaviorPassed}**; behavior partial: **${summary.behaviorPartial}**; smoke-only pass: **${summary.smokePassed}**; fail: **${summary.failed}**; blocked: **${summary.blocked}**.`,
  );
  lines.push(
    `Limited functional checks: ${summary.limitedChecks}; not-covered branches: ${summary.notCoveredChecks}.`,
  );
  lines.push('');
  lines.push(
    'Only `behavior-pass` is a success exit. `behavior-partial` means some functional behavior was proven and other branches are limited/notCovered; it is not a pass. Any executed non-limited functional mismatch is `behavior-fail`. "Limited" checks are stimuli the model cannot express (for example a missing P4 port), not silent passes; their actual values remain in the report.',
  );
  lines.push('');
  lines.push('## Partial results (tested pass + explicit limitations)');
  lines.push('');
  const partials = results.filter((result) => result.status === 'behavior-partial');
  if (partials.length === 0) lines.push('None.');
  for (const result of partials) {
    lines.push(
      `- **${result.id}** — limited/notCovered: ${result.scenario?.limitations?.join('; ') || 'none documented'}`,
    );
    if (result.notCovered?.length)
      lines.push(`  - notCovered: ${result.notCovered.map((entry) => `\`${entry}\``).join(', ')}`);
    for (const check of (result.checks ?? []).filter((item) => item.limited))
      lines.push(
        `  - limited \`${check.id}\`: expected \`${JSON.stringify(check.expected)}\`, actual \`${JSON.stringify(check.actual)}\``,
      );
  }
  lines.push('');
  lines.push('## Failures and blocked');
  lines.push('');
  if (summary.failureIds.length === 0 && summary.blockedIds.length === 0) lines.push('None.');
  for (const result of results.filter(
    (item) => item.status.endsWith('fail') || item.status === 'error' || item.status === 'blocked',
  )) {
    lines.push(`### ${result.id} — ${result.status}`);
    lines.push('');
    if (result.blockedReason) lines.push(`Blocked: ${result.blockedReason}`);
    if (result.error) lines.push(`Error: \`${result.error.message}\``);
    const failed = (result.checks ?? []).filter((check) => !check.pass);
    for (const check of failed.filter((item) => !item.limited))
      lines.push(
        `- \`${check.id}\` at ${check.atMs ?? '?'} ms: expected \`${JSON.stringify(check.expected)}\`, actual \`${JSON.stringify(check.actual)}\`${check.detail ? ` — ${check.detail}` : ''}`,
      );
    lines.push('');
  }
  lines.push('## Per-project results');
  lines.push('');
  lines.push(
    '| # | id | category | mode | status | clock Hz | HEX bytes | sim ms | wall ms | cpu ms | guards | checks |',
  );
  lines.push('| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  results.forEach((result, index) => {
    const metrics = result.metrics ?? {};
    const checks = result.assertions
      ? `${result.assertions.passed}/${result.assertions.total} (L${result.assertions.limited ?? 0}/N${result.assertions.notCovered ?? 0})`
      : result.status === 'not-applicable'
        ? '—'
        : '—';
    const guards = result.guardCounts
      ? `${result.guardCounts.passed}/${result.guardCounts.total}`
      : '—';
    lines.push(
      `| ${index + 1} | ${renderMarkdown(result.id)} | ${renderMarkdown(result.category)} | ${result.mode ?? '—'} | ${result.status} | ${result.clock?.frequencyHz ?? '—'} | ${result.source?.hex?.dataBytes ?? result.source?.hex?.bytes ?? '—'} | ${metrics.simTimeMs === undefined ? '—' : Number(metrics.simTimeMs).toFixed(0)} | ${metrics.wallMs === undefined ? '—' : Number(metrics.wallMs).toFixed(0)} | ${metrics.cpuMs === undefined ? '—' : Number(metrics.cpuMs).toFixed(0)} | ${guards} | ${checks} |`,
    );
  });
  lines.push('');
  for (const result of results) {
    lines.push(`### ${result.id}`);
    lines.push('');
    lines.push(`- Name: ${result.name}`);
    lines.push(`- Category: ${result.category}`);
    lines.push(`- Mode: \`${result.mode}\``);
    lines.push(`- Status: **${result.status}**`);
    if (result.status === 'not-applicable') {
      lines.push(`- Reason: ${result.reason}`);
      lines.push('');
      continue;
    }
    lines.push(`- Clock: ${result.clock?.frequencyHz} Hz (${result.clock?.evidence})`);
    if (result.uartBaud)
      lines.push(`- UART probe baud: ${result.uartBaud.value} (${result.uartBaud.source})`);
    lines.push(`- Program: \`${result.source.programDir}\``);
    if (result.source.evidence?.length)
      lines.push(
        `- Source evidence: ${result.source.evidence.map((entry) => `\`${entry}\``).join(', ')}`,
      );
    lines.push(
      `- HEX: \`${result.source.hex.path}\` (${result.source.hex.dataBytes} data bytes, image ${result.source.hex.imageSha256})`,
    );
    if (result.source.hex.fileSha256)
      lines.push(`- HEX source SHA-256: \`${result.source.hex.fileSha256}\``);
    if (result.source.sourceAggregateSha256)
      lines.push(`- Source aggregate SHA-256: \`${result.source.sourceAggregateSha256}\``);
    if (result.source.uvproj)
      lines.push(
        `- uvproj: \`${result.source.uvproj.path}\` (${result.source.uvproj.bytes} bytes, CLOCK=${result.source.uvproj.clockHz ?? 'n/a'})`,
      );
    if (result.scenario?.notes?.length)
      lines.push(`- Scenario notes: ${result.scenario.notes.join('; ')}`);
    if (result.scenario?.limitations?.length) {
      lines.push(`- Limitations: ${result.scenario.limitations.join('; ')}`);
    }
    const metrics = result.metrics;
    if (metrics) {
      lines.push(
        `- Metrics: sim ${Number(metrics.simTimeMs).toFixed(3)} ms; wall ${Number(metrics.wallMs).toFixed(0)} ms; CPU ${Number(metrics.cpuMs).toFixed(0)} ms; import ${Number(metrics.importMs).toFixed(0)} ms; assembly ${Number(metrics.assemblyMs).toFixed(0)} ms; run ${Number(metrics.runMs).toFixed(0)} ms`,
      );
      if (metrics.workload)
        lines.push(
          `- Workload: JITs ${metrics.workload.jits}; direct compiles ${metrics.workload.directCompiles}; direct calls ${metrics.workload.directCalls}; fallbacks ${metrics.workload.directFallbacks}; direct programs ${metrics.workload.directPrograms}; cached ${metrics.workload.cachedInstructions}; polling ${metrics.workload.pollingInstructions}`,
        );
      if (metrics.observations)
        lines.push(
          `- Observations: topics ${metrics.observations.topicMessages}; signals ${metrics.observations.signalEvents}; bytes ${metrics.observations.bytesEvents}; UART TX/RX ${metrics.observations.uart1TxBytes}/${metrics.observations.uart1RxBytes}; probe TX/RX ${metrics.observations.probeTxBytes}/${metrics.observations.probeRxBytes}; display updates DS1/DS2 ${metrics.observations.displayUpdates.DS1}/${metrics.observations.displayUpdates.DS2}`,
        );
    }
    if (result.observations?.displayText)
      lines.push(
        `- Final display: DS1=\`${result.observations.displayText.DS1}\` DS2=\`${result.observations.displayText.DS2}\`; latches=\`${JSON.stringify(result.observations.latches)}\``,
      );
    if (result.observations?.temperature)
      lines.push(`- Temperature: \`${JSON.stringify(result.observations.temperature)}\``);
    if (result.observations?.pcf8591)
      lines.push(`- PCF8591: \`${JSON.stringify(result.observations.pcf8591)}\``);
    if (result.observations?.rtc)
      lines.push(`- RTC: \`${JSON.stringify(result.observations.rtc)}\``);
    if (result.observations?.uart) {
      const uart = result.observations.uart;
      const parts = [
        ['uart1Tx', uart.uart1TxText],
        ['uart1Rx', uart.uart1RxText],
        ['probeTx', uart.probeTxText],
        ['probeRx', uart.probeRxText],
      ].filter(([, text]) => text.length > 0);
      for (const [name, text] of parts)
        lines.push(
          `- UART ${name}: ${JSON.stringify(text)} (hex \`${Buffer.from(text, 'utf8').toString('hex')}\`)`,
        );
    }
    if (result.scenario?.events?.length) {
      lines.push('- Scenario events:');
      for (const event of result.scenario.events)
        lines.push(
          `  - ${event.atMs} ms: ${event.action} ${JSON.stringify({ ...event, atMs: undefined, action: undefined })}`,
        );
    } else lines.push('- Scenario events: none');
    lines.push(
      `- Guards: ${result.guardCounts?.passed ?? 0}/${result.guardCounts?.total ?? 0}; assertions: ${result.assertions?.passed ?? 0}/${result.assertions?.total ?? 0} passed, ${result.assertions?.failed ?? 0} failed, ${result.assertions?.limited ?? 0} limited, ${result.assertions?.notCovered ?? 0} notCovered`,
    );
    if (result.checks?.length) {
      lines.push('');
      lines.push('| check | at ms | pass | kind | expected | actual | detail |');
      lines.push('| --- | ---: | --- | --- | --- | --- | --- |');
      for (const check of result.checks)
        lines.push(
          `| ${renderMarkdown(check.id)} | ${check.atMs ?? '—'} | ${check.pass ? 'yes' : 'NO'} | ${check.limited ? 'limited' : 'required'} | \`${renderMarkdown(JSON.stringify(check.expected))}\` | \`${renderMarkdown(JSON.stringify(check.actual))}\` | ${check.detail ? renderMarkdown(check.detail) : ''} |`,
        );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function childMain(options) {
  const manifest = readManifest(options.manifest);
  const project = manifest.projects.find((candidate) => candidate.id === options.child);
  if (project === undefined) throw new Error(`unknown project id: ${options.child}`);
  const result = await runProject(options, manifest, options.child);
  writeFileSync(options.result, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'behavior-pass' || result.status === 'smoke-pass') return 0;
  if (result.status === 'behavior-partial') return 4;
  return 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    return 3;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    if (options.child !== undefined) return await childMain(options);
    return await runAll(options);
  } catch (cause) {
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    return 3;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const exitCode = await main();
  process.exitCode = exitCode;
}

export {
  applyOverrideStatus,
  compareValue,
  decodeBcd,
  displayText,
  evaluateAssertion,
  hasComparator,
  preflightUartBaud,
  readArtifactProperties,
  readManifest,
  readUartBaudProperty,
  renderReport,
  resolveUartBaud,
  validateAssertion,
};
