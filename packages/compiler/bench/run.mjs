import { performance } from 'node:perf_hooks';
import { compileBody, compileBodyArtifact } from '@mica-js/compiler';

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--smoke')) {
  throw new TypeError('Usage: pnpm bench [--smoke]');
}
const smoke = arguments_[0] === '--smoke';
const options = smoke
  ? { warmup: 100, iterations: 1_000, rounds: 64, samples: 3 }
  : { warmup: 2_000, iterations: 10_000, rounds: 128, samples: 5 };

/** @returns {import('@mica-js/device-model').RegionIR} */
function kernel(memory) {
  const number = { kind: 'number' };
  const bool = { kind: 'bool' };
  const operations = [];
  let nextResult = 0;
  const result = (target, operation, type = number) => {
    const id = nextResult++;
    target.push({ ...operation, type, result: id });
    return id;
  };
  const constant = (literal) =>
    result(operations, {
      kind: 'constant',
      constant: { kind: 'number', value: literal },
    });
  const binary = (target, operator, left, right, type = number) =>
    result(
      target,
      {
        kind: 'binary',
        operator,
        left,
        right,
      },
      type,
    );
  const localRead = (target, local) => result(target, { kind: 'localRead', local });
  const seed = result(operations, { kind: 'parameter', index: 0 });
  const rounds = result(operations, { kind: 'parameter', index: 1 });
  const zero = constant(0);
  const one = constant(1);
  const multiplier = constant(1_664_525);
  const increment = constant(1_013_904_223);
  const mask = memory ? constant(255) : undefined;
  const width = memory ? constant(4) : undefined;
  operations.push(
    { kind: 'local', local: 0, type: number, initial: zero },
    { kind: 'local', local: 1, type: number, initial: seed },
  );
  const test = [];
  const index = localRead(test, 0);
  const condition = binary(test, 'lessThan', index, rounds, bool);
  test.push({ kind: 'yield', value: condition });
  const body = [];
  const saved = localRead(body, 1);
  const product = binary(body, 'multiply', saved, multiplier);
  const sum = binary(body, 'add', product, increment);
  let next = binary(body, 'shiftRightUnsigned', sum, zero);
  const cursor = localRead(body, 0);
  if (memory) {
    const slot = binary(body, 'bitAnd', cursor, mask);
    const aligned = binary(body, 'multiply', slot, width);
    const offset = binary(body, 'add', aligned, one);
    body.push({
      kind: 'store32le',
      memory: { kind: 'parameter', resource: 'memory', index: 2 },
      offset,
      value: next,
      source: { label: 'benchmark unaligned little-endian store' },
    });
    next = result(body, {
      kind: 'load32be',
      memory: { kind: 'memory', name: 'ram' },
      offset,
      source: { label: 'benchmark unaligned big-endian load' },
    });
  }
  body.push({ kind: 'localWrite', local: 1, value: next });
  const following = binary(body, 'add', cursor, one);
  body.push({ kind: 'localWrite', local: 0, value: following });
  operations.push({
    kind: 'while',
    test: { type: bool, body: { operations: test } },
    body: { operations: body },
  });
  const final = localRead(operations, 1);
  operations.push({ kind: 'returnValue', value: final });
  return { operations };
}

function reference(seed, rounds, memory) {
  let value = seed;
  for (let i = 0; i < rounds; i++) {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    if (memory) {
      value =
        ((value >>> 24) | ((value >>> 8) & 0xff00) | ((value << 8) & 0xff0000) | (value << 24)) >>>
        0;
    }
  }
  return value;
}

function createHost() {
  const bytes = new Uint8Array(1_025);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unsupported = () => {
    throw new Error('Unexpected benchmark host operation');
  };
  const range = (memory, offset, width) => {
    if (memory !== 'ram') throw new TypeError('Unknown benchmark memory');
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset)) {
      throw new TypeError('Memory offset must be a safe integer number');
    }
    if (offset < 0 || offset > bytes.length || width > bytes.length - offset) {
      throw new RangeError('Memory access is outside the benchmark memory');
    }
  };
  return {
    read: unsupported,
    write: unsupported,
    sample: unsupported,
    intent: unsupported,
    resistor: unsupported,
    copyBytes: unsupported,
    memoryLength: unsupported,
    send: unsupported,
    notify: unsupported,
    now: unsupported,
    random: unsupported,
    call: unsupported,
    assert: unsupported,
    load(kind, memory, offset) {
      if (kind !== 'load32be') unsupported();
      range(memory, offset, 4);
      return view.getUint32(offset, false);
    },
    store(kind, memory, offset, value) {
      if (kind !== 'store32le') unsupported();
      range(memory, offset, 4);
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError('Memory write value must be a safe integer number');
      }
      view.setUint32(offset, value, true);
    },
  };
}

function invoke(execute, host, seed, rounds) {
  const result = execute(host, [seed, rounds, 'ram']).next();
  if (!result.done) throw new Error('Benchmark kernel unexpectedly suspended');
  return result.value;
}

function batch(execute, host, count, rounds) {
  let checksum = 0;
  for (let seed = 0; seed < count; seed++) {
    checksum = (checksum + invoke(execute, host, seed, rounds)) >>> 0;
  }
  return checksum;
}

function measure(memory) {
  const region = kernel(memory);
  const startCompile = performance.now();
  const execute = compileBody(region);
  const compileMs = performance.now() - startCompile;
  const startArtifact = performance.now();
  const artifact = compileBodyArtifact(region);
  const artifactMs = performance.now() - startArtifact;
  const startMetadata = performance.now();
  const graph = artifact.mir;
  const maps = [
    artifact.sourceMap,
    artifact.frameLayout,
    artifact.resumeMap,
    artifact.exitMap,
    artifact.dependencies,
  ];
  const metadataMs = performance.now() - startMetadata;
  if (graph !== artifact.mir || maps[1] !== artifact.frameLayout)
    throw new Error('Artifact metadata was not memoized');
  const host = createHost();
  for (const seed of [0, 1, 0xffff_ffff]) {
    if (
      invoke(execute, host, seed, options.rounds) !== reference(seed, options.rounds, memory) ||
      invoke(artifact.execute, host, seed, options.rounds) !==
        reference(seed, options.rounds, memory)
    ) {
      throw new Error('Benchmark kernel did not match the reference result');
    }
  }
  if (
    memory &&
    !artifact.positions.some((position) => position.kind === 'load32be' && position.source)
  ) {
    throw new Error('Memory source metadata is missing');
  }
  batch(execute, host, options.warmup, options.rounds);
  const elapsed = [];
  let checksum;
  for (let sample = 0; sample < options.samples; sample++) {
    const start = performance.now();
    const current = batch(execute, host, options.iterations, options.rounds);
    elapsed.push(performance.now() - start);
    if (checksum !== undefined && current !== checksum)
      throw new Error('Benchmark checksum changed');
    checksum = current;
  }
  let expected = 0;
  for (let seed = 0; seed < options.iterations; seed++) {
    expected = (expected + reference(seed, options.rounds, memory)) >>> 0;
  }
  if (checksum !== expected) throw new Error('Benchmark checksum did not match the reference');
  elapsed.sort((left, right) => left - right);
  const medianMs = elapsed[Math.floor(elapsed.length / 2)];
  const executionsPerSecond = (options.iterations * 1_000) / medianMs;
  return {
    kernel: memory ? 'arithmetic + memory' : 'arithmetic',
    'cold compile ms': compileMs.toFixed(3),
    'artifact build ms': artifactMs.toFixed(3),
    'lazy metadata ms': metadataMs.toFixed(3),
    'source chars': artifact.source.length,
    'warm median ms': medianMs.toFixed(3),
    'executions/s': Math.round(executionsPerSecond),
    'rounds/s': Math.round(executionsPerSecond * options.rounds),
    'memory accesses/s': memory ? Math.round(executionsPerSecond * options.rounds * 2) : '-',
    checksum: `0x${checksum.toString(16).padStart(8, '0')}`,
  };
}

console.log(`Compiler benchmark (${process.version}, ${smoke ? 'smoke' : 'default'})`);
console.log(JSON.stringify(options));
console.table([measure(false), measure(true)]);
console.log('Reference results, checksums and memory source metadata verified.');
