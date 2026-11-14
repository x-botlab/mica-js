import {
  compileDirectJit,
  type DirectJitFrame,
  type DirectJitHost,
  type DirectJitProgram,
  type ExecutionSignal,
} from '@mica-js/compiler';
import { createJitBlockBuilder, validateBoundBlockIR } from '@mica-js/device-model';
import { isPollingInstruction } from '../polling';
import type { EventQueue } from '../queue';
import { acceptSync } from './errors';
import { body, time } from './execution';
import type { Instance, InstanceBoard } from './instance';
import type { Dependencies, DirectJitLayout, Jit } from './state';
import type { RuntimeDiagnosticCode, RuntimePhase, SimulationError } from '../types';
import { bytesView, finite } from '../values';

/** Large programs dispatch through shards; small ones stay on the faster monolithic form. */
const DIRECT_SHARD_SIZE = 8;
/**
 * Program size above which whole-program rebuilds are amortized instead of immediate.
 *
 * Translation only ever adds cache entries, so a compiled program stays valid for every PC it
 * already contains; only a missing PC needs a rebuild. Rebuilding on every new block is
 * quadratic, and that dominated warm-up on a real firmware image (411 blocks: 43 rebuilds and
 * ~1.7 s before any simulated time). Small programs rebuild in milliseconds, so they keep the
 * exact behaviour; only larger ones switch to a stride that grows with the program.
 */
const DIRECT_REBUILD_LINEAR_LIMIT = 16;
/** Stride floor once a program exceeds `DIRECT_REBUILD_LINEAR_LIMIT`. */
const DIRECT_REBUILD_MIN_BLOCKS = 64;
/** A PC that keeps falling back buys an early rebuild instead of waiting out a full stride. */
const DIRECT_REBUILD_PATIENCE = 512;

/**
 * Deterministic direct-execution counters, kept on the `Jit` itself so `Board.jits` stays the
 * only diagnostic surface: the benchmark reads them instead of patching runtime internals.
 */
export interface DirectJitStats {
  /** Successful program builds; one per compile, so observer churn must not move it. */
  directCompiles: number;
  /** Resident shard functions backing the current direct program. */
  directShards: number;
  directCalls: number;
  directFallbacks: number;
  directDeadlines: number;
  directStopped: number;
}

type CountedJit = Jit & { directStats?: DirectJitStats };

/** Word masks the compiled blocks test at entry; mutated in place, so programs stay valid. */
interface DirectBarriers {
  readonly stateMask: number[];
  readonly memoryMask: number[];
  /** Bank layout of the current program; absent until one has been compiled. */
  stateIndex?: ReadonlyMap<string, number>;
  memoryIndex?: ReadonlyMap<string, number>;
}

/** Frame fields `compileDirectJit` reads but `DirectJitFrame` does not declare. */
interface BarrierFrame extends DirectJitFrame {
  blockedStates?: number[];
  blockedMemories?: number[];
}

const barriers = new WeakMap<Jit, DirectBarriers>();

function directBarriers(jit: Jit): DirectBarriers {
  let entry = barriers.get(jit);
  if (entry === undefined) {
    entry = { stateMask: [], memoryMask: [] };
    barriers.set(jit, entry);
  }
  return entry;
}

function directStats(jit: Jit): DirectJitStats {
  const counted = jit as CountedJit;
  return (counted.directStats ??= {
    directCompiles: 0,
    directShards: 0,
    directCalls: 0,
    directFallbacks: 0,
    directDeadlines: 0,
    directStopped: 0,
  });
}

/** Direct-execution counters of one JIT; absent until the runtime attempted a direct run. */
export function directJitStats(jit: Jit): DirectJitStats | undefined {
  return (jit as CountedJit).directStats;
}

/** Publish the current guard sets into the masks the compiled blocks test at entry. */
function syncDirectBarriers(jit: Jit): void {
  const entry = directBarriers(jit);
  const { stateIndex, memoryIndex } = entry;
  if (stateIndex === undefined || memoryIndex === undefined) return;
  const fill = (
    mask: number[],
    index: ReadonlyMap<string, number>,
    guards: ReadonlySet<string>,
  ): void => {
    mask.fill(0);
    for (const name of guards) {
      const slot = index.get(name);
      if (slot === undefined) continue;
      mask[slot >>> 5] = (mask[slot >>> 5] ?? 0) | (1 << (slot & 31));
    }
  };
  fill(entry.stateMask, stateIndex, jit.directStateGuards);
  fill(entry.memoryMask, memoryIndex, jit.directMemoryGuards);
}

/** Scheduling capabilities needed by JIT execution; all queues remain board-owned. */
export interface JitRuntimeHost extends Pick<InstanceBoard, 'error'> {
  time: number;
  phase: string;
  current: Instance | undefined;
  readonly execution: 'throughput' | 'precise';
  readonly executionEnd: number;
  readonly jits: readonly Jit[];
  readonly waitingJits: Set<Jit>;
  readonly events: Pick<EventQueue<() => void>, 'time' | 'push'>;
  boundary(): void;
  queueJit(jit: Jit): void;
  wrap(
    cause: unknown,
    code: RuntimeDiagnosticCode,
    phase: RuntimePhase,
    instance?: Instance,
  ): SimulationError;
}

function refreshDirectGuards(jit: Jit, hookReads?: Dependencies): void {
  let changed = false;
  const instance = jit.instance;
  const hookCount = jit.directHookReads.size;
  // IRQ masking and short-circuit reads must not churn the compiled barrier set.
  if (hookReads) for (const slot of hookReads.keys()) jit.directHookReads.add(slot);
  if (
    jit.directObserverRevision === instance.observerRevision &&
    hookCount === jit.directHookReads.size
  )
    return;
  jit.directObserverRevision = instance.observerRevision;
  for (const [name, slot] of instance.stateResources) {
    const blocked = slot.subscribers.size > 0 || jit.directHookReads.has(slot);
    if (jit.directStateGuards.has(name) === blocked) continue;
    if (blocked) jit.directStateGuards.add(name);
    else jit.directStateGuards.delete(name);
    changed = true;
  }
  for (const [name, slot] of instance.memoryResources) {
    const blocked =
      slot.subscribers.size > 0 || jit.directHookReads.has(slot) || name === jit.options.code;
    if (jit.directMemoryGuards.has(name) === blocked) continue;
    if (blocked) jit.directMemoryGuards.add(name);
    else jit.directMemoryGuards.delete(name);
    changed = true;
  }
  if (changed) {
    // Guards no longer invalidate the program: the compiled blocks test these masks at entry,
    // so a membership change only flips individual blocks between direct and interpreted.
    syncDirectBarriers(jit);
    // A block that fell back while it was blocked may be eligible again.
    jit.directSkip = undefined;
  }
}
/**
 * Direct programs advance `frame.time` between host calls, while the board only adopts the
 * final time after `run` returns. Publish the current frame time before every host effect so
 * channel publications, electrical intents and diagnostics carry the instruction's time.
 */
function directHost(
  board: JitRuntimeHost,
  instance: Instance,
  frame: DirectJitFrame,
): DirectJitHost {
  const publishTime = (): void => {
    board.time = frame.time;
  };
  return {
    send: (name, value) => {
      publishTime();
      instance.host.send(name, value);
    },
    sample: (pin) => {
      publishTime();
      return instance.host.sample(pin);
    },
    intent: (pin, value) => {
      publishTime();
      const changed = instance.pin(pin).intent !== value;
      instance.host.intent(pin, value);
      if (changed) frame.publishPending = true;
    },
    resistor: (pin, resistance) => {
      publishTime();
      return instance.host.resistor(pin, resistance);
    },
    notify: (name) => {
      publishTime();
      instance.host.notify(name);
    },
    now: () => {
      publishTime();
      return instance.host.now();
    },
    random: () => {
      publishTime();
      return instance.host.random();
    },
    assert: (condition, message) => {
      publishTime();
      instance.host.assert(condition, message);
    },
  };
}

/** Build the numeric bank layout once; rebuilds then only need the cached instruction bodies. */
function directLayout(jit: Jit): DirectJitLayout {
  if (jit.directLayout !== undefined) return jit.directLayout;
  const instance = jit.instance;
  const bank = instance.directStateBank();
  const memoryNames = [...instance.memories.keys()];
  const memories = new Map(memoryNames.map((name, index) => [name, index]));
  const memoryBanks = memoryNames.map((name) => instance.memory(name));
  const memoryViews = memoryBanks.map(
    (memory) => new DataView(memory.buffer, memory.byteOffset, memory.byteLength),
  );
  jit.directLayout = {
    ...bank,
    memoryNames: Object.freeze(memoryNames),
    memories,
    memoryBanks: Object.freeze(memoryBanks),
    memoryViews: Object.freeze(memoryViews),
  };
  return jit.directLayout;
}

function createDirectFrame(
  board: JitRuntimeHost,
  instance: Instance,
  layout: DirectJitLayout,
  program: DirectJitProgram,
  barrier: DirectBarriers,
): DirectJitFrame {
  const frame: DirectJitFrame = {
    states: layout.stateValues,
    memories: [...layout.memoryBanks],
    memoryViews: layout.memoryViews,
    locals: new Array(program.localCount),
    stateDirty: new Array(Math.ceil(layout.stateNames.length / 32)).fill(0),
    memoryDirty: new Array(Math.ceil(layout.memoryNames.length / 32)).fill(0),
    time: board.time,
    due: board.time,
    resume: 0,
  };
  (frame as { host?: DirectJitHost }).host = directHost(board, instance, frame);
  // Both masks are shared with every frame of this JIT and refreshed in place on guard churn.
  (frame as BarrierFrame).blockedStates = barrier.stateMask;
  (frame as BarrierFrame).blockedMemories = barrier.memoryMask;
  return frame;
}
function runDirect(board: JitRuntimeHost, jit: Jit, hookReads?: Dependencies): boolean {
  const instance = jit.instance;
  const pending = Boolean(jit.direct?.frame.resume);
  if (!pending) {
    const pc = finite(instance.states.get(jit.options.pc), 'pc');
    if (
      board.execution !== 'throughput' ||
      board.jits.length !== 1 ||
      jit.polling.has(pc) ||
      jit.cache.get(pc)?.polling
    )
      return false;
    refreshDirectGuards(jit, hookReads);
    if (jit.directSkip === pc) return false;
    // A newer revision only adds cache entries: bodies of already compiled PCs never change,
    // so the current program keeps running as long as it covers this PC. Rebuilds are
    // amortized over a stride of new blocks, but a stride always catches up eventually:
    // otherwise a PC that runs once would stay uncompiled and its neighbours would keep
    // falling back on every visit.
    if (jit.directRevision !== jit.revision) {
      const compiled = jit.direct?.pcs.size ?? 0;
      const stale = jit.revision - jit.directRevision;
      const stride =
        compiled < DIRECT_REBUILD_LINEAR_LIMIT ? 1 : Math.max(DIRECT_REBUILD_MIN_BLOCKS, compiled);
      const covered = jit.direct?.pcs.has(pc) === true;
      const rebuild =
        jit.direct === undefined ||
        stale >= stride ||
        (!covered && jit.directMisses >= DIRECT_REBUILD_PATIENCE);

      if (!rebuild) {
        if (!covered) {
          // The interpreter runs this instruction; the catch-up rebuild picks it up. It is
          // still a direct attempt that fell back, so the counters keep describing "how many
          // dispatches reached the compiled program" rather than where the decision was made.
          const stats = directStats(jit);
          stats.directCalls++;
          stats.directFallbacks++;
          jit.directMisses += 1;

          return false;
        }
        // Covered: reuse the current program and fall through to the shared execution tail.
      } else {
        if (jit.directProgramRevision !== jit.revision) {
          // Code-memory replacement resets this marker to -1. The translated cache is gone, so
          // cached instruction bodies must go with it; old programs stay self-contained.
          if (jit.directProgramRevision === -1 && jit.directCache !== undefined)
            compileDirectJit.clearCache(jit.directCache);
          jit.directPrograms.clear();
          jit.directProgramRevision = jit.revision;
        }
        const layout = directLayout(jit);
        const instructions = [...jit.cache.values()].filter(
          (instruction) => !instruction.polling && !jit.polling.has(instruction.pc),
        );
        /** Declared busy-wait heads fold their remaining rounds inside the emitted body. */
        const delayLoops = new Map<
          number,
          {
            counter: number;
            cycles: number;
            pending?: { state: number; period: number; active: number };
          }
        >();
        for (const [headPc, delay] of jit.delays) {
          const counter = layout.states.get(delay.counter);
          if (counter === undefined) continue;
          const pending =
            delay.pending === undefined
              ? undefined
              : {
                  state: layout.states.get(delay.pending.state),
                  period: layout.states.get(delay.pending.period),
                  active: layout.states.get(delay.pending.active),
                };
          delayLoops.set(
            headPc,
            pending !== undefined &&
              pending.state !== undefined &&
              pending.period !== undefined &&
              pending.active !== undefined
              ? { counter, cycles: delay.cycles, pending: pending as never }
              : { counter, cycles: delay.cycles },
          );
        }
        // Guards stay out of the key: blocks test the barriers at entry, so one program serves
        // every observer set. The full delay descriptor participates because it changes the
        // emitted guard; translation revision changes still clear the program cache.
        const key = JSON.stringify([...delayLoops].sort(([left], [right]) => left - right));
        const cached = jit.directPrograms.get(key);
        if (cached) {
          jit.direct = cached;
          jit.directRevision = jit.revision;
        } else {
          const { states, memories } = layout;
          const cache = (jit.directCache ??= compileDirectJit.createCache());
          const program = compileDirectJit(
            instructions,
            {
              states,
              memories,
              pc: { name: jit.options.pc, index: states.get(jit.options.pc)! },
              host: true,
              split: true,
              shardSize: DIRECT_SHARD_SIZE,
              delayLoops,
            },
            cache,
          );
          jit.directRevision = jit.revision;
          jit.directMisses = 0;
          const stats = directStats(jit);

          stats.directShards = program?.shards ?? 0;
          if (program) stats.directCompiles++;
          const barrier = directBarriers(jit);
          barrier.stateIndex = states;
          barrier.memoryIndex = memories;
          barrier.stateMask.length = Math.ceil(layout.stateNames.length / 32);
          barrier.memoryMask.length = Math.ceil(layout.memoryNames.length / 32);
          syncDirectBarriers(jit);
          jit.direct = program
            ? {
                program,
                pcs: new Set(program.pcs),
                revision: jit.revision,
                frame: createDirectFrame(board, instance, layout, program, barrier),
              }
            : undefined;
          // A declined program must not be cached, or the key would keep answering `undefined`.
          if (!jit.direct) jit.directPrograms.delete(key);
          // The key no longer carries the guard set, so one program covers every observer set:
          // the eight-slot cap (and its eviction churn) has nothing left to bound.
          else jit.directPrograms.set(key, jit.direct);
        }
      }
    }
    if (!jit.direct) return false;
  }
  const direct = jit.direct!;
  const frame = direct.frame;
  if (pending) frame.stopAfterInstruction = true;
  frame.time = board.time;
  frame.stateDirty.fill(0);
  frame.memoryDirty.fill(0);
  const start = board.time;
  let reason: ReturnType<DirectJitProgram['run']>;
  let wrote = false;
  const stats = directStats(jit);
  stats.directCalls++;
  try {
    // Resource barriers exclude intermediate observers; real events retain exact deadlines.
    reason = direct.program.run(frame, Math.min(board.executionEnd, board.events.time));
  } finally {
    board.time = frame.time;
    frame.publishPending = false;
    const layout = jit.directLayout!;
    for (let word = 0; word < frame.stateDirty.length; word++) {
      let bits = frame.stateDirty[word]!;
      while (bits !== 0) {
        const slot = word * 32 + 31 - Math.clz32(bits & -bits);
        instance.host.write(layout.stateNames[slot]!, frame.states[slot]);
        bits &= bits - 1;
        wrote = true;
      }
    }
    for (let word = 0; word < frame.memoryDirty.length; word++) {
      let bits = frame.memoryDirty[word]!;
      while (bits !== 0) {
        const slot = word * 32 + 31 - Math.clz32(bits & -bits);
        instance.memoryChanged(layout.memoryNames[slot]!);
        bits &= bits - 1;
        wrote = true;
      }
    }
  }
  // A frame that only dispatched an unknown PC changed no slot and advanced no time, so the
  // convergence pass would find nothing dirty to solve. The fallback re-enters the same
  // instruction on the interpreter path, whose own boundary converges the frame instead.
  if (reason !== 'fallback' || wrote || board.time !== start) board.boundary();
  if (reason === 'fallback') {
    const nextPc = finite(instance.states.get(jit.options.pc), 'pc');
    // Polling PCs are deliberately absent from direct programs. Reaching one is a normal
    // shard boundary, not a failed direct dispatch, so it must neither compound fallback
    // statistics nor poison the next interpreter attempt for this PC.
    const polling = jit.polling.has(nextPc) || jit.cache.get(nextPc)?.polling;
    if (!polling) {
      stats.directFallbacks++;
      jit.directSkip = nextPc;
    }
    if (board.time === start && board.time < board.executionEnd) return false;
  } else if (reason === 'stopped') {
    stats.directStopped++;
    jit.stopped = true;
    return true;
  } else if (reason === 'invalidated') {
    frame.stopAfterInstruction = false;
    if (direct.revision !== jit.revision) {
      jit.direct = undefined;
      jit.directRevision = -1;
    }
  } else stats.directDeadlines++;
  if (frame.resume && frame.due > board.time)
    board.events.push(frame.due, () => board.queueJit(jit));
  else board.queueJit(jit);
  return true;
}
function pollingDependencies(jit: Jit, dependencies: Dependencies): Dependencies {
  const result = new Map(dependencies);
  const instance = jit.instance;
  for (const slot of [
    instance.stateResources.get(jit.options.pc)!,
    instance.memoryResources.get(jit.options.code)!,
  ])
    result.set(slot, slot.version);
  return result;
}

/** Park a polling JIT and, when requested, schedule the next device time event. */
function waitForPolling(
  board: JitRuntimeHost,
  jit: Jit,
  dependencies: Dependencies,
  duration: number,
  advance: string | undefined,
): void {
  jit.dependencies = dependencies;
  jit.pollingWait = true;
  jit.pollingPeriod = 0;
  board.waitingJits.add(jit);
  const token = ++jit.pollingToken;

  board.boundary();
  if (duration === 0 || advance === undefined) return;
  const due = time(board.time + duration);

  board.events.push(due, () => {
    if (token !== jit.pollingToken || !jit.active || jit.stopped || !board.waitingJits.has(jit))
      return;
    const pending = jit.dependencies;

    jit.pollingWait = false;
    delete jit.dependencies;
    board.waitingJits.delete(jit);
    jit.pollingToken++;
    board.current = jit.instance;
    // An external event won the race at the same timestamp. Re-evaluate the guest rather
    // than applying a device step against a configuration that has already changed.
    if (!jit.instance.dependenciesCurrent(pending)) {
      board.queueJit(jit);
      return;
    }
    jit.instance.syncCall(advance, [duration]);
    board.boundary();
    board.queueJit(jit);
  });
}

function jitSignal(board: JitRuntimeHost, jit: Jit, signal: ExecutionSignal): boolean {
  if (signal.kind === 'elapse') {
    const duration = time(signal.duration);
    if (duration === 0) return false;
    const due = time(board.time + duration);
    board.events.push(due, () => board.queueJit(jit));
    board.boundary();
    return true;
  }
  if (signal.kind === 'waitUntil') {
    const checked = jit.instance.evaluate(() => jit.instance.syncCall(signal.predicate));
    if (checked.value === true) return false;
    jit.predicate = signal.predicate;
    jit.pollingWait = false;
    jit.dependencies = checked.dependencies;
    board.waitingJits.add(jit);
    board.boundary();
    return true;
  }
  if (signal.kind === 'stop') {
    jit.stopped = true;
    jit.execution = undefined;
    board.boundary();
    return true;
  }
  if (signal.kind === 'redirect') {
    finite(signal.pc, 'redirect target');
    const duration = time(signal.delay);
    jit.instance.host.write(jit.options.pc, signal.pc);
    jit.execution = undefined;
    const polling =
      jit.automaticPolling && duration > 0 && signal.pc === jit.currentPc && jit.pollReads;
    const dependencies = polling ? pollingDependencies(jit, polling) : undefined;
    jit.automaticPolling = false;
    jit.pollReads = undefined;
    board.boundary();
    if (duration === 0) board.queueJit(jit);
    else
      board.events.push(time(board.time + duration), () => {
        if (!jit.active || jit.stopped) return;
        if (dependencies && jit.instance.dependenciesCurrent(dependencies)) {
          jit.dependencies = dependencies;
          jit.pollingWait = true;
          jit.pollingPeriod = duration;
          jit.pollingOrigin = board.time;
          board.waitingJits.add(jit);
        } else board.queueJit(jit);
      });
    return true;
  }
  throw new TypeError('Invalid JIT suspension');
}
export function runJit(board: JitRuntimeHost, jit: Jit): void {
  jit.queued = false;
  if (!jit.active || jit.stopped) return;
  board.current = jit.instance;
  if (jit.direct?.frame.resume) {
    runDirect(board, jit);
    return;
  }
  if (!jit.execution) {
    jit.automaticPolling = false;
    jit.pollReads = undefined;
    let hookReads: Dependencies | undefined;
    let hookPending = false;
    const hook = jit.options.beforeInstruction;
    if (hook) {
      const kind = jit.instance.declarations.get(hook.when)!.kind;
      const priorPc = jit.instance.states.get(jit.options.pc) as number;
      const collect =
        board.execution === 'throughput' && (board.jits.length === 1 || jit.polling.has(priorPc));
      const checked = collect
        ? jit.instance.evaluate(() => jit.instance.read(kind, hook.when))
        : undefined;
      const handled = (checked ? checked.value : jit.instance.read(kind, hook.when)) === true;
      if (handled) {
        const execution = jit.instance.invoke(hook.call);
        const step = execution.next();
        if (!step.done) {
          jit.execution = execution;
          if (jitSignal(board, jit, step.value)) return;
          throw new TypeError('Invalid hook suspension');
        }
      }
      hookReads = checked?.dependencies;
      hookPending = handled;
    }
    const pc = finite(jit.instance.states.get(jit.options.pc), 'pc');
    if (board.execution === 'throughput') {
      const declaration = jit.polling.get(pc);
      if (declaration) {
        const checked = jit.instance.evaluate(() => jit.instance.syncCall(declaration.predicate));
        if (checked.value !== true) {
          const dependencies = new Map([...(hookReads ?? []), ...checked.dependencies]);
          let duration = 0;
          const wait = declaration.wait;
          if (wait) {
            const delayed = jit.instance.evaluate(
              () => jit.instance.syncCall(wait.delay),
              dependencies,
            );
            duration = time(delayed.value);
          }
          waitForPolling(
            board,
            jit,
            pollingDependencies(jit, dependencies),
            duration,
            wait?.advance,
          );
          return;
        }
        if (declaration.consume) jit.instance.syncCall(declaration.consume);
      }
      if (!hookPending && board.jits.length === 1 && runDirect(board, jit, hookReads)) return;
    }
    let instruction = jit.cache.get(pc);
    if (!instruction) {
      const prior = board.phase;
      board.phase = 'translate';
      let valid = true;
      try {
        const code = bytesView(jit.instance.memory(jit.options.code), () => {
          if (!valid)
            throw board.error('OBJECT_DISPOSED', 'Translation view expired', jit.instance);
        });
        const result = jit.options.translate(
          Object.freeze({ pc, code: code as import('../types').BorrowedBytes }),
          createJitBlockBuilder({ device: jit.instance.entry.model }),
        );
        acceptSync(result);
        const block = validateBoundBlockIR(result, jit.instance.entry.model);
        if (block.instructions[0]?.pc !== pc)
          throw new TypeError('Translated first pc does not match');
        const instructions = block.instructions.map((instruction) => ({
          pc: instruction.pc,
          nextPc: instruction.nextPc,
          body: instruction.body,
          polling: isPollingInstruction(instruction.body, instruction.pc, jit.options.pc),
          execute: body(instruction.body),
        }));
        // Match the first instruction when a block contains a repeated PC.
        for (let index = instructions.length - 1; index >= 0; index--) {
          const entry = instructions[index]!;
          jit.cache.set(entry.pc, entry);
        }
        jit.revision++;
        jit.directSkip = undefined;
        instruction = instructions[0]!;
      } catch (cause) {
        throw board.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
      } finally {
        valid = false;
        board.phase = prior;
      }
    }
    jit.currentPc = pc;
    jit.automaticPolling =
      board.execution === 'throughput' &&
      board.jits.length === 1 &&
      instruction.polling &&
      !hookPending &&
      (!hook || hookReads !== undefined);
    jit.pollReads = hookReads;
    jit.instance.host.write(jit.options.pc, instruction.nextPc);
    jit.execution = instruction.execute(jit.instance.host);
  }
  for (;;) {
    const step = jit.automaticPolling
      ? (() => {
          const checked = jit.instance.evaluate(() => jit.execution!.next());
          jit.pollReads = new Map([...(jit.pollReads ?? []), ...checked.dependencies]);
          return checked.value;
        })()
      : jit.execution.next();
    if (step.done) {
      jit.execution = undefined;
      board.boundary();
      board.queueJit(jit);
      return;
    }
    if (jitSignal(board, jit, step.value)) return;
  }
}
