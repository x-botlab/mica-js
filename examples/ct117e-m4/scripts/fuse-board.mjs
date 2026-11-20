import { readFile } from 'node:fs/promises';

const netlist = JSON.parse(
  await readFile(new URL('../ct117e-m4.netlist.json', import.meta.url), 'utf8'),
);
const library = (device) =>
  readFile(new URL(`../../devices/${device}/src/model.ddl`, import.meta.url), 'utf8');

const wires = [];
function check(net, ...endpoints) {
  for (const pin of endpoints) {
    if (!netlist[net]?.includes(pin)) throw new Error(`Missing ${pin} on ${net}`);
  }
}
function wire(net, ...endpoints) {
  check(net, ...endpoints);
  const pin = netlist[net].filter((member) => /^U4\.P[A-F]\d+$/.test(member));
  if (pin.length !== 1 || wires.includes(pin[0].slice(3)))
    throw new Error(`Expected a distinct GPIO on ${net}`);
  wires.push(pin[0].slice(3));
  return wires.length - 1;
}
const wireState = (index) => `fusedWire${index}`;

// The existing LCD hot DDL uses these slots directly. Fail if the fixed bus changes.
for (let i = 0; i < 16; i++) wire(`LCD_D${i}`, `U4.PC${i}`, `CN3.${i + 6}`);
for (const [net, pin, cn] of [
  ['LCD_WR', 'PB5', 3],
  ['LCD_RS', 'PB8', 2],
  ['LCD_CS', 'PB9', 1],
  ['LCD_RD', 'PA8', 4],
])
  wire(net, `U4.${pin}`, `CN3.${cn}`);
check('LCD_RST', 'U4.PG10-NRST', 'CN3.5', 'RESET.1', 'RESET.2', 'C3.1', 'R20.2', 'J7.1');
check(
  'GND',
  'RESET.3',
  'RESET.4',
  'C3.2',
  'R36.2',
  'CN3.26',
  'CN3.27',
  'U4.15',
  'U4.31',
  'U4.47',
  'U4.63',
);
check('VDD', 'R20.1', 'CN3.24', 'U4.1', 'U4.16', 'U4.32', 'U4.48', 'U4.64');
check('LCD_RS', 'R36.1');

const le = wire('LED_LE', 'U1.LE');
check('VDD', 'U1.VCC');
check('GND', 'U1.GND', 'U1.OE#');
const ledInputs = [7, 8, 10, 12, 13, 14, 15, 16].map((resistor, i) => {
  check(`LED${i + 1}_K`, `U1.${i + 1}Q`, `LD${i + 1}.cathode`);
  check(`LED${i + 1}_A`, `R${resistor}.2`, `LD${i + 1}.anode`);
  check('VDD', `R${resistor}.1`);
  const net = Object.keys(netlist).find((name) => netlist[name].includes?.(`U1.${i + 1}D`));
  const bit = /^LCD_D(\d+)$/.exec(net ?? '');
  if (!bit) throw new Error(`U1.${i + 1}D not on the LCD bus`);
  return Number(bit[1]);
});
const buttons = ['R1.2', 'R2.1', 'R5.2', 'R6.2'].map((pull, i) => {
  check(
    'VDD',
    pull.replace(/\.[12]$/, (pin) => (pin === '.1' ? '.2' : '.1')),
  );
  check('GND', `B${i + 1}.4`);
  return wire(`SW${i + 1}`, `B${i + 1}.1`, pull);
});
const scl = wire('I2C_SCL', 'U2.SCL', 'U3.SCL', 'R9.1', 'R18.2');
const sda = wire('I2C_SDA', 'U2.SDA', 'U3.SDA', 'R11.1', 'R19.2');
check('VDD', 'U2.VCC', 'U3.VDD', 'R9.2', 'R18.1', 'R11.2', 'R19.1');
check('GND', 'U2.VSS', 'U2.E1', 'U2.E2', 'U2.E3', 'U2.WC#', 'U3.VSS', 'J16.2', 'R21.1');
check('AGND', 'R21.2', 'U4.VSSA');
check('VDD', 'U4.VDDA', 'J17.1');
check('VREF+', 'U4.VREF+', 'J17.2');
check('MCP4017_W', 'U3.W', 'J15.1');
check('MCP4017_B', 'U3.B', 'J16.1');
check('VDD', 'R17.1');
const wiper = wire('PB14', 'J15.2', 'R17.2');
const pots = [
  ['R37', 'J11', 'PB15'],
  ['R38', 'J12', 'PB12'],
].map(([r, j, pin]) => {
  check('VDD', `${r}.3`);
  check('GND', `${r}.1`);
  check(`${r}_W`, `${r}.2`, `${j}.2`);
  return wire(pin, `${j}.1`);
});
const timers = [
  ['U7', 'R39', 'R31', 'C26', 'C27', 'J9', 'PB4'],
  ['U8', 'R40', 'R32', 'C28', 'C29', 'J10', 'PA15'],
].map(([u, pot, r, c, ctrl, j, pin]) => {
  check('VDD', `${u}.VDD`, `${u}.RESET`);
  check('GND', `${u}.GND`, `${c}.2`, `${ctrl}.1`);
  check(`${u}_OUT`, `${u}.OUT`, `${pot}.2`, `${j}.2`);
  check(`${u}_R`, `${pot}.3`, `${r}.1`);
  check(`${u}_RC`, `${r}.2`, `${c}.1`, `${u}.TRIG`, `${u}.THRES`);
  check(`${u}_CONT`, `${u}.CONT`, `${ctrl}.2`);
  return wire(pin, `${j}.1`);
});

function replace(source, pattern, replacement) {
  if (!source.match(pattern)) throw new Error(`Library DDL no longer matches ${pattern}`);
  return source.replace(pattern, replacement);
}
function section(source, from, to = '\n}') {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Library DDL section missing: ${from}…${to}`);
  return source.slice(start, end);
}
function namespace(source, prefix) {
  const names = new Set(
    [
      ...source.matchAll(
        /^ {2}(?:pure )?(?:fn|record|enum|state|memory|const|output channel) (\w+)/gm,
      ),
    ].map((match) => match[1]),
  );
  return source.replace(/\b\w+\b/g, (name) => (names.has(name) ? `${prefix}_${name}` : name));
}

/** Lower the library I²C reactions to synchronous callbacks on the shared internal bus. */
async function i2cDevice(device, prefix) {
  const source = await library(device);
  const eeprom = device === 'at24c02';
  let body = [
    eeprom ? section(source, '  memory storage', '  enum Phase') : '  const POR_WIPER = 0x3f;',
    section(source, '  enum Phase', '  /** 未知'),
    section(source, '  pure fn sampleBit', '  /** 总线编码'),
    eeprom ? '' : section(source, '  pure fn resistanceFor', '  derived busCodes'),
    '  fn sink(enabled: bool) { sinking = enabled; }',
    section(source, '  fn acknowledge', '  process start'),
    section(source, '  reaction busEdge'),
  ].join('\n');
  body = replace(
    body,
    /reaction busEdge on busCodes as \(previous, current\)\s+capture [^{]+\{/,
    `fn busEdge(previous: BusCodes, current: BusCodes) {
    const dataLevel = current.dataCode == 1 ? Logic.high : Logic.low;${
      eeprom
        ? `
    // E1/E2/E3 and WC# are wired to GND.
    const addressA0 = Logic.low;
    const addressA1 = Logic.low;
    const addressA2 = Logic.low;
    const writeProtect = Logic.low;`
        : ''
    }`,
  );
  if (!eeprom) {
    body = replace(body, / {6}w.intent <- [^\n]+\n/, '');
    body = replace(body, / {6}resistance.send[^\n]+\n/, '');
    body = replace(body, / {2}fn reportVoltage\(\) \{[\s\S]+?\n {2}\}\n/, '');
    body = body.replace(/\bcode\b/g, 'wiperValue');
    body =
      `  const rab = 100_000;\n  const wiperResistance = 100;\n` +
      '  output channel wiper: number(capacity: 16, overflow: Overflow.drop_oldest);\n' +
      body;
  } else {
    // Keep the library's dump-on-change output; storage is private to the model.
    body = body.replace(/\bindex\b/g, 'byteIndex');
  }
  return namespace(body, prefix);
}

async function latchDevice() {
  const source = await library('74hc573');
  let decode = section(source, '  pure fn bit', '  derived transparent');
  // Lower Logic.high to the numeric GPIO encoding and normalize the return for
  // the LCD JIT's inliner. The weight/order of the eight inputs stays in the library.
  decode = replace(
    decode,
    /bit\(level: Logic\) -> number \{\s+if level == Logic.high \{\s+return 1;\s+\}\s+return 0;/,
    'bit(level: number) -> number {\n    return level == 1 ? 1 : 0;',
  );
  decode = replace(decode, /pure fn dataByte/, 'fn dataByte');
  decode = decode.replace(/d([0-7])\.sample\.level/g, (_, bit) => {
    const wire = ledInputs[Number(bit)];
    return `(fusedReading ? (fusedReadValue >> ${wire}) & 1 : ${wireState(wire)})`;
  });
  return namespace(decode, 'u1');
}

export async function fuseBoard(fragment, oscillator) {
  const [u1, u2, u3] = await Promise.all([
    latchDevice(),
    i2cDevice('at24c02', 'u2'),
    i2cDevice('mcp4017', 'u3'),
  ]);
  const aliases = { LED_LE: le, I2C_SCL: scl, I2C_SDA: sda, WIPER: wiper };
  for (const [i, index] of buttons.entries()) aliases[`SW${i + 1}`] = index;
  for (const [i, index] of pots.entries()) aliases[`POT${i + 1}`] = index;
  for (const [i, index] of timers.entries()) aliases[`TIMER${i + 1}`] = index;
  const board = fragment.replace(/@(\w+)@/g, (_, name) => {
    if (name in aliases) return String(aliases[name]);
    if (name.startsWith('WIRE_') && name.slice(5) in aliases)
      return wireState(aliases[name.slice(5)]);
    if (name === 'SCL_BIT' || name === 'SDA_BIT') {
      const pin = wires[name === 'SCL_BIT' ? scl : sda];
      if (!/^PB[0-7]$/.test(pin)) throw new Error(`Unsupported GPIO for I²C: ${pin}`);
      return pin.slice(2);
    }
    throw new Error(`Unknown board placeholder ${name}`);
  });
  const oscillators = timers.map((index, i) => {
    const capture = ['PA15', 'PB4'].indexOf(wires[index]);
    if (capture < 0) throw new Error(`No capture input for ${wires[index]}`);
    return oscillator.replaceAll('@ID@', String(i + 1)).replaceAll('@CAPTURE@', String(capture));
  });
  return {
    ddl: [
      ...wires.slice(20).map((_, index) => `  state ${wireState(index + 20)}: number = -1;`),
      u1,
      u2,
      u3,
      board,
      ...oscillators,
    ].join('\n'),
    wiring: `// Generated from ct117e-m4.netlist.json; do not edit.
export const FUSED_WIRES: readonly string[] = ${JSON.stringify(wires)};
export const BOARD_WIRES = ${JSON.stringify({
      LED_LE: le,
      I2C_SCL: scl,
      I2C_SDA: sda,
      LED_DATA: ledInputs,
    })} as const;\n`,
  };
}
