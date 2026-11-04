import type { ParameterTypeIR, ValueTypeIR } from '@mica-js/device-model';
import { typeSnapshot } from './analysis.js';
import type { BodyAnalysis, Node } from './analysis.js';
import type {
  ArtifactBinding,
  ArtifactDependencies,
  BaselinePosition,
  CompileOptions,
  ExitPoint,
  ExitReason,
  FrameLayout,
  FrameSlot,
  GeneratedRange,
  ResumeMap,
  ResumePoint,
  SourceMap,
} from './types.js';

export interface GeneratedTemporary {
  readonly key: string;
  readonly name: string;
  readonly region: number;
  readonly definition: number;
  readonly type: ValueTypeIR;
}

export function layoutMetadata(
  analysis: BodyAnalysis,
  ranges: ReadonlyMap<number, GeneratedRange>,
  resume: readonly ResumePoint[],
  source: string,
  options: CompileOptions,
  temporaries: readonly GeneratedTemporary[],
): {
  dependencies: ArtifactDependencies;
  sourceMap: SourceMap;
  frameLayout: FrameLayout;
  resumeMap: ResumeMap;
  exitMap: readonly ExitPoint[];
} {
  const slots: FrameSlot[] = [];
  const byKey = new Map<string, number>();
  const slotTypes = new Map<string, ParameterTypeIR>();
  for (const node of analysis.nodes) {
    const op = node.operation;
    if ('result' in op) slotTypes.set(`value:${op.result}`, typeSnapshot(op.type));
    if (op.kind === 'local') slotTypes.set(`local:${op.local}`, typeSnapshot(op.type));
    if (op.kind === 'parameter') slotTypes.set(`argument:${op.index}`, typeSnapshot(op.type));
    const resource = (ref: { kind: string; index?: number; resource?: 'pin' | 'memory' }): void => {
      if (ref.kind === 'parameter' && ref.resource)
        slotTypes.set(`argument:${ref.index}`, Object.freeze({ kind: ref.resource }));
    };
    if ('memory' in op) resource(op.memory);
    if ('pin' in op) resource(op.pin);
    if (op.kind === 'resistor') resource(op.to);
    if (op.kind === 'refEqual') {
      resource(op.left);
      resource(op.right);
    }
    if (op.kind === 'call' || op.kind === 'callValue')
      op.args.forEach((arg) => {
        if (arg.kind !== 'value') resource(arg);
      });
  }
  const slot = (
    key: string,
    kind: FrameSlot['kind'],
    name: string,
    region: number,
    definition: number | null,
    materialized = true,
  ): void => {
    if (byKey.has(key)) return;
    byKey.set(key, slots.length);
    slots.push(
      Object.freeze({
        id: slots.length,
        key,
        kind,
        name,
        region,
        definition,
        materialized,
        ...(slotTypes.has(key) ? { type: slotTypes.get(key)! } : {}),
      }),
    );
  };
  for (const node of analysis.nodes) {
    const op = node.operation;
    if ('result' in op)
      slot(
        `value:${op.result}`,
        'value',
        `v${op.result}`,
        node.region,
        node.position,
        !analysis.eliminated.has(node.position),
      );
    if (op.kind === 'local')
      slot(`local:${op.local}`, 'local', `l${op.local}`, node.region, node.position);
  }
  for (const temporary of temporaries) {
    slotTypes.set(temporary.key, typeSnapshot(temporary.type));
    slot(temporary.key, 'temporary', temporary.name, temporary.region, temporary.definition);
  }
  for (const block of analysis.graph.blocks)
    for (const key of [...block.uses, ...block.liveIn, ...block.baselineLiveIn]) {
      if (key.startsWith('argument:'))
        slot(key, 'argument', `args[${key.slice('argument:'.length)}]`, 0, null);
      if (key === 'reaction') slot(key, 'reaction', 'reaction', 0, null);
    }
  const materializations = Object.freeze(
    [...analysis.constants].flatMap(([result, value]) => {
      const id = byKey.get(`value:${result}`);
      return id === undefined
        ? []
        : [Object.freeze({ slot: id, kind: 'constant' as const, value })];
    }),
  );
  const materializedConstants = new Set(materializations.map((item) => item.slot));
  const requiredSlots = (keys: readonly string[]): readonly number[] =>
    Object.freeze(
      keys
        .flatMap((key) => {
          const id = byKey.get(key);
          return id === undefined ? [] : [id];
        })
        .sort((a, b) => a - b),
    );
  const captureSlots = (keys: readonly string[]): readonly number[] =>
    Object.freeze(
      requiredSlots(keys).filter((id) => slots[id]!.materialized && !materializedConstants.has(id)),
    );
  const liveSlots = (keys: readonly string[]): readonly number[] =>
    Object.freeze(
      keys
        .flatMap((key) => {
          const id = byKey.get(key);
          return id === undefined || !slots[id]!.materialized ? [] : [id];
        })
        .sort((a, b) => a - b),
    );
  const baseline = (
    node: Node,
    phase: BaselinePosition['phase'],
    block = node.block,
  ): BaselinePosition => Object.freeze({ position: node.position, block, phase });
  const nodeByPath = new Map(analysis.nodes.map((node) => [JSON.stringify(node.path), node]));
  const lines = source.split('\n');
  const lineRange = (line: number): GeneratedRange =>
    Object.freeze({
      start: Object.freeze({ line, column: (lines[line - 1]?.search(/\S/) ?? 0) + 1 }),
      end: Object.freeze({ line, column: (lines[line - 1]?.length ?? 0) + 1 }),
    });
  const resumeMap: ResumeMap = Object.freeze({
    entries: Object.freeze(
      resume.map((point) => {
        const node = nodeByPath.get(JSON.stringify(point.path))!;
        const terminal =
          node.operation.kind === 'redirect' ||
          node.operation.kind === 'stop' ||
          node.operation.kind === 'waitUntil';
        const keys = terminal ? [] : analysis.graph.blocks[node.resumeBlock!]!.liveIn;
        return Object.freeze({
          id: point.id,
          kind: point.kind,
          suspended: baseline(node, 'before'),
          baseline: baseline(
            node,
            point.delegated ? 'delegate' : 'after',
            node.resumeBlock ?? node.block,
          ),
          generated: lineRange(point.line),
          continuation: Object.freeze({
            line: point.delegated ? point.line : Math.min(point.line + 1, lines.length),
            column: point.delegated ? point.column : (lines[point.line]?.search(/\S/) ?? 0) + 1,
          }),
          liveSlots: liveSlots(keys),
          delegated: point.delegated,
          terminal,
        });
      }),
    ),
  });
  const exitMap: ExitPoint[] = [];
  const exit = (
    node: Node,
    reason: ExitReason,
    range: GeneratedRange,
    block = node.block,
  ): void => {
    exitMap.push(
      Object.freeze({
        baseline: baseline(node, 'before', block),
        reason,
        generated: range,
        requiredSlots: requiredSlots(analysis.graph.blocks[block]!.baselineLiveIn),
        captureSlots: captureSlots(analysis.graph.blocks[block]!.baselineLiveIn),
      }),
    );
  };
  for (const node of analysis.nodes) {
    const range = ranges.get(node.position);
    if (!range) continue;
    exit(node, 'deopt', lineRange(range.start.line));
    if (node.effects.mayThrow && !analysis.folded.has(node.position)) {
      if (node.operation.kind === 'assert') {
        let failureLine = range.start.line;
        for (let line = range.start.line; line <= range.end.line; line++)
          if (lines[line - 1]?.includes('host.assert(')) failureLine = line;
        exit(node, 'throw', lineRange(failureLine), node.failureBlock);
      } else exit(node, 'throw', lineRange(range.start.line));
    }
    if (node.operation.kind === 'return' || node.operation.kind === 'returnValue')
      exit(node, 'return', lineRange(range.start.line));
  }
  for (const point of resumeMap.entries) {
    const keys = point.terminal ? [] : analysis.graph.blocks[point.baseline.block]!.baselineLiveIn;
    exitMap.push(
      Object.freeze({
        baseline: point.baseline,
        reason:
          point.kind === 'redirect'
            ? ('redirect' as const)
            : point.kind === 'stop'
              ? ('stop' as const)
              : ('suspend' as const),
        generated: point.generated,
        requiredSlots: requiredSlots(keys),
        captureSlots: captureSlots(keys),
      }),
    );
  }
  for (const point of exitMap)
    for (const id of point.requiredSlots) {
      if (!slots[id]!.materialized && !materializedConstants.has(id)) {
        throw new Error(
          `Missing baseline value for frame slot ${id} at position ${point.baseline.position}`,
        );
      }
    }
  const binding: ArtifactBinding | null = options.binding
    ? Object.freeze({
        ...options.binding,
        ...(options.binding.instruction
          ? { instruction: Object.freeze({ ...options.binding.instruction }) }
          : {}),
      })
    : null;
  return {
    dependencies: Object.freeze({
      binding,
      reads: analysis.effects.reads,
      writes: analysis.effects.writes,
      calls: analysis.effects.calls,
      resources: analysis.resources,
      unresolvedCalls: analysis.effects.calls.length !== 0,
    }),
    sourceMap: Object.freeze({
      entries: Object.freeze(
        analysis.nodes.map((node) =>
          Object.freeze({
            position: node.position,
            block: node.block,
            path: node.path,
            kind: node.operation.kind,
            ...(node.source ? { source: node.source } : {}),
            generated: ranges.get(node.position) ?? null,
            eliminated: analysis.eliminated.has(node.position),
            folded: analysis.folded.has(node.position),
          }),
        ),
      ),
    }),
    frameLayout: Object.freeze({
      storage: 'native-generator',
      serializable: false,
      slots: Object.freeze(slots),
      materializations,
    }),
    resumeMap,
    exitMap: Object.freeze(exitMap),
  };
}
