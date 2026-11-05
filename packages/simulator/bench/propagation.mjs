import assert from 'node:assert/strict';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDDL } from '@mica-js/ddl';
import { createBoard, createDeviceLibrary } from '../dist/index.js';

function parseOptions(args) {
  const options = { sizes: [1, 4, 16, 64], samples: 20, warmup: 3, rounds: 100 };
  const seen = new Set();
  for (const argument of args) {
    if (argument === '--help') {
      console.log(
        'Usage: node packages\\simulator\\bench\\propagation.mjs ' +
          '[--sizes=1,4,16,64] [--samples=20] [--warmup=3] [--rounds=100]\n' +
          'Sizes: 1-4 distinct fanouts in [1,64]; samples [1,200], warmup [1,20], ' +
          'rounds per advance [1,1000]. JSON stdout; no SDK instrumentation.',
      );
      return null;
    }
    const match = /^--(sizes|samples|warmup|rounds)=(\d+(?:,\d+)*)$/.exec(argument);
    assert.ok(match, `Unknown or malformed argument: ${argument}`);
    const [, name, value] = match;
    assert.ok(!seen.has(name), `Duplicate option: ${name}`);
    seen.add(name);
    if (name === 'sizes') options.sizes = value.split(',').map(Number);
    else {
      assert.ok(!value.includes(','), `${name} requires one integer`);
      options[name] = Number(value);
    }
  }
  assert.ok(options.sizes.length >= 1 && options.sizes.length <= 4);
  assert.equal(new Set(options.sizes).size, options.sizes.length);
  assert.ok(options.sizes.every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 64));
  for (const [name, maximum] of [
    ['samples', 200],
    ['warmup', 20],
    ['rounds', 1000],
  ]) {
    assert.ok(
      Number.isSafeInteger(options[name]) && options[name] >= 1 && options[name] <= maximum,
    );
  }
  const transitions = (options.samples + options.warmup) * options.rounds;
  assert.ok(
    transitions * options.sizes.reduce((sum, size) => sum + size, 0) <= 2e6,
    'Combined workload exceeds two million receiver transitions',
  );

  return options;
}

/** Compile once outside timing. Each create(sdk, { size }) owns its library,
 * board, adapters and evidence. Call run() then verify() for each step; only run()
 * belongs inside a timing window. verify() checks and clears that step's evidence.
 */
export async function preparePropagation({ rounds = 100, steps = 1 } = {}) {
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 1000);
  assert.ok(Number.isSafeInteger(steps) && steps >= 1);
  const transitions = rounds * steps;
  assert.ok(Number.isSafeInteger(transitions) && transitions <= 2e6);
  const sources = {
    sender: `device Sender {
    pin supply;
    pin reference;
    pin signal = [resistor(to: reference, resistance: 1000)];
    process start {
      let ordinal = 0;
      while ordinal < ${transitions} {
        await ticks(3 + ordinal % 5);
        if ordinal % 2 == 0 {
          signal.intent <- [resistor(to: supply, resistance: 1000)];
        } else {
          signal.intent <- [resistor(to: reference, resistance: 1000)];
        }
        ordinal = ordinal + 1;
      }
    }
  }`,
    receiver: `device Receiver {
    pin supply;
    pin reference;
    pin signal(low: 0.8, high: 2.0);
    pin relay(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
    state count: number = 0;
    record Reading {
      phase: number;
      before: number;
      after: number;
      captured: number;
      live: number;
      relayBefore: bool;
    }
    output channel out: Reading(capacity: ${rounds * 2});
    pure fn signalBit() -> number {
      if signal.sample.level == Logic.high { return 1; }
      return 0;
    }
    derived bit: number = signalBit();
    reaction direct on signal.sample.level as (previous, current) { count = count + 1; }
    reaction first on bit as (previous, current) capture saved = count, peer = relay.sample.level == Logic.high {
      if current == 1 { relay.intent <- [resistor(to: supply, resistance: 1000)]; }
      else { relay.intent <- [resistor(to: reference, resistance: 1000)]; }
      out.send({phase: 2, before: previous, after: current, captured: saved, live: count, relayBefore: peer});
    }
    reaction second on bit as (previous, current) capture saved = count, peer = relay.sample.level == Logic.high {
      assert peer == (relay.sample.level == Logic.high);
      out.send({phase: 3, before: previous, after: current, captured: saved, live: count, relayBefore: peer});
    }
  }`,
    sink: `device Sink {
    pin signal(low: 0.8, high: 2.0);
    state count: number = 0;
    record Reading { ordinal: number; before: number; after: number; }
    output channel out: Reading(capacity: ${rounds});
    pure fn signalBit() -> number {
      if signal.sample.level == Logic.high { return 1; }
      return 0;
    }
    derived bit: number = signalBit();
    reaction observe on bit as (previous, current) {
      count = count + 1;
      out.send({ordinal: count, before: previous, after: current});
    }
  }`,
  };
  const compileStart = performance.now();
  const models = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([name, source]) => [name, await compileDDL(source)]),
    ),
  );
  const compileMs = performance.now() - compileStart;
  const endpoint = (instance, pin) => ({ instance, pin });
  const times = [];
  let time = 0;
  for (let index = 0; index < transitions; index++) {
    time += 3 + (index % 5);
    times.push(time);
  }
  return {
    compileMs,
    rounds,
    steps,
    create(sdk, { size = 1 } = {}) {
      assert.equal(typeof sdk.createBoard, 'function');
      assert.equal(typeof sdk.createDeviceLibrary, 'function');
      assert.ok(Number.isSafeInteger(size) && size >= 1 && size <= 64);
      assert.ok(transitions * size <= 2e6, 'Scenario exceeds two million receiver transitions');
      const receivers = Array.from({ length: size }, (_, index) => `receiver-${index}`);
      const sinks = Array.from({ length: size }, (_, index) => `sink-${index}`);
      const ids = ['sender', ...receivers, ...sinks];
      const received = Object.fromEntries([...receivers, ...sinks].map((id) => [id, []]));
      const counts = Object.fromEntries([...receivers, ...sinks].map((id) => [id, 0]));
      let factoryIndex = 0;
      const library = sdk.createDeviceLibrary(
        Object.entries(models).map(([id, model]) => ({
          id,
          model,
          create() {
            const instance = ids[factoryIndex++];
            return {
              sync(batch) {
                if (instance === 'sender') return;
                received[instance].push(...batch.outputs.out);
                counts[instance] += batch.outputs.out.length;
              },
              dispose() {},
            };
          },
        })),
      );
      const assemblyStart = performance.now();
      const board = sdk.createBoard(library, {
        instances: [
          { id: 'sender', type: 'sender' },
          ...receivers.map((id) => ({ id, type: 'receiver' })),
          ...sinks.map((id) => ({ id, type: 'sink' })),
        ],
        nets: [
          ...[
            ['supply', 3.3],
            ['reference', 0],
          ].map(([pin, voltage]) => ({
            id: pin,
            voltage,
            pins: ['sender', ...receivers].map((id) => endpoint(id, pin)),
          })),
          { id: 'fanout', pins: ['sender', ...receivers].map((id) => endpoint(id, 'signal')) },
          ...receivers.map((id, index) => ({
            id: `downstream-${index}`,
            pins: [endpoint(id, 'relay'), endpoint(sinks[index], 'signal')],
          })),
        ],
      });
      const assemblyMs = performance.now() - assemblyStart;
      let initialAdvanceMs;
      try {
        const initialStart = performance.now();
        board.runUntil(0);
        initialAdvanceMs = performance.now() - initialStart;
        assert.equal(factoryIndex, ids.length);
        assert.equal(board.time, 0);
        assert.equal(board.status, 'ready');
        assert.ok(Object.values(received).every((messages) => messages.length === 0));
      } catch (error) {
        board.dispose();
        throw error;
      }
      let completedSteps = 0;
      let pendingVerification = false;
      let disposed = false;
      return {
        size,
        rounds,
        steps,
        instances: ids.length,
        operations: rounds * size,
        reactionBodies: rounds * size * 4,
        outputMessages: rounds * size * 3,
        assemblyMs,
        initialAdvanceMs,
        run() {
          assert.ok(!disposed, 'Scenario is disposed');
          assert.ok(!pendingVerification, 'Verify the previous step before running again');
          assert.ok(completedSteps < steps, 'Scenario has no remaining steps');
          board.runUntil(times[(completedSteps + 1) * rounds - 1]);
          completedSteps++;
          pendingVerification = true;
        },
        verify() {
          assert.ok(!disposed, 'Scenario is disposed');
          assert.ok(pendingVerification, 'Run one step before verifying');
          const begin = (completedSteps - 1) * rounds;
          const end = completedSteps * rounds;
          let actualChecksum = 0;
          let expectedChecksum = 0;
          assert.equal(board.time, times[end - 1]);
          assert.equal(board.status, 'ready');
          for (let receiver = 0; receiver < size; receiver++) {
            const upstream = received[receivers[receiver]];
            const downstream = received[sinks[receiver]];
            assert.equal(upstream.length, rounds * 2);
            assert.equal(downstream.length, rounds);
            assert.equal(counts[receivers[receiver]], end * 2);
            assert.equal(counts[sinks[receiver]], end);
            for (let index = begin; index < end; index++) {
              const after = (index + 1) % 2;
              const before = 1 - after;
              const offset = index - begin;
              for (let phase = 2; phase <= 3; phase++) {
                const message = upstream[offset * 2 + phase - 2];
                assert.deepEqual(message, {
                  time: times[index],
                  value: {
                    phase,
                    before,
                    after,
                    captured: index,
                    live: index + 1,
                    relayBefore: before === 1,
                  },
                });
                actualChecksum +=
                  (receiver + 1) *
                  (message.time +
                    message.value.phase +
                    message.value.captured +
                    message.value.live +
                    message.value.after);
                expectedChecksum +=
                  (receiver + 1) * (times[index] + phase + index + index + 1 + after);
              }
              const message = downstream[offset];
              assert.deepEqual(message, {
                time: times[index],
                value: { ordinal: index + 1, before, after },
              });
              actualChecksum +=
                (receiver + 1) * (message.time + message.value.ordinal + message.value.after);
              expectedChecksum += (receiver + 1) * (times[index] + index + 1 + after);
            }
          }
          assert.equal(actualChecksum, expectedChecksum);
          assert.ok(Number.isSafeInteger(actualChecksum));
          for (const messages of Object.values(received)) messages.length = 0;
          pendingVerification = false;
          return {
            completedSteps,
            time: times[end - 1],
            receiverMessagesEach: end * 2,
            downstreamMessagesEach: end,
            actualChecksum,
            expectedChecksum,
          };
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          board.dispose();
        },
      };
    },
  };
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { min: sorted[0], median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  const steps = options.warmup + options.samples;
  const prepared = await preparePropagation({ rounds: options.rounds, steps });
  const results = [];
  for (const size of options.sizes) {
    const scenario = prepared.create({ createBoard, createDeviceLibrary }, { size });
    const elapsed = [];
    let actualChecksum = 0;
    let expectedChecksum = 0;
    let evidence;
    try {
      for (let step = 0; step < steps; step++) {
        const start = performance.now();
        scenario.run();
        const duration = performance.now() - start;
        evidence = scenario.verify();
        if (step >= options.warmup) {
          elapsed.push(duration);
          actualChecksum += evidence.actualChecksum;
          expectedChecksum += evidence.expectedChecksum;
        }
      }
      assert.equal(actualChecksum, expectedChecksum);
      assert.ok(Number.isSafeInteger(actualChecksum));
      const totalMs = elapsed.reduce((sum, value) => sum + value, 0);
      const measuredOperations = options.samples * scenario.operations;
      results.push({
        name: 'cross-device-propagation',
        size,
        unit: 'receiver transitions',
        measuredOperations,
        operationsPerSecond: (measuredOperations * 1000) / totalMs,
        medianMs: summary(elapsed).median,
        fanout: size,
        instances: scenario.instances,
        assemblyMs: scenario.assemblyMs,
        initialAdvanceMs: scenario.initialAdvanceMs,
        advanceMs: summary(elapsed),
        totalAdvanceMs: totalMs,
        measuredSenderTransitions: options.samples * options.rounds,
        measuredReactionBodies: options.samples * scenario.reactionBodies,
        measuredOutputMessages: options.samples * scenario.outputMessages,
        receiverTransitionsPerSecond: (measuredOperations * 1000) / totalMs,
        correctness: {
          verifiedAllMessages: true,
          verifiedSteps: evidence.completedSteps,
          finalTime: evidence.time,
          receiverMessagesEach: evidence.receiverMessagesEach,
          downstreamMessagesEach: evidence.downstreamMessagesEach,
          actualChecksum,
          expectedChecksum,
        },
      });
    } finally {
      scenario.dispose();
    }
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          v8: process.versions.v8,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        options,
        workload:
          'one finite sender -> shared electrical fanout -> independent receiver relays -> downstream sink instances',
        timing:
          'Same board after warmup; scenario.run() includes runUntil, constant-time sequence guards/cursor updates and real adapter output collection only. DDL, assembly, initialization, array clearing and exact per-message verification excluded from steady timing. Rounds are positive-time sender transitions; each includes two electrical publication rounds and four reaction bodies per receiver/sink pair.',
        compileMs: prepared.compileMs,
        results,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
