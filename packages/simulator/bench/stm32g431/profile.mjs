import { performance } from 'node:perf_hooks';
import { compileDirectJit } from '../../../compiler/dist/index.js';

function operations(region, visit) {
  for (const operation of region.operations) {
    visit(operation);
    for (const value of Object.values(operation)) {
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value.operations)) operations(value, visit);
      else if (value.body?.operations) operations(value.body, visit);
      else if (Array.isArray(value)) {
        for (const item of value) if (item?.body?.operations) operations(item.body, visit);
      }
    }
  }
}

export function profileInstructions(instructions, model) {
  const states = model.declarations
    .filter((d) => d.kind === 'state' && ['number', 'bool'].includes(d.type.kind))
    .map((d) => d.name);
  const memories = model.declarations.filter((d) => d.kind === 'memory').map((d) => d.name);
  const binding = {
    states: new Map(states.map((name, index) => [name, index])),
    memories: new Map(memories.map((name, index) => [name, index])),
    pc: { name: 'pc', index: states.indexOf('pc') },
    blockedStates: new Set(['irqPending', 'primask', 'ipsr']),
    blockedMemories: new Set(['code']),
    host: true,
  };
  const started = performance.now();
  const byKind = {};
  const perInstruction = instructions.map((instruction) => {
    const kinds = {};
    const nonScalarTypes = new Set();
    const blockedStateWrites = new Set();
    operations(instruction.body, (operation) => {
      kinds[operation.kind] = (kinds[operation.kind] ?? 0) + 1;
      byKind[operation.kind] = (byKind[operation.kind] ?? 0) + 1;
      if ('type' in operation && !['number', 'bool'].includes(operation.type.kind))
        nonScalarTypes.add(operation.type.kind);
      if (operation.kind === 'write' && binding.blockedStates.has(operation.name))
        blockedStateWrites.add(operation.name);
    });
    const program = compileDirectJit([instruction], binding);
    return {
      pc: instruction.pc,
      pcHex: `0x${instruction.pc.toString(16)}`,
      operations: Object.values(kinds).reduce((a, b) => a + b, 0),
      kinds,
      direct: Boolean(program),
      nonScalarTypes: [...nonScalarTypes].sort(),
      blockedStateWrites: [...blockedStateWrites].sort(),
      sourceCharacters: program?.run.toString().length ?? 0,
      localCount: program?.localCount ?? 0,
    };
  });
  const program = compileDirectJit(instructions, binding);
  const source = program?.run.toString() ?? '';
  const supported = perInstruction.filter((instruction) => instruction.direct).length;
  const excludedByKind = {};
  const excludedTypes = {};
  const excludedStateWrites = {};
  for (const instruction of perInstruction) {
    if (instruction.direct) continue;
    for (const [kind, count] of Object.entries(instruction.kinds))
      excludedByKind[kind] = (excludedByKind[kind] ?? 0) + count;
    for (const type of instruction.nonScalarTypes)
      excludedTypes[type] = (excludedTypes[type] ?? 0) + 1;
    for (const name of instruction.blockedStateWrites)
      excludedStateWrites[name] = (excludedStateWrites[name] ?? 0) + 1;
  }
  return {
    scope: 'offline compilation with IRQ hook barriers; static coverage, not runtime fallback rate',
    translatedInstructions: instructions.length,
    directInstructions: supported,
    directCoverage: instructions.length ? supported / instructions.length : 0,
    operations: Object.values(byKind).reduce((a, b) => a + b, 0),
    byKind,
    excludedInstructions: perInstruction.length - supported,
    excludedByKind,
    excludedTypes,
    excludedStateWrites,
    sourceCharacters: source.length,
    localCount: program?.localCount ?? 0,
    capturedLoads: (source.match(/C\[/g) ?? []).length,
    booleanChecks: (source.match(/H\.checkBoolean\(/g) ?? []).length,
    selectLabels: (source.match(/select\d+: \{/g) ?? []).length,
    offlineCompileMs: performance.now() - started,
    instructions: perInstruction,
  };
}
