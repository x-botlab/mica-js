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
import type { Decl, Dependencies, Jit } from './state';
import type { RuntimeDiagnosticCode, RuntimePhase, SimulationError } from '../types';
import { bytesView, finite } from '../values';

/** Large programs dispatch through shards; small ones stay on the faster monolithic form. */
const DIRECT_SHARD_SIZE = 8;

/**
 * Deterministic direct-execution counters, kept on the `Jit` itself so `Board.jits` stays the
 * only diagnostic surface: the benchmark reads them instead of patching runtime internals.
 */
export interface DirectJitStats {
  /** Successful program builds; one per compile, so observer churn must not move it. */
  directCompiles: number;
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
      instance.host.intent(pin, value);
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
function createDirectFrame(
  board: JitRuntimeHost,
  instance: Instance,
  stateNames: readonly string[],
  memoryNames: readonly string[],
  program: DirectJitProgram,
  barrier: DirectBarriers,
): DirectJitFrame {
  const frame: DirectJitFrame = {
    states: new Array(stateNames.length),
    memories: memoryNames.map((name) => instance.memory(name)),
    locals: new Array(program.localCount),
    stateDirty: new Array(Math.ceil(stateNames.length / 32)).fill(0),
    memoryDirty: new Array(Math.ceil(memoryNames.length / 32)).fill(0),
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
    if (jit.directRevision !== jit.revision) {
      if (jit.directProgramRevision !== jit.revision) {
        jit.directPrograms.clear();
        jit.directProgramRevision = jit.revision;
      }
      // Guards stay out of the key: blocks test the barriers at entry, so one program serves
      // every observer set. Only the delay fold changes the emitted bodies within a revision,
      // and `directProgramRevision` clears this cache whenever a block is translated.
      const key = JSON.stringify([...jit.delays.keys()].sort((left, right) => left - right));
      const cached = jit.directPrograms.get(key);
      if (cached) {
        jit.direct = cached;
        jit.directRevision = jit.revision;
      } else {
        const stateNames = [...instance.states.keys()].filter((name) => {
          const declaration = instance.declarations.get(name) as Decl<'state'>;
          return declaration.type.kind === 'number' || declaration.type.kind === 'bool';
        });
        const memoryNames = [...instance.memories.keys()];
        const states = new Map(stateNames.map((name, index) => [name, index]));
        const memories = new Map(memoryNames.map((name, index) => [name, index]));
        const instructions = [...jit.cache.values()].filter(
          (instruction) => !instruction.polling && !jit.polling.has(instruction.pc),
        );
        /** Declared busy-wait heads fold their remaining rounds inside the emitted body. */
        const delayLoops = new Map<number, { counter: number; cycles: number }>();
        for (const [pc, delay] of jit.delays) {
          const counter = states.get(delay.counter);
          if (counter !== undefined) delayLoops.set(pc, { counter, cycles: delay.cycles });
        }
        const program = compileDirectJit(instructions, {
          states,
          memories,
          pc: { name: jit.options.pc, index: states.get(jit.options.pc)! },
          host: true,
          split: true,
          shardSize: DIRECT_SHARD_SIZE,
          delayLoops,
        });
        jit.directRevision = jit.revision;
        if (program) directStats(jit).directCompiles++;
        const barrier = directBarriers(jit);
        barrier.stateIndex = states;
        barrier.memoryIndex = memories;
        barrier.stateMask.length = Math.ceil(stateNames.length / 32);
        barrier.memoryMask.length = Math.ceil(memoryNames.length / 32);
        syncDirectBarriers(jit);
        jit.direct = program
          ? {
              program,
              stateReads: program.readStates.map((name) => [name, states.get(name)!] as const),
              stateWrites: program.writeStates.map((name) => [name, states.get(name)!] as const),
              memoryWrites: program.writeMemories.map(
                (name) => [name, memories.get(name)!] as const,
              ),
              revision: jit.revision,
              frame: createDirectFrame(board, instance, stateNames, memoryNames, program, barrier),
            }
          : undefined;
        // A declined program must not be cached, or the key would keep answering `undefined`.
        if (!jit.direct) jit.directPrograms.delete(key);
        // The key no longer carries the guard set, so one program covers every observer set:
        // the eight-slot cap (and its eviction churn) has nothing left to bound.
        else jit.directPrograms.set(key, jit.direct);
      }
    }
    if (!jit.direct) return false;
  }
  const direct = jit.direct!;
  const frame = direct.frame;
  if (pending) frame.stopAfterInstruction = true;
  for (const [name, index] of direct.stateReads) frame.states[index] = instance.states.get(name);
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
    for (const [name, index] of direct.stateWrites)
      if ((frame.stateDirty[index >>> 5]! & (1 << (index & 31))) !== 0) {
        instance.host.write(name, frame.states[index]);
        wrote = true;
      }
    for (const [name, index] of direct.memoryWrites)
      if ((frame.memoryDirty[index >>> 5]! & (1 << (index & 31))) !== 0) {
        instance.memoryChanged(name);
        wrote = true;
      }
  }
  // A frame that only dispatched an unknown PC changed no slot and advanced no time, so the
  // convergence pass would find nothing dirty to solve. The fallback re-enters the same
  // instruction on the interpreter path, whose own boundary converges the frame instead.
  if (reason !== 'fallback' || wrote || board.time !== start) board.boundary();
  if (reason === 'fallback') {
    stats.directFallbacks++;
    jit.directSkip = finite(instance.states.get(jit.options.pc), 'pc');
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
      const predicate = jit.polling.get(pc);
      if (predicate) {
        const checked = jit.instance.evaluate(() => jit.instance.syncCall(predicate));
        if (checked.value !== true) {
          jit.dependencies = pollingDependencies(
            jit,
            new Map([...(hookReads ?? []), ...checked.dependencies]),
          );
          jit.pollingWait = true;
          jit.pollingPeriod = 0;
          board.waitingJits.add(jit);
          board.boundary();
          return;
        }
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
