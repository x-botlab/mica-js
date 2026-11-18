#!/usr/bin/env node
/**
 * Generate the fused CT107D device DDL from the existing unified device models.
 *
 * The fused device keeps the 8051 JIT and source-merges every digital board model:
 * symbols are namespaced per instance and pin accesses are rewritten to internal nets.
 * Analog/display/interactive devices are implemented by the hand-written board fragment.
 *
 * The output is checked in (`src/model.ddl`) so reviews can inspect the generated
 * wiring. Run with `--check` to verify it is current.
 *
 * Historical schematic and netlist inputs live under `legacy/source/`; the v2 board
 * document is not an input of this generator.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDDL } from '@mica-js/sdk/ddl';
import { MCU_ARTIFACT, mcuArtifactHash, mcuSourceHash, readMcuStamp } from './mcu-source.mjs';
import { driveCode } from '../shared/drive-code.mjs';
import {
  ACTUATOR_DIRTY_STATE,
  BUTTON_DIRTY_STATE,
  DIRTY_GROUP_MEMORY,
  LED_DIRTY_STATE,
  PIN_DIRTY_MEMORY,
  dirtyGroup,
  dirtyGroupCount,
  driveMemoryName,
  pinMemoryName,
} from '../shared/dirty-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const CT107D = join(PROJECT, '..');
const REPO = join(CT107D, '..', '..');
const DEVICES = join(CT107D, '..', 'devices');
const LEGACY_SOURCE = join(CT107D, 'legacy', 'source');
const OUTPUT = join(PROJECT, 'src', 'model.ddl');
const NETS_OUTPUT = join(PROJECT, 'src', 'nets.ts');
const CHANNELS_OUTPUT = join(PROJECT, 'src', 'channels.ts');
const BOARD_FRAGMENT = join(HERE, 'board-fragment.ddl');
const BOARD_TEMPLATE = readFileSync(BOARD_FRAGMENT, 'utf8');

/**
 * Digital device instances included by source merge. Analog, display, actuator and
 * interactive devices are intentionally absent; the board fragment owns their behavior.
 */
const DIGITAL = [
  'U1',
  'U4',
  'U5',
  'U6',
  'U7',
  'U8',
  'U9',
  'U10',
  'U11',
  'U14',
  'U15',
  'U16',
  'U18',
  'U19',
  'U20',
  'U21',
  'U22',
  'U24',
  'U25',
  'UART_PROBE',
  'LD1',
];

/** Instances implemented directly by the board fragment (not source-merged). */
const BOARD_LEVEL = new Set([
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'D8',
  'DS1',
  'DS2',
  'K1',
  'SP1',
  'S1',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
  'J13',
  'J5',
  'J2',
  'J3',
  'U26',
]);

/**
 * 窄候选：只把 U7/U8（74HC573）的八路 Q 输出压成一个打包 drive state。
 * -1 表示全部释放，0..255 是 publishAll 捕获的 stored 字节。其余 573（U6/U9）
 * 保持逐脚 state/driver，避免扩大改动面。生成时会校验器件、初始 release 与
 * helper 结构，并断言打包 state 不进入 MCU mirror 或显式 dirty observable。
 */
const PACKED_LATCHES = new Set(['U7', 'U8']);
const LATCH_OUTPUTS = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];

/** Matrix keys in board order; index 0 is S1, then independent S4-S7, then S8-S19. */
const KEYS = [
  'S1',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
];

const schematic = JSON.parse(readFileSync(join(LEGACY_SOURCE, 'ct107d.sch'), 'utf8'));
const netlist = JSON.parse(readFileSync(join(LEGACY_SOURCE, 'ct107d.netlist.json'), 'utf8'));

const symbols = schematic.sheet.symbols.filter((symbol) => symbol.designator);
const symbolByDesignator = new Map(symbols.map((symbol) => [symbol.designator, symbol]));
const deviceOf = (designator) => symbolByDesignator.get(designator).device.replace(/^xbotlab:/, '');

{
  const covered = [...DIGITAL, ...BOARD_LEVEL];
  const duplicates = covered.filter((designator, index) => covered.indexOf(designator) !== index);
  const unknown = covered.filter((designator) => !symbolByDesignator.has(designator));
  const missing = symbols
    .map((symbol) => symbol.designator)
    .filter((designator) => !covered.includes(designator));
  // 54 个历史实例 + J5（独立/矩阵选择器）；两侧覆盖表必须与此计数一致。
  if (symbols.length !== 55 || duplicates.length || unknown.length || missing.length)
    throw new Error(
      `Schema coverage mismatch: instances=${symbols.length}, ` +
        `duplicates=[${duplicates}], unknown=[${unknown}], missing=[${missing}]`,
    );
}
const propsOf = (designator) => symbolByDesignator.get(designator).properties ?? {};

const netNames = Object.keys(netlist);
const netIndex = new Map(netNames.map((name, index) => [name, index]));
const netSlotName = (name) => name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
const netSlotIndex = new Map(netNames.map((name, index) => [`NET_${netSlotName(name)}`, index]));
const indexOfNet = (name) => {
  const index = netIndex.get(name);
  if (index === undefined) throw new Error(`Unknown net ${name}`);
  return index;
};

/** designator.pin -> net index, including only pins that appear in the netlist. */
const pinNet = new Map();
for (const [name, members] of Object.entries(netlist))
  for (const member of members) {
    const separator = member.lastIndexOf('.');
    pinNet.set(`${member.slice(0, separator)}.${member.slice(separator + 1)}`, netIndex.get(name));
  }

/**
 * Explicitly unconnected pins. They still get isolated internal nets (unknown when read),
 * but a new NC pin must be added here instead of silently disappearing from the netlist.
 */
const KNOWN_NC = new Set([
  'U11.c1',
  'U11.c2',
  'U11.c3',
  'U11.f0',
  'U11.in',
  'U14.bypass',
  'U14.gain1',
  'U14.gain8',
  'U15.ctrl',
  'U15.disch',
  'U15.thres',
  'U15.trig',
  'U16.osc',
  'U19.x1',
  'U19.x2',
  'U24.y0',
  'U24.y1',
  'U24.y2',
  'U24.y3',
]);

const dummyPinNet = new Map();
let dummyNet = netNames.length;
const netForPin = (designator, pin) => {
  const found = pinNet.get(`${designator}.${pin}`);
  if (found !== undefined) return found;
  const designatorPin = `${designator}.${pin}`;
  if (pin === 'vcc' || pin === 'vcc1') return indexOfNet('VCC');
  if (pin === 'gnd') return indexOfNet('GND');
  if (!KNOWN_NC.has(designatorPin))
    throw new Error(`${designatorPin}: unconnected pin is not in the explicit NC allowlist`);
  if (!dummyPinNet.has(designatorPin)) dummyPinNet.set(designatorPin, dummyNet++);
  return dummyPinNet.get(designatorPin);
};

const identifier = (text) => text.toLowerCase().replace(/[^a-z0-9_]/g, '_');
const manifestOf = (device) =>
  JSON.parse(readFileSync(join(DEVICES, device, 'package.json'), 'utf8'));
const literal = (value) => {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  throw new TypeError(`Unsupported default ${String(value)}`);
};

/** Instance properties: schematic overrides, then manifest defaults. */
function propertiesOf(designator) {
  const device = deviceOf(designator);
  const manifest = manifestOf(device);
  const props = {};
  for (const [name, property] of Object.entries(manifest.properties ?? {}))
    props[name] = property.default;
  for (const [name, value] of Object.entries(propsOf(designator))) props[name] = value;
  return props;
}

/** Extract the member body between the device declaration's outer braces. */
function bodyOf(source, device) {
  const declaration = /\bdevice\s+\w+/.exec(source);
  if (declaration === null) throw new Error(`${device}: device declaration not found`);
  const start = source.indexOf('{', declaration.index);
  if (start < 0) throw new Error(`${device}: device body not found`);
  return source.slice(start + 1, source.lastIndexOf('}'));
}

/** Remove pin declarations, including multi-line default intent arrays. */
function stripPinDeclarations(body) {
  const output = [];
  let skipping = false;
  for (const line of body.split('\n')) {
    if (!skipping && /^\s*pin\s+\w+/.test(line)) {
      skipping = true;
      if (line.includes(';')) skipping = false;
      continue;
    }
    if (skipping) {
      if (line.includes(';')) skipping = false;
      continue;
    }
    output.push(line);
  }
  if (skipping) throw new Error('Unterminated pin declaration');
  return output.join('\n');
}

const modelCache = new Map();
async function modelOf(device) {
  let model = modelCache.get(device);
  if (model === undefined) {
    model = await compileDDL(readFileSync(join(DEVICES, device, 'src', 'model.ddl'), 'utf8'), {
      uri: `mica:devices/${device}/model.ddl`,
    });
    modelCache.set(device, model);
  }
  return model;
}

/** Replace one pin's sample and intent accesses with fused net accesses. */
function rewritePin(source, designator, prefix, pin, power) {
  let result = source;
  const net = netForPin(designator, pin);
  const level = power === 'vcc' ? 'Logic.high' : power === 'gnd' ? 'Logic.low' : `fusedWire${net}`;
  const voltage = power === 'vcc' ? '5' : power === 'gnd' ? '0' : `fusedVoltage${net}`;
  result = result.replaceAll(`${pin}.sample.level`, level);
  result = result.replaceAll(`${pin}.sample.voltage`, voltage);
  const setter = `${prefix}_${pin}_setDrive`;
  const replaceIntent = (target) => {
    if (target === 'empty') {
      const pattern = new RegExp(`\\b${pin}\\.intent\\s*<-\\s*\\[\\s*\\]\\s*;`, 'g');
      result = result.replace(pattern, `${setter}(4);`);

      return;
    }
    const pattern = new RegExp(
      `\\b${pin}\\.intent\\s*<-\\s*\\[\\s*resistor\\s*\\(\\s*to\\s*:\\s*${target}\\s*,\\s*resistance\\s*:\\s*([0-9_]+(?:\\.[0-9_]+)?)\\s*\\)\\s*\\]\\s*;`,
      'g',
    );
    result = result.replace(pattern, (_match, resistanceText) => {
      const resistance = Number(String(resistanceText).replaceAll('_', ''));

      return `${setter}(${driveCode(resistance, target, `${designator}.${pin}`)});`;
    });
  };
  replaceIntent('empty');
  replaceIntent('vcc');
  replaceIntent('gnd');
  if (new RegExp(`\\b${pin}\\.intent\\s*<-`).test(result))
    throw new Error(`${designator}.${pin}: unsupported pin intent form`);
  return { source: result, net };
}

/** Degrade a pin's creation-time passive intent to an explicit drive code. */
function initialDriveCode(pin, designator) {
  const initial = pin.initial;
  if (initial === undefined) return undefined;
  const operations = initial.body.operations;
  const unsupported = operations.find((operation) =>
    ['select', 'if', 'match', 'call', 'callValue', 'wait', 'elapse'].includes(operation.kind),
  );
  if (unsupported !== undefined)
    throw new Error(`${designator}.${pin.name}: unsupported pin initial ${unsupported.kind}`);
  const resistors = operations.filter((operation) => operation.kind === 'resistor');
  const combines = operations.filter((operation) => operation.kind === 'combineIntents');
  if (resistors.length === 0) return 4;
  if (resistors.length !== 1)
    throw new Error(`${designator}.${pin.name}: multiple initial resistors are unsupported`);
  if (combines.some((operation) => operation.values.length > 1))
    throw new Error(`${designator}.${pin.name}: parallel initial intents are unsupported`);
  const resistor = resistors[0];
  if (resistor.to.kind !== 'pin')
    throw new Error(`${designator}.${pin.name}: initial resistor must target a rail`);
  const resistance = operations.find(
    (operation) => operation.kind === 'constant' && operation.result === resistor.resistance,
  );
  if (resistance === undefined || resistance.constant.kind !== 'number')
    throw new Error(`${designator}.${pin.name}: initial resistance must be a constant`);
  return driveCode(resistance.constant.value, resistor.to.name, `${designator}.${pin.name}`);
}

const DDL_KEYWORDS = new Set([
  'device',
  'enum',
  'record',
  'const',
  'state',
  'derived',
  'pin',
  'public',
  'memory',
  'input',
  'output',
  'channel',
  'notification',
  'pure',
  'fn',
  'process',
  'reaction',
  'assert',
  'if',
  'else',
  'match',
  'while',
  'loop',
  'break',
  'continue',
  'return',
  'await',
  'ticks',
  'duration',
  'delay',
  'redirect',
  'as',
  'on',
  'capture',
  'start',
  'intent',
  'sample',
  'receive',
  'true',
  'false',
  'none',
]);
const DECLARATION_KEYWORDS = new Set([
  'device',
  'enum',
  'record',
  'const',
  'state',
  'derived',
  'pin',
  'public',
  'memory',
  'input',
  'output',
  'channel',
  'notification',
  'pure',
  'fn',
  'process',
  'reaction',
  'assert',
]);

/** Lexically rename top-level identifiers without touching comments, strings,
 * member/field names or enum members. Locals with the same spelling are renamed
 * consistently, which preserves shadowing. */
function renameTopLevel(source, names, prefix, designator) {
  let output = '';
  let index = 0;
  let previous = '';
  let pendingDeclaration = undefined;
  let awaitingBrace = undefined;
  const contexts = [];
  const skip = (from) => {
    let at = from;
    while (at < source.length && /\s/.test(source[at])) at += 1;
    return at;
  };
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      output += character;
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error(`${designator}: unterminated block comment`);
      output += source.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (character === '"') {
      let at = index + 1;
      while (at < source.length) {
        if (source[at] === '\\') {
          at += 2;
          continue;
        }
        if (source[at] === '"') {
          at += 1;
          break;
        }
        at += 1;
      }
      output += source.slice(index, at);
      index = at;
      previous = 'string';
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      const word = source.slice(index, end);
      const insideMember = contexts.at(-1) === 'enum' || contexts.at(-1) === 'record';
      const afterDot = previous === '.';
      const keywordChannel =
        (word === 'channel' || word === 'notification') &&
        (previous === 'input' || previous === 'output');
      const lookahead = skip(end);
      const namedField =
        source[lookahead] === ':' &&
        previous !== '?' &&
        !DECLARATION_KEYWORDS.has(previous) &&
        !insideMember;
      let replacement = word;
      if (
        names.has(word) &&
        !afterDot &&
        !insideMember &&
        !keywordChannel &&
        !namedField &&
        !(DDL_KEYWORDS.has(word) && word !== 'channel' && word !== 'notification')
      )
        replacement = `${prefix}_${word}`;
      output += replacement;
      if (pendingDeclaration !== undefined) {
        awaitingBrace = pendingDeclaration;
        pendingDeclaration = undefined;
      } else if (word === 'enum' || word === 'record') {
        pendingDeclaration = word;
      }
      previous = word;
      index = end;
      continue;
    }
    if (character === '{') {
      contexts.push(awaitingBrace ?? 'other');
      awaitingBrace = undefined;
      previous = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === '}') {
      contexts.pop();
      previous = character;
      output += character;
      index += 1;
      continue;
    }
    output += character;
    previous = character;
    index += 1;
  }
  return output;
}

/**
 * Source-merged 74HC573 `driveBit`/`publishAll` pair that the packed variant replaces.
 * Only these two helpers change; `start`, `follow`, `latchEdge`, `enableChanged` and the
 * `latch.send` calls stay verbatim. Any change to the per-pin branch rules must fail
 * closed so a new chip behavior is never silently packed.
 */
function unpackedLatchHelpers(prefix) {
  const pinBranch = (level) =>
    LATCH_OUTPUTS.map((pin, bit) =>
      bit === LATCH_OUTPUTS.length - 1
        ? `        _ => { ${prefix}_${pin}_setDrive(${level}); }`
        : `        ${bit} => { ${prefix}_${pin}_setDrive(${level}); }`,
    );
  return [
    `  fn ${prefix}_driveBit(index: number, level: number) {`,
    `    if !${prefix}_outputsEnabled {`,
    '      match index {',
    ...pinBranch(4),
    '      }',
    '    } else if level == 1 {',
    '      match index {',
    ...pinBranch(1),
    '      }',
    '    } else {',
    '      match index {',
    ...pinBranch(0),
    '      }',
    '    }',
    '  }',
    '',
    `  fn ${prefix}_publishAll() {`,
    ...LATCH_OUTPUTS.map(
      (pin, bit) => `    ${prefix}_driveBit(${bit}, (${prefix}_stored >> ${bit}) & 1);`,
    ),
    '  }',
  ].join('\n');
}

/** Replace the per-pin 573 helpers with one packed, release-initialised drive state. */
function packLatchOutput(body, designator, prefix) {
  const expected = unpackedLatchHelpers(prefix);
  if (!body.includes(expected))
    throw new Error(
      `${designator}: 74hc573 driveBit/publishAll layout changed; refusing packed drive state`,
    );
  const replacement =
    `  fn ${prefix}_publishAll() {\n` +
    `    if ${prefix}_outputsEnabled {\n` +
    `      ${prefix}_drive_setDrive(${prefix}_stored);\n` +
    `    } else {\n` +
    `      ${prefix}_drive_setDrive(-1);\n` +
    `    }\n` +
    `  }`;
  const packed = body.replace(expected, replacement);
  if (new RegExp(`\\b${prefix}_driveBit\\b`).test(packed))
    throw new Error(`${designator}: driveBit helper survived the packed drive replacement`);
  if (new RegExp(`\\b${prefix}_q[0-7]_setDrive\\b`).test(packed))
    throw new Error(`${designator}: per-pin Q setter survived the packed drive replacement`);
  return packed;
}

/** Source-merge one digital instance. */
async function fuseInstance(designator) {
  const device = deviceOf(designator);
  const prefix = identifier(designator);
  const model = await modelOf(device);
  const source = readFileSync(join(DEVICES, device, 'src', 'model.ddl'), 'utf8');
  let body = stripPinDeclarations(bodyOf(source, device));
  const pins = model.declarations.filter((declaration) => declaration.kind === 'pin');
  const properties = propertiesOf(designator);
  const packedLatch = PACKED_LATCHES.has(designator);
  if (packedLatch && device !== '74hc573')
    throw new Error(`${designator}: packed latch drive requires 74hc573 (got ${device})`);

  // Replace property references with this instance's board values (or a board-level
  // property such as ultrasonicDistanceCm / uartBaud). Other probe/counter defaults
  // stay fixed because they are assembly properties in the schematic.
  for (const declaration of model.declarations)
    if (declaration.kind === 'property' && declaration.name !== 'clockFrequency') {
      if (!(declaration.name in properties))
        throw new Error(`${designator}: missing property ${declaration.name}`);
      const replacement =
        designator === 'U22' && declaration.name === 'distanceCm'
          ? 'ultrasonicDistanceCm'
          : designator === 'UART_PROBE' && declaration.name === 'baud'
            ? 'uartBaud'
            : literal(properties[declaration.name]);
      body = body.replace(new RegExp(`\\b${declaration.name}\\b`, 'g'), replacement);
    }

  const driveStates = [];
  const setters = [];
  const pinNets = new Map();
  const resetDrives = new Map();
  const packedDrives = new Map();
  const packedPins = [];
  for (const pin of pins) {
    const power =
      pin.name === 'vcc' || pin.name === 'vcc1' ? 'vcc' : pin.name === 'gnd' ? 'gnd' : undefined;
    const hasIntent = new RegExp(`\\b${pin.name}\\.intent\\s*<-`).test(body);
    // U1 is the MCU itself. Its reset pin intents are materialised once in the board
    // start (per-pin `fusedDriveN` resources), not by a second source-merged
    // `u1_Px_y_drive` state. A
    // duplicate weak-high driver would mask open-drain release and input-only modes.
    // Read the actual initial intents from the MCU DDL so the fused reset cannot drift
    // from the standalone package; the current contract is 10 kΩ weak-high (code 2).
    if (designator === 'U1' && /^P\d_[0-7]$/.test(pin.name)) {
      if (pin.initial === undefined)
        throw new Error(`${designator}.${pin.name}: missing reset initial intent`);
      const code = initialDriveCode(pin, designator);

      if (code !== 2)
        throw new Error(
          `${designator}.${pin.name}: reset initial intent must be weak-high code 2 (got ${code})`,
        );
      resetDrives.set(pin.name, code);
    }
    const initial =
      designator !== 'U1' && power === undefined ? initialDriveCode(pin, designator) : undefined;
    const rewritten = rewritePin(body, designator, prefix, pin.name, power);
    body = rewritten.source;
    pinNets.set(pin.name, rewritten.net);
    if (packedLatch && LATCH_OUTPUTS.includes(pin.name)) {
      const release = initial ?? 4;
      if (release !== 4)
        throw new Error(
          `${designator}.${pin.name}: packed 74hc573 output must start released (4), got ${release}`,
        );
      packedPins.push(pin.name);
      continue;
    }
    if (!hasIntent && initial === undefined) continue;
    if (power !== undefined)
      throw new Error(`${designator}.${pin.name}: power pin intent is not supported`);
    const stateName = `${prefix}_${pin.name}_drive`;
    driveStates.push(`  state ${stateName}: number = ${initial ?? 4};`);
    // The body is rendered after net dependency analysis, which decides which MCU
    // pin mirrors this drive can reach. Keeping the metadata here avoids a second
    // pass over the source-merged device bodies.
    setters.push({ prefix, pin: pin.name, state: stateName });
  }

  if (packedLatch) {
    if (packedPins.length !== LATCH_OUTPUTS.length)
      throw new Error(
        `${designator}: packed 74hc573 must expose ${LATCH_OUTPUTS.join(', ')} ` +
          `(got [${packedPins.join(', ')}])`,
      );
    for (let bit = 0; bit < LATCH_OUTPUTS.length; bit += 1) {
      const pin = LATCH_OUTPUTS[bit];
      if (!packedPins.includes(pin))
        throw new Error(`${designator}: packed 74hc573 is missing ${pin}`);
      packedDrives.set(pin, { state: `${prefix}_drive`, bit });
    }
    // -1 is the release sentinel: every Q driver unpacks it to drive code 4 until
    // publishAll captures the stored byte or re-releases the outputs.
    driveStates.push(`  state ${prefix}_drive: number = -1;`);
    setters.push({ prefix, pin: 'drive', state: `${prefix}_drive` });
  }

  // Rename every top-level declaration except the special `start` process.
  const rename = new Set(
    model.declarations
      .filter(
        (declaration) =>
          declaration.name !== undefined &&
          !['property', 'pin', 'assert'].includes(declaration.kind),
      )
      .map((declaration) => declaration.name),
  );
  for (const match of body.matchAll(/^\s*(?:process|reaction)\s+(\w+)/gm))
    if (match[1] !== 'start') rename.add(match[1]);
  if (designator !== 'U1') body = renameTopLevel(body, rename, prefix, designator);

  // Turn the single special start process into an on-process triggered by the fused start.
  const hasStart = /^\s*process\s+start\s*\{/m.test(body);
  if (hasStart) {
    body = body.replace(
      /^(\s*)process\s+start\s*\{/m,
      `$1process ${prefix}_start on ${prefix}_started {`,
    );
    driveStates.push(`  state ${prefix}_started: bool = false;`);
  }

  if (packedLatch) body = packLatchOutput(body, designator, prefix);

  if (/\.intent\s*<-/.test(body)) throw new Error(`${designator}: unhandled intent access`);
  if (/\.sample\.(?:level|voltage)/.test(body))
    throw new Error(`${designator}: unhandled sample access`);

  return {
    designator,
    device,
    prefix,
    body,
    pins: pins.map((pin) => pin.name),
    pinNets,
    driveStates,
    setters,
    packedDrives,
    packedState: packedLatch ? `${prefix}_drive` : undefined,
    resetDrives,
    hasStart,
    outputs: model.declarations
      .filter((declaration) => declaration.kind === 'channel' && declaration.direction === 'output')
      .map((declaration) => ({
        name: declaration.name,
        bytes: declaration.type.kind === 'bytes',
      })),
  };
}

/** Key index for a push-button designator. */
function keyIndex(designator) {
  const index = KEYS.indexOf(designator);
  if (index < 0) throw new Error(`Unknown key ${designator}`);
  return index;
}

/**
 * Inputs read by one generated `fusedNetN()` body. The generator emits these bodies
 * itself, so a lexical scan is the single source of truth for dependency edges and
 * cannot drift from the wiring it describes.
 */
function collectNetInputs(body) {
  const inputs = new Set();
  for (const match of body.matchAll(/\bfusedNet(\d+)\(\)/g)) inputs.add(`net:${Number(match[1])}`);
  for (const match of body.matchAll(/load8\(\s*fusedDrive(\d+)\s*,\s*0\s*\)/g))
    inputs.add(`mcu:${Number(match[1])}`);
  for (const match of body.matchAll(/load8\(fusedButtonLow,\s*(\d+)\)/g))
    inputs.add(`button:${Number(match[1])}`);
  for (const state of JUMPER_STATES)
    if (new RegExp(`\\b${state}\\b`).test(body)) inputs.add(`jumper:${state}`);
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*_drive)\b/g))
    inputs.add(`state:${match[1]}`);
  return inputs;
}

const JUMPER_STATES = ['j13Closed', 'j3Closed', 'j2Vs1838', 'j5Closed', 'j2TxToLd1'];

/**
 * Every pin dirty mark also marks the summary byte of its 8-pin group, so the
 * refresh can skip a whole group without checking its bits.
 */
function dirtyMarkLines(drives, indent) {
  const groups = [...new Set(drives.map(dirtyGroup))];
  return [
    ...drives.map((drive) => `${indent}store8(${PIN_DIRTY_MEMORY}, ${drive}, 1);`),
    ...groups.map((group) => `${indent}store8(${DIRTY_GROUP_MEMORY}, ${group}, 1);`),
  ];
}

/**
 * Render one source-merged pin setter with the dirty marks for its reachable pins.
 *
 * `fusedSeq` exists only to run the MCU mirror refresh, which walks the pin/group dirty
 * flags, and the observable dirty flags checked by `fusedRefresh`. Derived board
 * observations (display scans) depend on the drive state itself and are recomputed by
 * the declaration dependency graph. When a drive reaches no MCU pin and no observable,
 * the state write is the whole effect, so bumping the sequence would only schedule a
 * no-op refresh.
 */
function renderDriveSetter(setter, drives, states) {
  const marks = dirtyMarkLines(drives, '      ');
  const flags = states.map((state) => `      ${state} = true;`);
  const needsRefresh = marks.length > 0 || flags.length > 0;
  return (
    `  fn ${setter.prefix}_${setter.pin}_setDrive(level: number) {\n` +
    `    if level != ${setter.state} {\n` +
    `      ${setter.state} = level;\n` +
    (marks.length > 0 ? `${marks.join('\n')}\n` : '') +
    (flags.length > 0 ? `${flags.join('\n')}\n` : '') +
    (needsRefresh ? `      fusedSeq = fusedSeq + 1;\n` : '') +
    `    }\n` +
    `  }`
  );
}

/** Net slots referenced by one board-fragment function body. */
function templateNetRefs(template, name) {
  const start = template.search(new RegExp(`^\\s*fn\\s+${name}\\s*\\(`, 'm'));
  if (start < 0) throw new Error(`Missing template function ${name}`);
  const open = template.indexOf('{', start);
  const close = template.indexOf('\n  }', open);
  if (open < 0 || close < 0) throw new Error(`Unterminated template function ${name}`);
  const refs = new Set();
  for (const match of template.slice(open, close).matchAll(/\{\{NET_([A-Z0-9_]+)\}\}/g)) {
    const index = netSlotIndex.get(`NET_${match[1]}`);
    if (index === undefined) throw new Error(`${name}: unknown net slot ${match[1]}`);
    refs.add(index);
  }
  if (refs.size === 0) throw new Error(`${name}: no net references`);
  return [...refs];
}

/** Expand direct net inputs through the generated cross-net dependency graph. */
function transitiveInputs(direct, inputsOfNet) {
  const inputs = new Set();
  for (const input of direct) {
    if (!input.startsWith('net:')) {
      inputs.add(input);
      continue;
    }
    for (const nested of inputsOfNet(Number(input.slice(4)))) inputs.add(nested);
  }
  return inputs;
}

/** Split the transitive inputs of one board observable by source kind. */
function observableSources(state, direct, inputsOfNet) {
  const inputs = transitiveInputs(direct, inputsOfNet);
  const values = (prefix) =>
    [
      ...new Set(
        [...inputs]
          .filter((input) => input.startsWith(prefix))
          .map((input) => input.slice(prefix.length)),
      ),
    ].sort();
  const drives = values('mcu:').map(Number);
  if (drives.some((drive) => !Number.isInteger(drive) || drive < 0))
    throw new Error(`${state}: invalid MCU drive dependency`);
  const buttons = values('button:')
    .map(Number)
    .sort((left, right) => left - right);
  if (buttons.some((bit) => !Number.isInteger(bit) || bit < 0 || bit > 7))
    throw new Error(`${state}: invalid button bit dependency`);
  const source = {
    state,
    drives: drives.sort((left, right) => left - right),
    states: values('state:'),
    jumpers: values('jumper:'),
    buttons,
  };
  if (
    source.drives.length === 0 &&
    source.states.length === 0 &&
    source.jumpers.length === 0 &&
    source.buttons.length === 0
  )
    throw new Error(`${state}: no source dependency found`);
  return source;
}

/** Compact `event.index` selector for the indices that can change one observable. */
function indexSelector(indices, total, variable) {
  if (indices.length === total) return 'true';
  const contiguous =
    indices.length > 2 && indices.every((value, offset) => value === indices[0] + offset);
  if (contiguous) return `${variable} >= ${indices[0]} && ${variable} <= ${indices.at(-1)}`;
  return indices.map((value) => `${variable} == ${value}`).join(' || ');
}

/** -1 releases the eight outputs; 0..255 unpacks the stored byte captured by publishAll. */
function packedDriveDriver(state, bit) {
  return `(${state} >= 0 ? ((${state} >> ${bit}) & 1) : 4)`;
}

function generateNets(instances, template) {
  const drivers = new Map();
  const add = (net, expression) => {
    const list = drivers.get(net) ?? [];
    list.push(expression);
    drivers.set(net, list);
  };

  // MCU pins are written through per-pin drive resources by the JIT fusion transform.
  const mcuPins = [];
  for (const port of [0, 1, 2, 3, 4])
    for (let bit = 0; bit < 8; bit += 1) {
      const pin = `P${port}_${bit}`;
      const drive = port * 8 + bit;
      const net = netForPin('U1', pin);
      mcuPins.push({ pin, net, drive });
      add(net, `load8(${driveMemoryName(drive)}, 0)`);
    }
  // Fail fast if one of the eight P4 pins is missing from the schematic netlist instead
  // of silently letting only P4.2/P4.4 work. Drives also index the per-pin memories.
  if (mcuPins.length !== 40 || mcuPins.filter((pin) => pin.pin.startsWith('P4_')).length !== 8)
    throw new Error(`MCU pin map must contain 40 pins incl. P4_0..P4_7 (got ${mcuPins.length})`);
  if (new Set(mcuPins.map((pin) => pin.drive)).size !== 40)
    throw new Error('MCU pin drives are not unique');

  // Packed 573 outputs unpack one stored byte per pin so `collectNetInputs` still sees
  // the single `*_drive` state as a static dependency. Other devices keep the per-pin
  // driver expression unchanged.
  for (const instance of instances)
    for (const pin of instance.pins) {
      if (!instance.pinNets.has(pin)) continue;
      const packed = instance.packedDrives.get(pin);
      if (packed !== undefined) {
        add(instance.pinNets.get(pin), packedDriveDriver(packed.state, packed.bit));
        continue;
      }
      if (instance.driveStates.some((line) => line.includes(`_${pin}_drive:`)))
        add(instance.pinNets.get(pin), `${instance.prefix}_${pin}_drive`);
    }

  // Derive the key matrix from netlist endpoints instead of trusting a hand-written
  // row order. S4-S19 are all row/column keys; J5 selects whether the first column is
  // grounded (independent) or follows P44 (4x4 matrix). J13 no longer grounds P42.
  const BUTTON_ROWS = ['P30/TXD', 'P31/RXD', 'P32', 'P33'];
  const BUTTON_COLS = ['KCOL0', 'P42', 'P35', 'P34'];
  const keyNet = (designator, pin) => {
    const net = pinNet.get(`${designator}.${pin}`);
    return net === undefined ? undefined : netNames[net];
  };
  const matrixKeys = [];
  for (const symbol of symbols) {
    const designator = symbol.designator;
    if (designator === undefined || designator === 'S1') continue;
    if (deviceOf(designator) !== 'push-button') continue;
    const a = keyNet(designator, 'a');
    const b = keyNet(designator, 'b');
    if (a === undefined || b === undefined)
      throw new Error(`${designator}: missing push-button net`);
    const nets = [a, b];
    const row = nets.find((net) => BUTTON_ROWS.includes(net));
    const col = nets.find((net) => BUTTON_COLS.includes(net));
    if (row === undefined || col === undefined)
      throw new Error(`${designator}: not a row/column key (${a}, ${b})`);
    matrixKeys.push({
      key: designator,
      row: BUTTON_ROWS.indexOf(row),
      col: BUTTON_COLS.indexOf(col),
    });
  }
  const expectedKeys = KEYS.filter((key) => key !== 'S1');
  if (matrixKeys.length !== expectedKeys.length)
    throw new Error('Button matrix does not cover every S4-S19 key');
  for (const key of expectedKeys)
    if (!matrixKeys.some((entry) => entry.key === key))
      throw new Error(`Button matrix is missing ${key}`);

  const directLow = (netName) => [
    ...(drivers.get(indexOfNet(netName)) ?? []).map((driver) => `${driver} == 0`),
  ];
  const rowLow = BUTTON_ROWS.map((row) => directLow(row));
  const colLow = BUTTON_COLS.map((col) => {
    if (col === 'KCOL0') return [`fusedNet${indexOfNet('KCOL0')}() == 0`];
    const lows = directLow(col);
    if (col === 'P34') lows.push('j3Closed && u15_out_drive == 0');
    return lows;
  });

  // Button closure is generated below, after net dependency analysis, because the
  // changed-bit diff has to know which MCU pins read `fusedButtonLow`.
  const functions = [];
  const netInputs = [];
  for (let net = 0; net < netNames.length; net += 1) {
    const name = netNames[net];
    let body;
    if (name === 'VCC') body = '    return 1;';
    else if (name === 'GND') body = '    return 0;';
    else if (name === 'N_A1' || name === 'N_A2') {
      // J2's lower row routes P1.0 to U18 or LD1; the unselected input floats.
      const selected = name === 'N_A1' ? '!j2TxToLd1' : 'j2TxToLd1';
      body = `    if ${selected} { return fusedNet${indexOfNet('P10')}(); }\n    return 2;`;
    } else {
      const lines = [];
      for (const driver of drivers.get(net) ?? []) {
        lines.push(`    if ${driver} == 0 { strongLow = true; }`);
        lines.push(`    else if ${driver} == 1 { strongHigh = true; }`);
        lines.push(`    else if ${driver} == 2 { weakHigh = true; }`);
        lines.push(`    else if ${driver} == 3 { weakLow = true; }`);
      }
      // Passive loads that pull a released open-collector output high.
      if (name === 'N_RELAY' || name === 'N_BUZZ') lines.push('    strongHigh = true;');
      // J3 connects the NE555 output (NET_SIG) to P3_4.
      if (name === 'P34') {
        lines.push('    if j3Closed {');
        lines.push(`      if fusedNet${indexOfNet('NET_SIG')}() == 0 { strongLow = true; }`);
        lines.push(`      else if fusedNet${indexOfNet('NET_SIG')}() == 1 { strongHigh = true; }`);
        lines.push('    }');
      }
      // J2 channel 2 selects the receiver that shares P1_1 with the ultrasonic echo.
      if (name === 'P11') {
        lines.push('    if j2Vs1838 {');
        lines.push('      if u20_out_drive == 0 { strongLow = true; }');
        lines.push('    } else {');
        lines.push('      if u11_out_drive == 0 { strongLow = true; }');
        lines.push('    }');
      }
      // J13 (CON3) selects the U25 WR net: 2-3 grounds it (default IO mode), 1-2
      // follows P42. P42 itself stays a free matrix column in both positions.
      if (name === 'WR') {
        lines.push('    if j13Closed { strongLow = true; }');
        lines.push('    else {');
        lines.push(`      if fusedNet${indexOfNet('P42')}() == 0 { strongLow = true; }`);
        lines.push(`      else if fusedNet${indexOfNet('P42')}() == 1 { strongHigh = true; }`);
        lines.push('    }');
      }
      // J5 (CON3) selects the S4-S7 common column: 2-3 grounds it (default independent),
      // 1-2 follows P44. Only the matrix position lets P44 be pulled down by a key.
      if (name === 'KCOL0') {
        lines.push('    if j5Closed { strongLow = true; }');
        lines.push('    else {');
        lines.push(`      if fusedNet${indexOfNet('P44/RD')}() == 0 { strongLow = true; }`);
        lines.push(`      else if fusedNet${indexOfNet('P44/RD')}() == 1 { strongHigh = true; }`);
        lines.push('    }');
      }
      if (name === 'P44/RD')
        lines.push('    if !j5Closed && load8(fusedButtonLow, 4) == 1 { strongLow = true; }');

      if (BUTTON_ROWS.includes(name)) {
        const row = BUTTON_ROWS.indexOf(name);
        lines.push(`    if load8(fusedButtonLow, ${row}) == 1 { strongLow = true; }`);
      } else if (BUTTON_COLS.includes(name)) {
        const col = BUTTON_COLS.indexOf(name);
        lines.push(`    if load8(fusedButtonLow, ${4 + col}) == 1 { strongLow = true; }`);
      }
      body = [
        '    let strongLow = false;',
        '    let strongHigh = false;',
        '    let weakHigh = false;',
        '    let weakLow = false;',
        ...lines,
        '    if strongLow { return 0; }',
        '    if strongHigh { return 1; }',
        '    if weakHigh { return 1; }',
        '    if weakLow { return 0; }',
        '    return 2;',
      ].join('\n');
    }
    functions.push(`  pure fn fusedNet${net}() -> number {\n${body}\n  }`);
    netInputs.push(collectNetInputs(body));
  }

  // Resolve the transitive inputs of every net, then invert them into the set of MCU
  // pin mirrors that a drive, button bit or jumper can change. This is a static
  // closure over the generated wiring: aliases such as N_A1->P10, P34->NET_SIG and
  // KCOL0->P44 are ordinary edges, so no hand-written impact table can drift.
  const inputCache = new Map();
  const inputsOfNet = (net, visiting = new Set()) => {
    const cached = inputCache.get(net);
    if (cached !== undefined) return cached;
    if (visiting.has(net)) throw new Error(`Cyclic fused net dependency at net ${net}`);
    visiting.add(net);
    const inputs = new Set(netInputs[net]);
    for (const input of [...inputs]) {
      if (!input.startsWith('net:')) continue;
      const dependency = Number(input.slice(4));
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= netNames.length)
        throw new Error(`Invalid fused net dependency ${input}`);
      for (const nested of inputsOfNet(dependency, visiting)) inputs.add(nested);
    }
    visiting.delete(net);
    inputCache.set(net, inputs);
    return inputs;
  };

  // Board observables are gated by the actual sources of the generated nets they read.
  // The LED/actuator roots come from the template's own `{{NET_*}}` references, while
  // the button closure roots are the same row/column expressions emitted into
  // `fusedComputeButtons` below. Expanding either through `inputsOfNet` covers aliases
  // and cross-net dependencies, so no second hand-written netlist can drift.
  const buttonDirect = new Set(
    [...rowLow.flat(), ...colLow.flat()].flatMap((body) => [...collectNetInputs(body)]),
  );
  // The closure fixpoint reads the current row and column bits for every existing key,
  // so those bits are sources even though the initial row/column drive expressions only
  // read MCU drives. Key events are gated by this bit set through the matrix below.
  for (const entry of matrixKeys) {
    buttonDirect.add(`button:${entry.row}`);
    buttonDirect.add(`button:${4 + entry.col}`);
  }
  const netRoots = (name) => new Set(templateNetRefs(template, name).map((net) => `net:${net}`));
  const observables = {
    button: observableSources(BUTTON_DIRTY_STATE, buttonDirect, inputsOfNet),
    led: observableSources(LED_DIRTY_STATE, netRoots('publishLeds'), inputsOfNet),
    actuator: observableSources(ACTUATOR_DIRTY_STATE, netRoots('publishActuators'), inputsOfNet),
  };

  // MCU pin writes raise only the observables whose net closure reads that drive.
  const mcuDirtyTriggers = {};
  for (const pin of mcuPins) {
    const states = Object.values(observables)
      .filter((observable) => observable.drives.includes(pin.drive))
      .map((observable) => observable.state);
    if (states.length > 0) mcuDirtyTriggers[pin.pin] = states;
  }

  // A board-internal drive setter raises every observable that consumes its state.
  const stateDirtyTriggers = new Map();
  for (const observable of Object.values(observables))
    for (const state of observable.states) {
      const states = stateDirtyTriggers.get(state) ?? [];
      states.push(observable.state);
      stateDirtyTriggers.set(state, states);
    }

  const impactByInput = new Map();
  const impactedPins = (input) => {
    const drives = impactByInput.get(input);
    return drives === undefined ? [] : [...drives].sort((left, right) => left - right);
  };
  for (const pin of mcuPins) {
    const inputs = inputsOfNet(pin.net);
    if (!inputs.has(`mcu:${pin.drive}`))
      throw new Error(`MCU pin ${pin.pin} net ${pin.net} does not read its own drive`);
    for (const input of inputs) {
      if (input.startsWith('net:')) continue;
      const drives = impactByInput.get(input) ?? new Set();
      drives.add(pin.drive);
      impactByInput.set(input, drives);
    }
  }
  const mcuImpact = Object.fromEntries(
    mcuPins.map((pin) => [pin.pin, impactedPins(`mcu:${pin.drive}`)]),
  );
  const stateMark = (state) => impactedPins(`state:${state}`);
  const buttonPins = Array.from({ length: 8 }, (_, bit) => impactedPins(`button:${bit}`));
  const jumperPins = JUMPER_STATES.map((state) => impactedPins(`jumper:${state}`));
  const buttonObservables = Object.values(observables).filter(
    (observable) => observable.state !== BUTTON_DIRTY_STATE && observable.buttons.length > 0,
  );
  const buttonConsumers =
    buttonPins.some((pins) => pins.length > 0) || buttonObservables.length > 0;
  const markFunctions = [];
  const markStores = (drives, indent) => dirtyMarkLines(drives, indent).join('\n');
  if (buttonPins.some((pins) => pins.length > 0)) {
    const lines = ['  fn fusedMarkButtonPins(changed: number) {'];
    for (let bit = 0; bit < 8; bit += 1) {
      const pins = buttonPins[bit];
      if (pins.length === 0) continue;
      lines.push(`    if (changed & ${1 << bit}) != 0 {`, markStores(pins, '      '), '    }');
    }
    lines.push('  }');
    markFunctions.push(lines.join('\n'));
  }
  if (jumperPins.some((pins) => pins.length > 0)) {
    const lines = ['  fn fusedMarkJumperPins(index: number) {'];
    jumperPins.forEach((pins, index) => {
      if (pins.length === 0) return;
      lines.push(`    if index == ${index} {`, markStores(pins, '      '), '    }');
    });
    lines.push('  }');
    markFunctions.push(lines.join('\n'));
  }

  // Jumper events raise the observables whose closure reads that jumper, while the pin
  // marks below are emitted per event index. A jumper only ever dirties the pins that
  // are reachable from its own state instead of the union of every jumper.
  const jumperMark = [];
  if (jumperPins.some((pins) => pins.length > 0))
    jumperMark.push('fusedMarkJumperPins(event.index);');
  for (const observable of Object.values(observables)) {
    const indices = observable.jumpers
      .map((state) => JUMPER_STATES.indexOf(state))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    if (indices.length === 0) continue;
    const condition = indexSelector(indices, JUMPER_STATES.length, 'event.index');
    jumperMark.push(
      condition === 'true'
        ? `${observable.state} = true;`
        : `if ${condition} { ${observable.state} = true; }`,
    );
  }

  // A key event only enters through the button closure. The matrix gates the event
  // index to the row/column bits that closure reads, and the closure diff below raises
  // other button-dependent observables only when their own bit flips.
  const switchMark = [];
  for (const observable of Object.values(observables)) {
    if (observable.state !== BUTTON_DIRTY_STATE || observable.buttons.length === 0) continue;
    const indices = [
      ...new Set(
        matrixKeys
          .filter(
            (entry) =>
              observable.buttons.includes(entry.row) || observable.buttons.includes(4 + entry.col),
          )
          .map((entry) => keyIndex(entry.key)),
      ),
    ].sort((left, right) => left - right);
    if (indices.length === 0) continue;
    const condition = indexSelector(indices, KEYS.length, 'event.index');
    switchMark.push(
      condition === 'true'
        ? `${observable.state} = true;`
        : `if ${condition} { ${observable.state} = true; }`,
    );
  }

  // The button closure reads the current drives and key states. Capturing the previous
  // low bits before recomputation lets one refresh raise only the row/column pins whose
  // own closure bit changed, whether the cause was an MCU drive, a device drive or a
  // key event. The matrix is recomputed to a fixpoint here, so the diff uses the final
  // bits, not an intermediate iteration.
  const buttonLines = ['  memory fusedButtonLow[8];', '  fn fusedComputeButtons() {'];
  if (buttonConsumers)
    buttonLines.push(
      ...Array.from(
        { length: 8 },
        (_, index) => `    const previousButtonLow${index} = load8(fusedButtonLow, ${index});`,
      ),
    );
  buttonLines.push(
    ...Array.from({ length: 8 }, (_, index) => `    store8(fusedButtonLow, ${index}, 0);`),
  );
  for (let row = 0; row < BUTTON_ROWS.length; row += 1) {
    const lows = rowLow[row];
    if (lows.length > 0)
      buttonLines.push(`    if (${lows.join(' || ')}) { store8(fusedButtonLow, ${row}, 1); }`);
  }
  for (let col = 0; col < BUTTON_COLS.length; col += 1) {
    const lows = colLow[col];
    if (lows.length > 0)
      buttonLines.push(`    if (${lows.join(' || ')}) { store8(fusedButtonLow, ${4 + col}, 1); }`);
  }
  buttonLines.push('    let iteration = 0;', '    while iteration < 8 {');
  // Only the keys that actually exist may merge a row and a column. Treating every
  // row/column pair as connected would ground the whole matrix whenever one column is
  // held low (J5 grounds the first column in independent mode).
  for (const entry of matrixKeys) {
    const connected = `load8(fusedButtonLow, ${entry.row}) == 1 || load8(fusedButtonLow, ${4 + entry.col}) == 1`;
    buttonLines.push(
      `      if load8(keyStates, ${keyIndex(entry.key)}) == 1 && (${connected}) {`,
      `        store8(fusedButtonLow, ${entry.row}, 1);`,
      `        store8(fusedButtonLow, ${4 + entry.col}, 1);`,
      '      }',
    );
  }
  buttonLines.push('      iteration = iteration + 1;', '    }');
  if (buttonConsumers) {
    buttonLines.push('    let buttonChanged = 0;');
    for (let index = 0; index < 8; index += 1)
      buttonLines.push(
        `    if previousButtonLow${index} != load8(fusedButtonLow, ${index}) { buttonChanged = buttonChanged | ${1 << index}; }`,
      );
    if (buttonPins.some((pins) => pins.length > 0))
      buttonLines.push('    if buttonChanged != 0 { fusedMarkButtonPins(buttonChanged); }');
    for (const observable of buttonObservables) {
      const mask = observable.buttons.reduce((value, bit) => value | (1 << bit), 0);
      buttonLines.push(`    if (buttonChanged & ${mask}) != 0 { ${observable.state} = true; }`);
    }
  }
  buttonLines.push('  }');
  const buttonFunction = buttonLines.join('\n');

  // Power-up still materialises every MCU pin once so the JIT sees the reset levels
  // before the first firmware instruction. Later fusedSeq refreshes clear the group
  // summary first and then visit the dirty bits inside it in ascending order. A group
  // with no mark at all is skipped without reading any of its pins.
  const groupCount = dirtyGroupCount(mcuPins.length);
  const refresh = Array.from({ length: groupCount }, (_, group) => {
    const pins = mcuPins.filter((pin) => dirtyGroup(pin.drive) === group);
    return [
      `    if load8(${DIRTY_GROUP_MEMORY}, ${group}) == 1 {`,
      `      store8(${DIRTY_GROUP_MEMORY}, ${group}, 0);`,
      ...pins.map((pin) =>
        [
          `      if load8(${PIN_DIRTY_MEMORY}, ${pin.drive}) == 1 {`,
          `        store8(${PIN_DIRTY_MEMORY}, ${pin.drive}, 0);`,
          `        const next${pin.drive} = fusedNet${pin.net}();`,
          `        if load8(${pinMemoryName(pin.drive)}, 0) != next${pin.drive} { store8(${pinMemoryName(pin.drive)}, 0, next${pin.drive}); }`,
          `      }`,
        ].join('\n'),
      ),
      `    }`,
    ].join('\n');
  }).join('\n');
  const initialRefresh = [
    ...mcuPins.map(
      (pin) =>
        `    const next${pin.drive} = fusedNet${pin.net}();\n` +
        `    if load8(${pinMemoryName(pin.drive)}, 0) != next${pin.drive} { store8(${pinMemoryName(pin.drive)}, 0, next${pin.drive}); }`,
    ),
    ...mcuPins.map((pin) => `    store8(${PIN_DIRTY_MEMORY}, ${pin.drive}, 0);`),
    ...Array.from(
      { length: groupCount },
      (_, group) => `    store8(${DIRTY_GROUP_MEMORY}, ${group}, 0);`,
    ),
  ].join('\n');
  return {
    functions,
    mcuPins,
    mcuImpact,
    mcuDirtyTriggers,
    groupCount,
    refresh,
    initialRefresh,
    buttonFunction,
    markFunctions: markFunctions.join('\n'),
    stateMark,
    stateDirtyTriggers,
    jumperMark: jumperMark.join('\n'),
    switchMark: switchMark.join('\n'),
  };
}

function boardReplacements(instances, nets) {
  const mcu = instances.find((instance) => instance.designator === 'U1');

  if (mcu === undefined) throw new Error('Missing source-merged MCU instance');

  // Packed latches are only read by display deriveds. They must stay outside the
  // explicit dirty protocol: no MCU pin mirror and no button/LED/actuator observable
  // may consume them, otherwise one state would silently lose the per-pin marks.
  for (const instance of instances) {
    if (instance.packedState === undefined) continue;
    const mirrors = nets.stateMark(instance.packedState);
    if (mirrors.length > 0)
      throw new Error(
        `${instance.designator}: packed state ${instance.packedState} ` +
          `reaches MCU mirrors [${mirrors.join(', ')}]`,
      );
    const observables = nets.stateDirtyTriggers.get(instance.packedState) ?? [];
    if (observables.length > 0)
      throw new Error(
        `${instance.designator}: packed state ${instance.packedState} ` +
          `triggers explicit dirty observables [${observables.join(', ')}]`,
      );
  }

  const resetDrives = nets.mcuPins
    .map(({ pin, drive }) => {
      const code = mcu.resetDrives.get(pin);

      if (code === undefined) throw new Error(`Missing reset drive for ${pin}`);
      return `    store8(${driveMemoryName(drive)}, 0, ${code});`;
    })
    .join('\n');
  const replacements = {
    NET_FUNCTIONS: nets.functions.join('\n'),
    FUSED_REFRESH_BODY: nets.refresh,
    FUSED_INITIAL_REFRESH_BODY: nets.initialRefresh,
    BUTTON_FUNCTION: nets.buttonFunction,
    MARK_FUNCTIONS: nets.markFunctions,
    JUMPER_MARK: nets.jumperMark
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `      ${line}`)
      .join('\n'),
    SWITCH_MARK: nets.switchMark
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `      ${line}`)
      .join('\n'),
    BUTTON_DIRTY_STATE,
    LED_DIRTY_STATE,
    ACTUATOR_DIRTY_STATE,
    MCU_RESET_DRIVES: resetDrives,
    DRIVE_STATES: instances.flatMap((instance) => instance.driveStates).join('\n'),
    DRIVE_SETTERS: instances
      .flatMap((instance) => instance.setters)
      .map((setter) =>
        renderDriveSetter(
          setter,
          nets.stateMark(setter.state),
          nets.stateDirtyTriggers.get(setter.state) ?? [],
        ),
      )
      .join('\n'),
    START_FLAGS: instances
      .filter((instance) => instance.hasStart)
      .map((instance) => `    ${instance.prefix}_started = true;`)
      .join('\n'),
  };
  for (const name of netNames) replacements[`NET_${netSlotName(name)}`] = String(indexOfNet(name));
  for (const instance of instances)
    replacements[`PREFIX_${netSlotName(instance.designator)}`] = instance.prefix;
  for (const key of KEYS) replacements[`KEY_${key}`] = String(keyIndex(key));

  // Fixed schematic properties used by board-level analog/display/interactive logic.
  const ledProps = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'].map(propertiesOf);
  const segProps = ['DS1', 'DS2'].map(propertiesOf);
  const ledForward = ledProps[0]?.forwardResistance;
  const seg = segProps[0];
  if (ledForward === undefined || seg === undefined)
    throw new Error('missing D/DS properties in schematic');
  if (ledProps.some((item) => item.forwardResistance !== ledForward))
    throw new Error('D1-D8 forwardResistance values differ; board LED formula is shared');
  if (ledForward !== 1500)
    throw new Error(`D1-D8 forwardResistance must stay 1500 Ω (got ${ledForward})`);
  if (segProps.some((item) => item.commonAnode !== seg.commonAnode))
    throw new Error('DS1/DS2 commonAnode values differ; board display formula is shared');
  if (segProps.some((item) => item.forwardResistance !== seg.forwardResistance))
    throw new Error('DS1/DS2 forwardResistance values differ; board display formula is shared');
  if (seg.commonAnode !== true)
    throw new Error(`DS1/DS2 must stay commonAnode=true (got ${seg.commonAnode})`);
  if (seg.forwardResistance !== 1500)
    throw new Error(`DS1/DS2 forwardResistance must stay 1500 Ω (got ${seg.forwardResistance})`);
  if (segProps.some((item) => item.settleUs !== seg.settleUs))
    throw new Error('DS1/DS2 settleUs values differ; board display formula is shared');
  const j13Closed = propsOf('J13').closed ?? true;
  const j5Closed = propsOf('J5').closed ?? true;
  const j3Closed = propsOf('J3').closed ?? true;
  const j2Vs1838 = propsOf('J2').vs1838 ?? true;
  if (j13Closed !== true || j5Closed !== true || j3Closed !== true || j2Vs1838 !== true)
    throw new Error(
      `J2/J3/J5/J13 assembly must stay vs1838/closed/independent (got ${j13Closed}/${j5Closed}/${j3Closed}/${j2Vs1838})`,
    );
  const led = { forwardResistance: ledForward };
  const lm324 = propertiesOf('U26');
  const hall = propertiesOf('U21');
  Object.assign(replacements, {
    LED_FORWARD_RESISTANCE: literal(led.forwardResistance),
    SEG_FORWARD_RESISTANCE: literal(seg.forwardResistance),
    SEG_COMMON_ANODE: literal(seg.commonAnode),
    SEG_LIT_LEVEL: literal(seg.commonAnode ? 0 : 1),
    SEG_SELECT_LEVEL: literal(seg.commonAnode ? 1 : 0),
    SEG_SETTLE_PS: literal(Math.round((seg.settleUs ?? 50) * 1_000_000)),
    J13_CLOSED: literal(propsOf('J13').closed ?? true),
    J5_CLOSED: literal(propsOf('J5').closed ?? true),
    J3_CLOSED: literal(propsOf('J3').closed ?? true),
    J2_VS1838: literal(propsOf('J2').vs1838 ?? true),
    LM324_FEEDBACK: literal(lm324.feedbackResistance),
    LM324_POT: literal(lm324.potResistance),
    LM324_MIN_POT: literal(lm324.minPotResistance),
    LM324_WIPER: literal(lm324.initialWiper),
    HALL_OPERATE: literal(hall.operatePoint),
    HALL_RELEASE: literal(hall.releasePoint),
  });
  replacements.LED_CURRENT = `5 / (${literal(led.forwardResistance)} + 25)`;
  replacements.LED_VOLTAGE = `5 * ${literal(led.forwardResistance)} / (${literal(led.forwardResistance)} + 25)`;
  replacements.LED_BRIGHTNESS = `(5 / (${literal(led.forwardResistance)} + 25)) / 0.02`;
  return replacements;
}

function applyReplacements(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements))
    output = output.replaceAll(`{{${key}}}`, value);
  const unresolved = output.match(/\{\{[^}]+\}\}/g);
  if (unresolved) throw new Error(`Unresolved slots: ${[...new Set(unresolved)].join(', ')}`);
  return output;
}

async function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(MCU_ARTIFACT))
    throw new Error(
      `Missing ${relative(REPO, MCU_ARTIFACT)}; run "pnpm run build:mcu" before build:fused`,
    );
  const stamp = readMcuStamp();
  if (
    stamp === undefined ||
    stamp.source !== mcuSourceHash() ||
    stamp.artifact !== mcuArtifactHash()
  )
    throw new Error(
      `MCU artifact/source content mismatch; run "pnpm run build:mcu" before build:fused`,
    );
  const instances = [];
  for (const designator of DIGITAL) instances.push(await fuseInstance(designator));
  {
    const unexpectedNc = [...dummyPinNet.keys()].filter((pin) => !KNOWN_NC.has(pin));
    if (unexpectedNc.length > 0)
      throw new Error(`Unexpected unconnected pins: [${unexpectedNc.join(', ')}]`);
  }
  for (const [net, members] of Object.entries(netlist)) {
    if (members.length === 0) throw new Error(`Netlist net ${net} is empty`);
    for (const member of members) {
      const separator = member.lastIndexOf('.');
      const designator = separator < 0 ? member : member.slice(0, separator);
      if (!symbolByDesignator.has(designator))
        throw new Error(`Netlist net ${net} references unknown symbol ${member}`);
    }
  }
  const mcu = instances.find((instance) => instance.designator === 'U1');
  const merged = [mcu, ...instances.filter((instance) => instance !== mcu)];
  const nets = generateNets(instances, BOARD_TEMPLATE);
  const fragment = applyReplacements(BOARD_TEMPLATE, boardReplacements(merged, nets));

  const netMap = Object.fromEntries(netNames.map((name, index) => [name, index]));
  const mcuMap = Object.fromEntries(nets.mcuPins.map((pin) => [pin.pin, pin]));
  const netsSource = `// Generated by scripts/generate.mjs; do not edit.\n// prettier-ignore\nexport const NET = ${JSON.stringify(netMap, null, 2)} as const;\n// prettier-ignore\nexport const MCU_PIN = ${JSON.stringify(mcuMap, null, 2)} as const;\n// prettier-ignore\nexport const MCU_IMPACT: Readonly<Record<string, readonly number[]>> = ${JSON.stringify(nets.mcuImpact, null, 2)};\n// prettier-ignore\nexport const MCU_DIRTY_TRIGGERS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(nets.mcuDirtyTriggers, null, 2)};\nexport const NET_COUNT = ${netNames.length};\n`;
  const channels = {};
  for (const instance of merged) {
    if (instance.designator === 'U1') continue;
    for (const output of instance.outputs)
      channels[`${instance.prefix}_${output.name}`] = {
        designator: instance.designator,
        port: output.name,
        bytes: output.bytes,
      };
  }
  const lm324 = propertiesOf('U26');
  const lm324Position = lm324.initialWiper ?? 0;
  const lm324Gain =
    1 +
    (2 * lm324.feedbackResistance) /
      (lm324.minPotResistance +
        (lm324.potResistance - lm324.minPotResistance) * (1 - lm324Position));
  const boardDefaults = {
    j13Closed: propsOf('J13').closed ?? true,
    j5Closed: propsOf('J5').closed ?? true,
    j3Closed: propsOf('J3').closed ?? true,
    j2Vs1838: propsOf('J2').vs1838 ?? true,
    lm324: { position: lm324Position, gain: lm324Gain, outputVoltage: 0 },
  };
  const channelsSource = `// Generated by scripts/generate.mjs; do not edit.
export interface ChannelInfo {
  readonly designator: string;
  readonly port: string;
  readonly bytes: boolean;
}
// prettier-ignore
export const CHANNELS: Readonly<Record<string, ChannelInfo>> = ${JSON.stringify(channels, null, 2)};
// prettier-ignore
export const BOARD_DEFAULTS = ${JSON.stringify(boardDefaults, null, 2)} as const;
`;

  const probeBaud = Number(propertiesOf('UART_PROBE').baud ?? 9600);
  const header = [
    '/**',
    ' * CT107D fused board model. Generated by scripts/generate.mjs; do not edit.',
    ' *',
    ' * One model and one JIT: the 8051 core executes the firmware while every board',
    ' * device shares internal net states. Digital device bodies are source-merged from',
    ' * examples/devices; analog/display/interactive behavior lives in the board fragment.',
    ' */',
    `device Ct107dBoard(clockFrequency: number default 11059200, ultrasonicDistanceCm: number default 100, uartBaud: number default ${literal(probeBaud)}) {`,
    '  /** External power rails; all other historical pins are internal. */',
    '  pin VCC;',
    '  pin GND;',
    '',
    '  /**',
    '   * One level mirror per MCU pin drive for fast JIT loads: 0 = low, 1 = high,',
    '   * 2 = unknown. Board devices read the pure `fusedNetN()` functions directly.',
    '   */',
    ...nets.mcuPins
      .slice()
      .sort((left, right) => left.drive - right.drive)
      .map((pin) => `  memory ${pinMemoryName(pin.drive)}[1];`),
    '  /** One drive code per MCU pin drive: 0 strong low, 1 strong high, 2 weak high, 3 weak low, 4 release. */',
    ...nets.mcuPins
      .slice()
      .sort((left, right) => left.drive - right.drive)
      .map((pin) => `  memory ${driveMemoryName(pin.drive)}[1];`),
    '  /** MCU pin indices whose level mirror must be recomputed on the next refresh. */',
    `  memory ${PIN_DIRTY_MEMORY}[40];`,
    '  /** Summary byte per 8-pin group; any dirty pin marks its group for the refresh. */',
    `  memory ${DIRTY_GROUP_MEMORY}[${nets.groupCount}];`,
    '  /** Observables that must be recomputed on the next fused refresh. */',
    `  state ${BUTTON_DIRTY_STATE}: bool = false;`,
    `  state ${LED_DIRTY_STATE}: bool = false;`,
    `  state ${ACTUATOR_DIRTY_STATE}: bool = false;`,
    '  /** Monotonic trigger for the MCU pin-level refresh process. */',
    '  state fusedSeq: number = 0;',
    '  state fusedStarted: bool = false;',
    '',
    ...netNames.map((name, net) => {
      const mcu = nets.mcuPins.find((pin) => pin.net === net);
      const source =
        mcu === undefined ? `fusedNet${net}()` : `load8(${pinMemoryName(mcu.drive)}, 0)`;
      return (
        `  derived fusedCode${net}: number = ${source};` +
        `\n  derived fusedWire${net}: Logic = fusedCode${net} == 1 ? Logic.high : fusedCode${net} == 0 ? Logic.low : Logic.unknown;` +
        `\n  derived fusedVoltage${net}: number = fusedCode${net} == 1 ? 5 : 0;`
      );
    }),
    '',
  ].join('\n');

  const output = `${header}${merged.map((instance) => instance.body).join('\n')}\n${fragment}\n}\n`;
  const next = output.replace(/\r\n/g, '\n');
  await compileDDL(next, { uri: 'mica:ct107d/fused.ddl' });
  if (check) {
    const generated = [
      [OUTPUT, next],
      [NETS_OUTPUT, netsSource],
      [CHANNELS_OUTPUT, channelsSource],
    ];
    const stale = generated
      .filter(([path, content]) => {
        const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
        return current !== content;
      })
      .map(([path]) => relative(REPO, path));
    if (stale.length > 0) {
      console.error(`${stale.join(', ')} stale; run node scripts/generate.mjs`);
      process.exitCode = 1;
    } else console.log(`${relative(REPO, PROJECT)} generated sources are current`);
    return;
  }
  writeFileSync(OUTPUT, next);
  writeFileSync(NETS_OUTPUT, netsSource);
  writeFileSync(CHANNELS_OUTPUT, channelsSource);
  console.log(
    `fused model: ${netNames.length} nets, ${instances.length} source-merged devices, ${next.split('\n').length} lines -> ${relative(REPO, OUTPUT)}`,
  );
}

await main();
