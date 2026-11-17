import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(SCRIPT_DIR, 'test-firmware-suite.mjs');
const MANIFEST = join(SCRIPT_DIR, 'firmware-suite.manifest.json');

function hexRecord(type, offset, data) {
  const body = Buffer.from(data);
  const head = Buffer.from([body.length, (offset >> 8) & 0xff, offset & 0xff, type]);
  const sum = [...head, ...body].reduce((total, value) => total + value, 0);
  return `:${Buffer.concat([head, body, Buffer.from([(256 - (sum % 256)) % 256])])
    .toString('hex')
    .toUpperCase()}`;
}

const firmware = [hexRecord(0, 0, [0x02, 0, 0]), hexRecord(1, 0, [])].join('\n') + '\n';

function fixture({ extraHex = false } = {}) {
  const tempRoot = '/tmp/opencode';
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'ct107d-suite-tool-'));
  const projectDir = join(root, 'demo', 'program');
  mkdirSync(join(projectDir, 'Objects'), { recursive: true });
  writeFileSync(join(projectDir, 'main.c'), 'void main(void) {}\n');
  writeFileSync(join(projectDir, 'Objects', 'main.hex'), firmware);
  const manifest = {
    version: 1,
    projects: [
      {
        id: 'demo',
        category: 'test',
        name: 'demo',
        programDir: 'demo/program',
        hex: 'Objects/main.hex',
        mainSource: 'main.c',
        clockFrequency: 12000000,
        clockEvidence: 'test',
        sourceEvidence: ['main.c:1'],
        mode: 'behavior',
        scenario: {
          props: {},
          runMs: 0,
          events: [],
          assertions: [{ id: 'x', type: 'snapshot', path: 'relay', atMs: 0, equals: false }],
        },
      },
      {
        id: 'missing',
        category: 'test',
        name: 'missing',
        programDir: 'missing/program',
        hex: 'Objects/main.hex',
        mainSource: 'main.c',
        clockFrequency: 12000000,
        clockEvidence: 'test',
        sourceEvidence: ['main.c:1'],
        mode: 'smoke',
        scenario: { props: {}, runMs: 0, events: [], assertions: [] },
      },
      {
        id: 'document',
        category: 'test',
        name: 'document',
        programDir: 'document',
        status: 'not-applicable',
        reason: 'document only',
      },
    ],
  };
  mkdirSync(join(root, 'missing', 'program'), { recursive: true });
  mkdirSync(join(root, 'document'), { recursive: true });
  if (extraHex) {
    mkdirSync(join(root, 'extra', 'Objects'), { recursive: true });
    writeFileSync(join(root, 'extra', 'Objects', 'extra.hex'), firmware);
  }
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath };
}

function run(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('dry-run inventories an explicit fixture root and reports blocked/not-applicable', () => {
  const fx = fixture();
  const result = run(['--dry-run', '--root', fx.root, '--manifest', fx.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.coverage.projects, 3);
  assert.equal(output.coverage.executableProjects, 2);
  assert.equal(output.coverage.notApplicable, 1);
  assert.equal(output.coverage.discoveredHex, 1);
  assert.equal(output.coverage.unclaimedHex.length, 0);
  assert.equal(output.runnable.find((project) => project.id === 'demo').status, 'ready');
  assert.match(
    output.runnable.find((project) => project.id === 'missing').blockedReason,
    /no HEX under/,
  );
  assert.equal(output.notApplicable[0].id, 'document');
});

test('dry-run rejects an unclaimed external HEX (no silent omission)', () => {
  const fx = fixture({ extraHex: true });
  const result = run(['--dry-run', '--root', fx.root, '--manifest', fx.manifestPath]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /manifest does not cover 1 discovered HEX/);
});

test('checked-in manifest covers 26 executable projects plus one document entry', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const executable = manifest.projects.filter((project) => project.status !== 'not-applicable');
  const documents = manifest.projects.filter((project) => project.status === 'not-applicable');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.projects.length, 27);
  assert.equal(executable.length, 26);
  assert.equal(documents.length, 1);
  assert.equal(new Set(manifest.projects.map((project) => project.id)).size, 27);
  for (const project of executable) {
    assert.equal(project.mode, 'behavior', `${project.id} must be a behavior scenario`);
    assert.ok(project.sourceEvidence?.length > 0, `${project.id} needs sourceEvidence`);
    assert.ok(project.scenario.assertions.length > 0, `${project.id} needs assertions`);
    assert.ok(project.hex.endsWith('.hex'), `${project.id} needs a HEX path`);
  }
  assert.equal(documents[0].id, 'national-11-materials');
  assert.match(documents[0].reason, /11F_单片机_客观试题/);
  for (const [id, baud] of Object.entries({
    'ct107s-uart': 9600,
    practice: 1200,
    'national-5-event-recorder': 1200,
    'national-10': 4800,
  }))
    assert.equal(
      executable.find((project) => project.id === id)?.scenario.props.uartBaud,
      baud,
      `${id} must declare uartBaud ${baud}`,
    );
});

test('compareValue is fail-closed and handles positive/negative comparisons', async () => {
  const { compareValue } = await import('./test-firmware-suite.mjs');
  assert.equal(compareValue(3, { equals: 3 }).pass, true);
  assert.equal(compareValue(4, { equals: 3 }).pass, false);
  assert.equal(compareValue(4, {}).pass, false);
  assert.match(compareValue(4, {}).reason, /no comparison operator/);
  assert.equal(compareValue(1.5, { closeTo: 1.5, tolerance: 0.01 }).pass, true);
  assert.equal(compareValue(1.6, { closeTo: 1.5, tolerance: 0.01 }).pass, false);
  assert.equal(compareValue('abc', { matches: '^a' }).pass, true);
  assert.equal(compareValue(['a', 'b'], { includes: 'b' }).pass, true);
});

test('BCD decoding accepts valid bytes and rejects invalid nibbles', async () => {
  const { decodeBcd } = await import('./test-firmware-suite.mjs');
  assert.equal(decodeBcd(0x57), 57);
  assert.equal(decodeBcd(0x00), 0);
  assert.equal(decodeBcd(0x99), 99);
  assert.equal(decodeBcd(0x7a), undefined);
  assert.equal(decodeBcd(0xff), undefined);
  assert.equal(decodeBcd(256), undefined);
});

test('uartBaud resolves against artifact property and fails closed for unsupported declarations', async () => {
  const { preflightUartBaud, readUartBaudProperty, resolveUartBaud } =
    await import('./test-firmware-suite.mjs');
  const property = readUartBaudProperty({
    uartBaud: { type: 'number', min: 1, max: 1_000_000_000, default: 9600 },
  });
  assert.deepEqual(resolveUartBaud({ id: 'p', scenario: { props: {} } }, property), {
    value: 9600,
    source: 'property.default',
  });
  assert.deepEqual(
    resolveUartBaud({ id: 'p', scenario: { props: { uartBaud: 1200 } } }, property),
    { value: 1200, source: 'scenario.props' },
  );
  assert.throws(
    () => resolveUartBaud({ id: 'p', scenario: { props: { uartBaud: 0 } } }, property),
    /outside artifact range/,
  );
  assert.throws(
    () => resolveUartBaud({ id: 'p', scenario: { props: { uartBaud: 1.5 } } }, property),
    /safe integer/,
  );
  assert.throws(
    () => resolveUartBaud({ id: 'p', scenario: { props: { uartBaud: 1200 } } }, null),
    /no uartBaud property/,
  );
  assert.throws(
    () => readUartBaudProperty({ uartBaud: { type: 'number', min: 1, max: 2, default: 3 } }),
    /default must be an in-range safe integer/,
  );
  const map = preflightUartBaud(
    { projects: [{ id: 'p', scenario: { props: { uartBaud: 4800 } } }] },
    property,
  );
  assert.deepEqual(map.get('p'), { value: 4800, source: 'scenario.props' });
});

test('scenario.notes is validated as a string array', async () => {
  const { readManifest } = await import('./test-firmware-suite.mjs');
  const fx = fixture();
  const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
  manifest.projects[0].scenario.notes = ['source-derived note'];
  writeFileSync(fx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.doesNotThrow(() => readManifest(fx.manifestPath));
  manifest.projects[0].scenario.notes = [1];
  writeFileSync(fx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => readManifest(fx.manifestPath), /scenario\.notes must be a string array/);
  manifest.projects[0].scenario.notes = ['source-derived note'];
  manifest.projects[0].scenario.props = { uartBaud: 1.5 };
  writeFileSync(fx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => readManifest(fx.manifestPath),
    /scenario\.props\.uartBaud must be a positive safe integer/,
  );
});

test('assertion schema fails closed for missing/ambiguous fields and unsafe times', async () => {
  const { validateAssertion } = await import('./test-firmware-suite.mjs');
  const project = { id: 'p' };
  const ids = new Set();
  validateAssertion(
    project,
    { id: 'ok', type: 'display', designator: 'DS1', atMs: 1, text: '1234' },
    2,
    ids,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'five', type: 'display', designator: 'DS1', text: '  251' },
        2,
        new Set(),
      ),
    /exactly 4 characters/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'both', type: 'display', designator: 'DS1', text: '1234', masks: [0, 0, 0, 0] },
        2,
        new Set(),
      ),
    /exactly one of text\/masks/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'masks', type: 'display', designator: 'DS1', masks: [0, 0, 0] },
        2,
        new Set(),
      ),
    /four bytes/,
  );
  assert.throws(
    () => validateAssertion(project, { id: 'unknown', type: 'does-not-exist' }, 2, new Set()),
    /unknown assertion type/,
  );
  assert.throws(
    () => validateAssertion(project, { id: 'rtc', type: 'rtc', atMs: 1 }, 2, new Set()),
    /rtc needs/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'uart', type: 'uart', channel: 'bad', ascii: 'x' },
        2,
        new Set(),
      ),
    /uart channel/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'uarthex', type: 'uart', channel: 'uart1Tx', hex: 'abc' },
        2,
        new Set(),
      ),
    /even-length hex/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'uart-eq-bad', type: 'uart', channel: 'probeTx', equalsChannel: 'bad' },
        2,
        new Set(),
      ),
    /equalsChannel must be one of/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'uart-eq-self', type: 'uart', channel: 'probeTx', equalsChannel: 'probeTx' },
        2,
        new Set(),
      ),
    /equalsChannel must differ/,
  );
  assert.throws(
    () =>
      validateAssertion(project, { id: 'nocmp', type: 'snapshot', path: 'relay' }, 2, new Set()),
    /needs a comparator/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'time', type: 'snapshot', path: 'relay', atMs: 3, equals: false },
        2,
        new Set(),
      ),
    /within 0\.\.2/,
  );
  assert.throws(
    () =>
      validateAssertion(
        project,
        { id: 'ok', type: 'display', designator: 'DS1', text: '1234' },
        2,
        ids,
      ),
    /duplicate assertion id/,
  );
});

test('overrideStatus is hash-bound and cannot hide errors or guard failures', async () => {
  const { applyOverrideStatus } = await import('./test-firmware-suite.mjs');
  const project = {
    overrideStatus: {
      status: 'blocked',
      reason: 'known mismatch',
      expectedHexSha256: 'a'.repeat(64),
      expectedSourceAggregateSha256: 'b'.repeat(64),
    },
  };
  const base = () => ({
    status: 'behavior-fail',
    pass: false,
    guardCounts: { total: 5, passed: 5, failed: 0 },
    source: {
      hex: { fileSha256: 'a'.repeat(64) },
      sourceAggregateSha256: 'b'.repeat(64),
    },
  });
  const blocked = applyOverrideStatus(project, base());
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.pass, null);
  assert.equal(blocked.overrideStatus.applied, true);

  const wrongHex = applyOverrideStatus(project, {
    ...base(),
    source: { ...base().source, hex: { fileSha256: 'c'.repeat(64) } },
  });
  assert.equal(wrongHex.status, 'behavior-fail');
  assert.equal(wrongHex.overrideStatus.applied, false);

  const errored = applyOverrideStatus(project, { ...base(), status: 'error' });
  assert.equal(errored.status, 'error');
  assert.equal(errored.overrideStatus.applied, false);

  const guardFailed = applyOverrideStatus(project, {
    ...base(),
    guardCounts: { total: 5, passed: 4, failed: 1 },
  });
  assert.equal(guardFailed.status, 'behavior-fail');
  assert.equal(guardFailed.overrideStatus.applied, false);
});

function multiFixture() {
  const tempRoot = '/tmp/opencode';
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'ct107d-suite-orchestration-'));
  const ids = ['pass-one', 'crash-two', 'timeout-three'];
  const projects = ids.map((id) => {
    const projectDir = join(root, id, 'program');
    mkdirSync(join(projectDir, 'Objects'), { recursive: true });
    writeFileSync(join(projectDir, 'main.c'), 'void main(void) {}\n');
    writeFileSync(join(projectDir, 'Objects', 'main.hex'), firmware);
    return {
      id,
      category: 'test',
      name: id,
      programDir: `${id}/program`,
      hex: 'Objects/main.hex',
      mainSource: 'main.c',
      clockFrequency: 12000000,
      clockEvidence: 'test',
      sourceEvidence: ['main.c:1'],
      mode: 'behavior',
      scenario: {
        props: {},
        runMs: 0,
        events: [],
        assertions: [{ id: 'functional', type: 'snapshot', path: 'relay', atMs: 0, equals: false }],
      },
    };
  });
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  const workerPath = join(root, 'fake-worker.mjs');
  writeFileSync(
    workerPath,
    `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const id = value('--child');
const resultPath = value('--result');
const token = value('--token');
if (id === 'crash-two') process.exit(7);
if (id === 'timeout-three') { await new Promise((resolve) => setTimeout(resolve, 5000)); process.exit(0); }
writeFileSync(resultPath, JSON.stringify({
  schemaVersion: 1, runToken: token, id, category: 'test', name: id, mode: 'behavior',
  status: 'behavior-pass', pass: true, clock: { frequencyHz: 12000000, evidence: 'fake' },
  source: { programDir: id + '/program', mainSource: 'main.c', evidence: [], hex: { path: 'Objects/main.hex' } },
  scenario: { props: {}, runMs: 0, events: [], assertions: [] },
  guards: [{ id: 'fake-guard', type: 'structure', pass: true, expected: 1, actual: 1 }],
  checks: [{ id: 'fake-functional', type: 'snapshot', pass: true, expected: true, actual: true }],
  assertions: { total: 1, passed: 1, failed: 0, limited: 0, notCovered: 0 },
  metrics: { simTimeMs: 0, wallMs: 0, cpuMs: 0 }, notCovered: [],
}, null, 2));
`,
  );
  return { root, manifestPath, workerPath, ids };
}

test('orchestration: crash/timeout produce results, remaining projects continue, stale out is refused', () => {
  const fx = multiFixture();
  const out = join(fx.root, 'out');
  const args = [
    '--root',
    fx.root,
    '--manifest',
    fx.manifestPath,
    '--worker',
    fx.workerPath,
    '--jobs',
    '1',
    '--timeout-ms',
    '100',
    '--out',
    out,
  ];
  const first = run(args);
  assert.equal(first.status, 1, first.stderr);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.coverage.executableProjects, 3);
  assert.equal(summary.executable, 3);
  assert.equal(summary.failed, 2);
  assert.equal(summary.counts['behavior-pass'], 1);
  assert.equal(summary.counts.error, 2);
  assert.match(summary.manifestSha256, /^[0-9a-f]{64}$/);
  assert.ok(readFileSync(join(out, 'manifest.snapshot.json'), 'utf8').includes('pass-one'));
  for (const id of fx.ids) {
    const item = JSON.parse(readFileSync(join(out, 'projects', `${id}.json`), 'utf8'));
    assert.equal(item.id, id);
    assert.ok(item.source?.hex?.filePath, `${id} has a normalized source.hex`);
  }
  assert.match(
    JSON.parse(readFileSync(join(out, 'projects', 'timeout-three.json'), 'utf8')).error.message,
    /child produced no result/,
  );

  const second = run(args);
  assert.equal(second.status, 3);
  assert.match(second.stderr, /output directory is not empty/);
});

test('BCD eeprom assertion decodes raw bytes and rejects invalid BCD', async () => {
  const { evaluateAssertion } = await import('./test-firmware-suite.mjs');
  const eeprom = new Uint8Array(256);
  eeprom[4] = 0x57;
  const state = { atMs: 1, eeprom };
  const valid = evaluateAssertion(
    { id: 'seconds', type: 'eeprom', address: 4, atMs: 1, bcd: true, min: 55, max: 59 },
    state,
  );
  assert.equal(valid.pass, true, JSON.stringify(valid));
  eeprom[4] = 0x7a;
  const invalid = evaluateAssertion(
    { id: 'seconds', type: 'eeprom', address: 4, atMs: 1, bcd: true, min: 55, max: 59 },
    state,
  );
  assert.equal(invalid.pass, false);
  assert.match(invalid.detail, /invalid BCD/);
});

test('UART equalsChannel compares complete byte streams, not just prefixes', async () => {
  const { evaluateAssertion } = await import('./test-firmware-suite.mjs');
  const bytes = Buffer.from('{25-49%}{23-59-59}{0}\r\n', 'utf8');
  const equalState = {
    atMs: 4900,
    uart: { uart1Tx: [...bytes], probeTx: [...bytes] },
  };
  const equal = evaluateAssertion(
    { id: 'probe-equal', type: 'uart', channel: 'probeTx', atMs: 4900, equalsChannel: 'uart1Tx' },
    equalState,
  );
  assert.equal(equal.pass, true, JSON.stringify(equal));
  assert.equal(equal.actual.equal, true);
  assert.equal(equal.actual.referenceHex, Buffer.from(bytes).toString('hex'));
  assert.equal(equal.actual.referenceLength, bytes.length);

  const emptyState = { atMs: 4900, uart: { uart1Tx: [], probeTx: [] } };
  const empty = evaluateAssertion(
    { id: 'probe-empty', type: 'uart', channel: 'probeTx', atMs: 4900, equalsChannel: 'uart1Tx' },
    emptyState,
  );
  assert.equal(empty.pass, true, JSON.stringify(empty));
  assert.equal(empty.actual.referenceHex, '');
  assert.equal(empty.actual.referenceLength, 0);

  const middle = [...bytes];
  middle[5] ^= 0xff;
  const middleState = {
    atMs: 4900,
    uart: { uart1Tx: [...bytes], probeTx: middle },
  };
  const middleMismatch = evaluateAssertion(
    { id: 'probe-equal', type: 'uart', channel: 'probeTx', atMs: 4900, equalsChannel: 'uart1Tx' },
    middleState,
  );
  assert.equal(middleMismatch.pass, false);
  assert.equal(middleMismatch.actual.equal, false);
  assert.equal(middleMismatch.actual.length, bytes.length);
  assert.equal(middleMismatch.actual.referenceLength, bytes.length);
  assert.equal(middleMismatch.actual.referenceHex, Buffer.from(bytes).toString('hex'));
  assert.match(middleMismatch.detail, /probeTx != uart1Tx/);

  const mismatchState = {
    atMs: 4900,
    uart: { uart1Tx: [...bytes], probeTx: [...bytes.slice(0, -1)] },
  };
  const mismatch = evaluateAssertion(
    { id: 'probe-equal', type: 'uart', channel: 'probeTx', atMs: 4900, equalsChannel: 'uart1Tx' },
    mismatchState,
  );
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.actual.equal, false);
  assert.equal(mismatch.actual.referenceLength, bytes.length);
  assert.match(mismatch.detail, /probeTx != uart1Tx/);
});
