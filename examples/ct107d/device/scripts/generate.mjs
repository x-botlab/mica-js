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
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDDL } from '@mica-js/sdk/ddl';
import { MCU_ARTIFACT, mcuArtifactHash, mcuSourceHash, readMcuStamp } from './mcu-source.mjs';
import { driveCode } from '../shared/drive-code.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const CT107D = join(PROJECT, '..');
const REPO = join(CT107D, '..', '..');
const DEVICES = join(CT107D, '..', 'devices');
const OUTPUT = join(PROJECT, 'src', 'model.ddl');
const NETS_OUTPUT = join(PROJECT, 'src', 'nets.ts');
const CHANNELS_OUTPUT = join(PROJECT, 'src', 'channels.ts');
const BOARD_FRAGMENT = join(HERE, 'board-fragment.ddl');

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
  'J2',
  'J3',
  'U26',
]);

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

const schematic = JSON.parse(readFileSync(join(CT107D, 'ct107d.sch'), 'utf8'));
const netlist = JSON.parse(readFileSync(join(CT107D, 'ct107d.netlist.json'), 'utf8'));

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
  if (symbols.length !== 54 || duplicates.length || unknown.length || missing.length)
    throw new Error(
      `Schema coverage mismatch: instances=${symbols.length}, ` +
        `duplicates=[${duplicates}], unknown=[${unknown}], missing=[${missing}]`,
    );
}
const propsOf = (designator) => symbolByDesignator.get(designator).properties ?? {};

const netNames = Object.keys(netlist);
const netIndex = new Map(netNames.map((name, index) => [name, index]));
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

/** Source-merge one digital instance. */
async function fuseInstance(designator) {
  const device = deviceOf(designator);
  const prefix = identifier(designator);
  const model = await modelOf(device);
  const source = readFileSync(join(DEVICES, device, 'src', 'model.ddl'), 'utf8');
  let body = stripPinDeclarations(bodyOf(source, device));
  const pins = model.declarations.filter((declaration) => declaration.kind === 'pin');
  const properties = propertiesOf(designator);

  // Replace property references with this instance's board values. The fused package
  // does not expose per-device tuning knobs; probe/counter defaults stay fixed.
  for (const declaration of model.declarations)
    if (declaration.kind === 'property' && declaration.name !== 'clockFrequency') {
      if (!(declaration.name in properties))
        throw new Error(`${designator}: missing property ${declaration.name}`);
      const replacement =
        designator === 'U22' && declaration.name === 'distanceCm'
          ? 'ultrasonicDistanceCm'
          : literal(properties[declaration.name]);
      body = body.replace(new RegExp(`\\b${declaration.name}\\b`, 'g'), replacement);
    }

  const driveStates = [];
  const setters = [];
  const pinNets = new Map();
  for (const pin of pins) {
    const power =
      pin.name === 'vcc' || pin.name === 'vcc1' ? 'vcc' : pin.name === 'gnd' ? 'gnd' : undefined;
    const hasIntent = new RegExp(`\\b${pin.name}\\.intent\\s*<-`).test(body);
    const initial = power === undefined ? initialDriveCode(pin, designator) : undefined;
    const rewritten = rewritePin(body, designator, prefix, pin.name, power);
    body = rewritten.source;
    pinNets.set(pin.name, rewritten.net);
    if (!hasIntent && initial === undefined) continue;
    if (power !== undefined)
      throw new Error(`${designator}.${pin.name}: power pin intent is not supported`);
    driveStates.push(`  state ${prefix}_${pin.name}_drive: number = ${initial ?? 4};`);
    setters.push(
      `  fn ${prefix}_${pin.name}_setDrive(level: number) {\n` +
        `    if level != ${prefix}_${pin.name}_drive {\n` +
        `      ${prefix}_${pin.name}_drive = level;\n` +
        `      fusedSeq = fusedSeq + 1;\n` +
        `    }\n` +
        `  }`,
    );
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

function generateNets(instances) {
  const drivers = new Map();
  const add = (net, expression) => {
    const list = drivers.get(net) ?? [];
    list.push(expression);
    drivers.set(net, list);
  };

  // MCU pins are written through `fusedMcuDrives` by the JIT fusion transform.
  const mcuPins = [];
  for (const port of [0, 1, 2, 3])
    for (let bit = 0; bit < 8; bit += 1) {
      const pin = `P${port}_${bit}`;
      const drive = port * 8 + bit;
      const net = netForPin('U1', pin);
      mcuPins.push({ pin, net, drive });
      add(net, `load8(fusedMcuDrives, ${drive})`);
    }

  for (const instance of instances)
    for (const pin of instance.pins)
      if (
        instance.pinNets.has(pin) &&
        instance.driveStates.some((line) => line.includes(`_${pin}_drive:`))
      )
        add(instance.pinNets.get(pin), `${instance.prefix}_${pin}_drive`);

  // Derive the key matrix from netlist endpoints instead of trusting a hand-written
  // row order. S4-S7 are independent keys to GND; S8-S19 are row/column keys.
  const BUTTON_ROWS = ['P30/TXD', 'P31/RXD', 'P32', 'P33'];
  const BUTTON_COLS = ['P42/WR', 'P35', 'P34'];
  const keyNet = (designator, pin) => {
    const net = pinNet.get(`${designator}.${pin}`);
    return net === undefined ? undefined : netNames[net];
  };
  const independentKeys = [];
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
    const ground = nets.includes('GND');
    if (ground) {
      const row = nets.find((net) => net !== 'GND');
      const rowIndex = BUTTON_ROWS.indexOf(row);
      if (rowIndex < 0) throw new Error(`${designator}: unknown independent row ${row}`);
      independentKeys.push({ key: designator, row: rowIndex });
      continue;
    }
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
  if (independentKeys.length + matrixKeys.length !== expectedKeys.length)
    throw new Error('Button matrix does not cover every S4-S19 key');
  for (const key of expectedKeys)
    if (![...independentKeys, ...matrixKeys].some((entry) => entry.key === key))
      throw new Error(`Button matrix is missing ${key}`);

  const directLow = (netName) => [
    ...(drivers.get(indexOfNet(netName)) ?? []).map((driver) => `${driver} == 0`),
  ];
  const independentLow = new Map();
  for (const entry of independentKeys) {
    const list = independentLow.get(entry.row) ?? [];
    list.push(`load8(keyStates, ${keyIndex(entry.key)}) == 1`);
    independentLow.set(entry.row, list);
  }
  const rowLow = BUTTON_ROWS.map((row, index) => {
    const lows = directLow(row);
    for (const condition of independentLow.get(index) ?? []) lows.push(condition);
    return lows;
  });
  const colLow = BUTTON_COLS.map((col) => {
    const lows = directLow(col);
    if (col === 'P42/WR') lows.push('j13Closed');
    if (col === 'P34') lows.push('j3Closed && u15_out_drive == 0');
    return lows;
  });

  const buttonLines = [
    '  memory fusedButtonLow[7];',
    '  fn fusedComputeButtons() {',
    ...Array.from({ length: 7 }, (_, index) => `    store8(fusedButtonLow, ${index}, 0);`),
  ];
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
  // held low (J13 grounds P42/WR permanently).
  for (const entry of matrixKeys) {
    const connected = `load8(fusedButtonLow, ${entry.row}) == 1 || load8(fusedButtonLow, ${4 + entry.col}) == 1`;
    buttonLines.push(
      `      if load8(keyStates, ${keyIndex(entry.key)}) == 1 && (${connected}) {`,
      `        store8(fusedButtonLow, ${entry.row}, 1);`,
      `        store8(fusedButtonLow, ${4 + entry.col}, 1);`,
      '      }',
    );
  }
  buttonLines.push('      iteration = iteration + 1;', '    }', '  }');
  const buttonFunction = buttonLines.join('\n');

  const functions = [];
  for (let net = 0; net < netNames.length; net += 1) {
    const name = netNames[net];
    let body;
    if (name === 'VCC') body = '    return 1;';
    else if (name === 'GND') body = '    return 0;';
    else if (name === 'N_A1') body = `    return fusedNet${indexOfNet('P10')}();`;
    else if (name === 'N_A2') body = '    return 2;';
    else {
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
      // J13 grounds the WR column.
      if (name === 'P42/WR') lines.push('    if j13Closed { strongLow = true; }');

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
  }
  // Only the 32 MCU pin levels are materialised for the JIT. Board devices and the
  // hand-written glue read the pure net functions directly; this keeps the refresh
  // proportional to the MCU pins instead of all 102 historical nets.
  const refresh = mcuPins
    .map((pin) => {
      return (
        `    const next${pin.drive} = fusedNet${pin.net}();\n` +
        `    if load8(fusedPins, ${pin.drive}) != next${pin.drive} { store8(fusedPins, ${pin.drive}, next${pin.drive}); }`
      );
    })
    .join('\n');
  return { functions, mcuPins, refresh, buttonFunction };
}

function boardReplacements(instances, nets) {
  const replacements = {
    NET_FUNCTIONS: nets.functions.join('\n'),
    FUSED_REFRESH_BODY: nets.refresh,
    BUTTON_FUNCTION: nets.buttonFunction,
    DRIVE_STATES: instances.flatMap((instance) => instance.driveStates).join('\n'),
    DRIVE_SETTERS: instances.flatMap((instance) => instance.setters).join('\n'),
    START_FLAGS: instances
      .filter((instance) => instance.hasStart)
      .map((instance) => `    ${instance.prefix}_started = true;`)
      .join('\n'),
  };
  const netName = (name) => name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  for (const name of netNames) replacements[`NET_${netName(name)}`] = String(indexOfNet(name));
  for (const instance of instances)
    replacements[`PREFIX_${netName(instance.designator)}`] = instance.prefix;
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
  const j3Closed = propsOf('J3').closed ?? true;
  const j2Vs1838 = propsOf('J2').vs1838 ?? true;
  if (j13Closed !== true || j3Closed !== true || j2Vs1838 !== true)
    throw new Error(
      `J2/J3/J13 assembly must stay vs1838/closed (got ${j13Closed}/${j3Closed}/${j2Vs1838})`,
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
  const nets = generateNets(instances);
  const fragment = applyReplacements(
    readFileSync(BOARD_FRAGMENT, 'utf8'),
    boardReplacements(merged, nets),
  );

  const netMap = Object.fromEntries(netNames.map((name, index) => [name, index]));
  const mcuMap = Object.fromEntries(nets.mcuPins.map((pin) => [pin.pin, pin]));
  const netsSource = `// Generated by scripts/generate.mjs; do not edit.\n// prettier-ignore\nexport const NET = ${JSON.stringify(netMap, null, 2)} as const;\n// prettier-ignore\nexport const MCU_PIN = ${JSON.stringify(mcuMap, null, 2)} as const;\nexport const NET_COUNT = ${netNames.length};\n`;
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

  const header = [
    '/**',
    ' * CT107D fused board model. Generated by scripts/generate.mjs; do not edit.',
    ' *',
    ' * One model and one JIT: the 8051 core executes the firmware while every board',
    ' * device shares internal net states. Digital device bodies are source-merged from',
    ' * examples/devices; analog/display/interactive behavior lives in the board fragment.',
    ' */',
    'device Ct107dBoard(clockFrequency: number default 11059200, ultrasonicDistanceCm: number default 100) {',
    '  /** External power rails; all other historical pins are internal. */',
    '  pin VCC;',
    '  pin GND;',
    '',
    '  /**',
    '   * MCU pin levels mirrored for fast JIT loads: 0 = low, 1 = high, 2 = unknown.',
    '   * Board devices read the pure `fusedNetN()` functions directly.',
    '   */',
    '  memory fusedPins[32];',
    '  /** MCU pin drive codes: 0 strong low, 1 strong high, 2 weak high, 3 weak low, 4 release. */',
    '  memory fusedMcuDrives[32];',
    '  /** Monotonic trigger for the MCU pin-level refresh process. */',
    '  state fusedSeq: number = 0;',
    '  state fusedStarted: bool = false;',
    '',
    ...netNames.map((name, net) => {
      const mcu = nets.mcuPins.find((pin) => pin.net === net);
      const source = mcu === undefined ? `fusedNet${net}()` : `load8(fusedPins, ${mcu.drive})`;
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
