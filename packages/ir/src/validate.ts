import { CORE_INSTRUCTION_NAMES } from './builder';
import { isScalarType, normalizeScalarLiteral } from './runtime';
import { isRecord, isReservedOperation } from './validation-internal';
import type { ModuleModel } from './validation-internal';
import { validateInstruction } from './validate-instructions';
import { byteReadonly, refKind, scalarType, signature, valueKind } from './types';
import type {
  BlockDefinition,
  FunctionDefinition,
  MemoryDefinition,
  ScalarType,
  StaticRef,
  Value,
} from './types';
import type {
  IRDiagnostic,
  IRDiagnosticCode,
  IRDiagnosticLocation,
  IRValidationOptions,
  IRValidationResult,
} from './validation-types';

interface Definition {
  readonly functionIndex: number;
  readonly block: BlockDefinition;
  readonly position: number;
}

interface CallSite {
  readonly source: FunctionDefinition;
  readonly target: FunctionDefinition;
  readonly location: IRDiagnosticLocation;
}

const coreNames = new Set(CORE_INSTRUCTION_NAMES);
const terminators = new Set(['return', 'jump', 'branch', 'trap']);

export function validateIR(input: unknown, options: IRValidationOptions): IRValidationResult {
  return new Validator().run(input, options);
}

class Validator {
  private readonly diagnostics: IRDiagnostic[] = [];
  private readonly definitions = new Map<object, Definition>();
  private readonly callSites: CallSite[] = [];

  private report(code: IRDiagnosticCode, message: string, location: IRDiagnosticLocation): void {
    this.diagnostics.push({ code, message, location });
  }

  run(input: unknown, options: unknown): IRValidationResult {
    try {
      if (this.optionsShape(options)) {
        // Module getters may create fresh declaration views. Read each registry once
        // so all validation phases and call-graph edges share the same definitions.
        const model = isRecord(input)
          ? {
              memories: input.memories,
              functions: input.functions,
              domainDeclarations: input.domainDeclarations,
              instructions: input.instructions,
            }
          : input;
        if (this.moduleShape(model)) {
          this.validate(model as unknown as ModuleModel, options as IRValidationOptions);
        }
      }
    } catch {
      this.report('malformed-input', 'Input or validation policy could not be read safely', {
        path: '$',
      });
    }
    return { ok: this.diagnostics.length === 0, diagnostics: this.diagnostics };
  }

  private array(value: unknown, location: IRDiagnosticLocation): value is unknown[] {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          this.report('malformed-input', 'Sparse arrays are not valid IR lists', location);
          return false;
        }
      }
      return true;
    }
    this.report('malformed-input', 'Expected an array', location);
    return false;
  }

  private record(
    value: unknown,
    location: IRDiagnosticLocation,
  ): value is Record<PropertyKey, unknown> {
    if (isRecord(value)) return true;
    this.report('malformed-input', 'Expected an object', location);
    return false;
  }

  private name(value: unknown, location: IRDiagnosticLocation): boolean {
    if (typeof value === 'string' && value.length > 0) return true;
    this.report('malformed-input', 'Expected a non-empty name', location);
    return false;
  }

  private minimum(value: unknown, location: IRDiagnosticLocation): boolean {
    if (value === undefined) return true;
    if (Number.isSafeInteger(value) && (value as number) >= 0) return true;
    this.report('malformed-input', 'Expected a non-negative integer list length', location);
    return false;
  }

  private types(value: unknown, location: IRDiagnosticLocation): boolean {
    if (!this.array(value, location)) return false;
    for (const type of value) {
      if (!isScalarType(type)) this.report('type-mismatch', 'Invalid scalar type', location);
    }
    return true;
  }

  private value(value: unknown, location: IRDiagnosticLocation): boolean {
    if (!this.record(value, location)) return false;
    if (
      !isScalarType(value.type) ||
      value[refKind] !== undefined ||
      (value[valueKind] !== undefined && value[valueKind] !== 'ssa-value')
    ) {
      this.report('type-mismatch', 'Expected a scalar SSA value, not a static reference', location);
      return false;
    }
    return true;
  }

  private values(values: unknown, location: IRDiagnosticLocation): boolean {
    if (!this.array(values, location)) return false;
    for (const value of values) this.value(value, location);
    return true;
  }

  private ref(value: unknown, location: IRDiagnosticLocation): boolean {
    if (isRecord(value) && typeof value[refKind] === 'string' && value[refKind].length > 0)
      return true;
    this.report('invalid-static-reference', 'Expected a categorized static reference', location);
    return false;
  }

  private optionsShape(input: unknown): boolean {
    const start = this.diagnostics.length;
    const at = (field: string): IRDiagnosticLocation => ({ path: `options.${field}` });
    if (!this.record(input, { path: 'options' })) return false;
    for (const key of ['supportedInstructions', 'authorizedInstructions'] as const) {
      if (this.array(input[key], at(key))) {
        for (const op of input[key]) this.name(op, at(key));
      }
    }
    if (this.array(input.resources, at('resources'))) {
      const refs = new Map<object, Set<unknown>>();
      input.resources.forEach((grant, i) => {
        const location = at(`resources[${i}]`);
        if (!this.record(grant, location)) return;
        if (this.ref(grant.ref, location)) {
          const accesses = refs.get(grant.ref as object) ?? new Set<unknown>();
          if (accesses.has(grant.access))
            this.report('malformed-input', 'Duplicate resource grant', location);
          accesses.add(grant.access);
          refs.set(grant.ref as object, accesses);
          if (grant.access === 'update' && (grant.ref as StaticRef)[refKind] !== 'bytes') {
            this.report(
              'invalid-resource',
              'Update authorization requires a byte resource',
              location,
            );
          }
        }
        if (!['read', 'write', 'read-write', 'update'].includes(grant.access as string)) {
          this.report('malformed-input', 'Invalid resource access permission', location);
        }
      });
    }
    if (input.validators !== undefined && this.array(input.validators, at('validators'))) {
      const names = new Set<string>();
      input.validators.forEach((validator, i) => {
        const location = at(`validators[${i}]`);
        if (!this.record(validator, location)) return;
        this.name(validator.op, location);
        if (typeof validator.validate !== 'function')
          this.report('extension-error', 'Validator must be a function', location);
        if (names.has(validator.op as string))
          this.report('extension-error', 'Duplicate instruction validator', location);
        names.add(validator.op as string);
        if (coreNames.has(validator.op as string) || isReservedOperation(validator.op as string)) {
          this.report(
            'unsupported-instruction',
            'Core and reserved operations cannot be replaced by extensions',
            location,
          );
        }
      });
    }
    return this.diagnostics.length === start;
  }

  private moduleShape(input: unknown): boolean {
    const start = this.diagnostics.length;
    if (!this.record(input, { path: '$' })) return false;
    for (const key of ['memories', 'functions', 'domainDeclarations', 'instructions'] as const) {
      this.array(input[key], { path: key });
    }
    if (this.diagnostics.length !== start) return false;
    (input.memories as unknown[]).forEach((memory, i) => {
      const location = { path: `memories[${i}]` };
      if (!this.record(memory, location)) return;
      this.name(memory.name, location);
      this.ref(memory.ref, location);
      this.record(memory.layout, location);
      this.array(memory.initial, location);
    });
    (input.domainDeclarations as unknown[]).forEach((declaration, i) => {
      const location = { path: `domainDeclarations[${i}]` };
      if (!this.record(declaration, location)) return;
      this.name(declaration.name, location);
      this.name(declaration.kind, location);
      this.ref(declaration.ref, location);
    });
    (input.instructions as unknown[]).forEach((instruction, i) => {
      const location = { path: `instructions[${i}]` };
      if (!this.record(instruction, location)) return;
      this.name(instruction.name, location);
      this.types(instruction.results, location);
      if (this.array(instruction.operands, location)) {
        for (const operand of instruction.operands) {
          if (!this.record(operand, location)) continue;
          if (operand.kind === 'value' || operand.kind === 'value-list') {
            if (!isScalarType(operand.type))
              this.report('type-mismatch', 'Invalid operand scalar type', location);
            if (operand.kind === 'value-list') this.minimum(operand.minLength, location);
          } else if (operand.kind === 'static' || operand.kind === 'static-list') {
            this.name(operand.category, location);
            if (operand.kind === 'static-list') this.minimum(operand.minLength, location);
          } else if (operand.kind !== 'literal') {
            this.report('malformed-input', 'Invalid operand schema', location);
          }
        }
      }
    });
    (input.functions as unknown[]).forEach((fn, fi) => {
      let location: IRDiagnosticLocation = { path: `functions[${fi}]`, functionIndex: fi };
      if (!this.record(fn, location)) return;
      if (typeof fn.name === 'string') location = { ...location, functionName: fn.name };
      this.name(fn.name, location);
      this.ref(fn.ref, location);
      this.types(fn.params, location);
      this.types(fn.results, location);
      if (!['function', 'entry', 'lifecycle'].includes(fn.category as string)) {
        this.report('type-mismatch', 'Unknown function category', location);
      }
      if (fn.body === undefined) return;
      if (!this.record(fn.body, { ...location, path: `${location.path}.body` })) return;
      if (!this.array(fn.body.blocks, location)) return;
      fn.body.blocks.forEach((block, bi) => {
        const blockLocation: IRDiagnosticLocation = {
          ...location,
          path: `${location.path}.body.blocks[${bi}]`,
          blockIndex: bi,
          ...(isRecord(block) && typeof block.id === 'number' ? { blockId: block.id } : {}),
        };
        if (!this.record(block, blockLocation)) return;
        this.values(block.params, blockLocation);
        if (this.array(block.instructions, blockLocation)) {
          block.instructions.forEach((node, ii) => {
            const at = {
              ...blockLocation,
              path: `${blockLocation.path}.instructions[${ii}]`,
              instructionIndex: ii,
            };
            if (!this.record(node, at)) return;
            this.name(node.op, at);
            this.values(node.results, at);
            if (!this.array(node.operands, at)) return;
            for (const operand of node.operands) {
              if (!this.record(operand, at)) continue;
              if (operand.kind === 'ssa') this.value(operand.value, at);
              else if (operand.kind === 'static') this.ref(operand.ref, at);
              else if (operand.kind === 'ssa-list') {
                if (this.array(operand.values, at)) {
                  for (const value of operand.values) this.value(value, at);
                }
              } else if (operand.kind === 'static-list') {
                if (this.array(operand.refs, at)) {
                  for (const ref of operand.refs) this.ref(ref, at);
                }
              } else if (
                operand.kind !== 'literal' ||
                !['boolean', 'number', 'string'].includes(typeof operand.value)
              ) {
                this.report('malformed-input', 'Invalid instruction operand', at);
              }
            }
          });
        }
        const term = block.terminator;
        const at = {
          ...blockLocation,
          path: `${blockLocation.path}.terminator`,
          terminator: true as const,
        };
        if (term === undefined) return;
        if (!this.record(term, at)) return;
        if (term.kind === 'return') this.values(term.values, at);
        else if (term.kind === 'jump') this.values(term.args, at);
        else if (term.kind === 'branch') {
          this.value(term.condition, at);
          for (const edge of [term.yes, term.no]) {
            if (this.record(edge, at)) this.values(edge.args, at);
          }
        }
      });
    });
    return this.diagnostics.length === start;
  }

  private validate(module: ModuleModel, options: IRValidationOptions): void {
    const names = new Set<string>();
    const refs = new Set<object>();
    const register = (name: string, ref: object, location: IRDiagnosticLocation): void => {
      if (names.has(name) || refs.has(ref))
        this.report(
          'duplicate-definition',
          'Duplicate declaration name or reference identity',
          location,
        );
      names.add(name);
      refs.add(ref);
    };
    module.memories.forEach((memory, i) => {
      const location = { path: `memories[${i}]` };
      register(memory.name, memory.ref, location);
      this.memory(memory, location);
    });
    module.domainDeclarations.forEach((domain, i) => {
      const location = { path: `domainDeclarations[${i}]` };
      register(domain.name, domain.ref, location);
      if (
        domain.ref[refKind] !== domain.kind ||
        [
          'state',
          'array',
          'bytes',
          'inbox',
          'function',
          'entry',
          'lifecycle',
          'block',
          'instruction',
          'provider',
        ].includes(domain.kind)
      ) {
        this.report(
          'invalid-static-reference',
          'Domain reference category conflicts with its declaration or a reserved core category',
          location,
        );
      }
    });
    const instructionNames = new Set<string>();
    module.instructions.forEach((instruction, i) => {
      const location = { path: `instructions[${i}]` };
      if (instructionNames.has(instruction.name))
        this.report('duplicate-definition', 'Duplicate instruction declaration', location);
      instructionNames.add(instruction.name);
      if (coreNames.has(instruction.name) || isReservedOperation(instruction.name)) {
        this.report(
          'unsupported-instruction',
          'Core and reserved instructions cannot be redeclared',
          location,
        );
      }
    });
    module.functions.forEach((fn, fi) => {
      const location = this.functionLocation(fn, fi);
      register(fn.name, fn.ref, location);
      if (fn.ref[refKind] !== fn.category)
        this.report(
          'invalid-static-reference',
          'Function reference category differs from its declaration',
          location,
        );
      const layout = fn.ref[signature];
      if (
        !isRecord(layout) ||
        !Array.isArray(layout.params) ||
        !Array.isArray(layout.results) ||
        !sameTypes(layout.params, fn.params) ||
        !sameTypes(layout.results, fn.results)
      ) {
        this.report(
          'signature-mismatch',
          'Function reference signature differs from the actual declaration',
          location,
        );
      }
      if (fn.category !== 'function' && fn.results.length !== 0)
        this.report(
          'signature-mismatch',
          'Entries and lifecycle functions cannot return values',
          location,
        );
    });
    for (const grant of options.resources) {
      if (
        !module.memories.some((memory) => memory.ref === grant.ref) &&
        !module.domainDeclarations.some((domain) => domain.ref === grant.ref)
      ) {
        this.report(
          'invalid-static-reference',
          'Permission refers to a resource not declared in this input',
          { path: `options.resources[${options.resources.indexOf(grant)}]` },
        );
      }
    }
    const blocks = new Set<object>();
    module.functions.forEach((fn, fi) => this.collect(fn, fi, blocks));
    const memories = new Map(module.memories.map((memory) => [memory.ref, memory]));
    const functions = new Map(module.functions.map((fn) => [fn.ref, fn]));
    const domains = new Map(module.domainDeclarations.map((domain) => [domain.ref, domain]));
    const declarations = new Map(
      module.instructions.map((declaration) => [declaration.name, declaration]),
    );
    const validators = new Map(options.validators?.map((validator) => [validator.op, validator]));
    module.functions.forEach((fn, fi) => {
      if (fn.body === undefined || !fn.body.blocks.includes(fn.body.entry)) return;
      const dominators = this.dominators(fn);
      fn.body.blocks.forEach((block, bi) => {
        const location = this.blockLocation(fn, fi, block, bi);
        const use = (value: Value, position: number, at: IRDiagnosticLocation): void => {
          const definition = this.definitions.get(value);
          if (definition === undefined || definition.functionIndex !== fi) {
            this.report('ssa-undefined', 'SSA value is not defined in this function', at);
          } else if (
            definition.block === block
              ? definition.position >= position
              : !(definition.block === fn.body?.entry && definition.position === -1) &&
                !dominators.get(block)?.has(definition.block)
          ) {
            this.report('ssa-dominance', 'SSA definition does not dominate this use', at);
          }
        };
        block.instructions.forEach((node, ii) => {
          const at = {
            ...location,
            path: `${location.path}.instructions[${ii}]`,
            instructionIndex: ii,
          };
          for (const operand of node.operands) {
            if (operand.kind === 'ssa') use(operand.value, ii, at);
            else if (operand.kind === 'ssa-list') {
              for (const value of operand.values) use(value, ii, at);
            }
          }
          if (terminators.has(node.op)) {
            this.report(
              'invalid-terminator',
              'Terminator cannot appear in the instruction list',
              at,
            );
            return;
          }
          validateInstruction(node, {
            module,
            fn,
            block,
            location: at,
            options,
            memories,
            functions,
            domains,
            declarations,
            validators,
            report: (code, message) => this.report(code, message, at),
            call: (target) => this.callSites.push({ source: fn, target, location: at }),
          });
        });
        const at = { ...location, path: `${location.path}.terminator`, terminator: true as const };
        const term = block.terminator;
        if (term === undefined) {
          this.report('invalid-terminator', 'Block must have a terminator', at);
          return;
        }
        if (!terminators.has(term.kind)) {
          this.report(
            typeof term.kind === 'string' && isReservedOperation(term.kind)
              ? 'unsupported-instruction'
              : 'invalid-terminator',
            'Unknown or unsupported terminator',
            at,
          );
          return;
        }
        if (!options.supportedInstructions.includes(term.kind))
          this.report('unsupported-instruction', 'Backend does not support this terminator', at);
        if (!options.authorizedInstructions.includes(term.kind))
          this.report('unauthorized-instruction', 'Terminator is not authorized', at);
        const edge = (target: BlockDefinition, args: readonly Value[]): void => {
          args.forEach((value) => use(value, block.instructions.length, at));
          if (!fn.body?.blocks.includes(target))
            this.report('invalid-block', 'Edge target is not a block of this function', at);
          else if (
            !sameTypes(
              args.map((value) => value.type),
              target.params.map((value) => value.type),
            )
          )
            this.report('signature-mismatch', 'Edge arguments do not match block parameters', at);
        };
        switch (term.kind) {
          case 'jump':
            edge(term.target, term.args);
            break;
          case 'branch':
            use(term.condition, block.instructions.length, at);
            if (term.condition.type !== 'bool')
              this.report('type-mismatch', 'Branch condition must be bool', at);
            edge(term.yes.target, term.yes.args);
            edge(term.no.target, term.no.args);
            break;
          case 'return':
            term.values.forEach((value) => use(value, block.instructions.length, at));
            if (
              !sameTypes(
                term.values.map((value) => value.type),
                fn.results,
              )
            )
              this.report(
                'signature-mismatch',
                'Return values do not match the function signature',
                at,
              );
            break;
          case 'trap':
            if (typeof term.code !== 'string' || term.code.length === 0)
              this.report('invalid-terminator', 'Trap requires a non-empty static code', at);
        }
      });
    });
    this.recursion(module.functions);
  }

  private memory(memory: MemoryDefinition, location: IRDiagnosticLocation): void {
    const invalid = (message: string): void => this.report('invalid-resource', message, location);
    if (
      !['state', 'array', 'bytes', 'inbox'].includes(memory.kind) ||
      memory.ref[refKind] !== memory.kind
    ) {
      invalid('Unknown memory kind or mismatching reference category');
      return;
    }
    const layout = memory.layout;
    if (
      !Number.isSafeInteger(layout.length) ||
      layout.length < 0 ||
      memory.initial.length !== layout.length ||
      typeof memory.writable !== 'boolean'
    ) {
      invalid('Invalid capacity, initial length, or writable flag');
    }
    if (memory.kind === 'state' || memory.kind === 'array') {
      if (
        layout.kind !== 'scalar' ||
        !isScalarType(layout.scalarType) ||
        (memory.ref as unknown as Record<PropertyKey, unknown>)[scalarType] !== layout.scalarType ||
        !memory.writable ||
        (memory.kind === 'state' && layout.length !== 1)
      ) {
        invalid('Scalar memory layout differs from its kind or handle');
        return;
      }
      for (const initial of memory.initial) {
        try {
          normalizeScalarLiteral(layout.scalarType, initial);
        } catch {
          invalid('Invalid scalar initializer');
        }
      }
    } else {
      if (
        layout.kind !== 'bytes' ||
        !Number.isSafeInteger(layout.unitBytes) ||
        layout.unitBytes < 0 ||
        (layout.length !== 0 && layout.unitBytes === 0) ||
        (memory.ref as unknown as Record<PropertyKey, unknown>)[byteReadonly] !==
          !memory.writable ||
        (memory.kind === 'inbox' && (memory.writable || layout.unitBytes !== layout.length))
      ) {
        invalid('Byte memory layout differs from its kind or handle');
      }
      for (const initial of memory.initial) {
        if (
          typeof initial !== 'number' ||
          !Number.isInteger(initial) ||
          initial < 0 ||
          initial > 255 ||
          (memory.kind === 'inbox' && initial !== 0)
        )
          invalid('Invalid byte initializer');
      }
    }
  }

  private functionLocation(fn: FunctionDefinition, functionIndex: number): IRDiagnosticLocation {
    return { path: `functions[${functionIndex}]`, functionIndex, functionName: fn.name };
  }

  private blockLocation(
    fn: FunctionDefinition,
    fi: number,
    block: BlockDefinition,
    blockIndex: number,
  ): IRDiagnosticLocation {
    return {
      ...this.functionLocation(fn, fi),
      path: `functions[${fi}].body.blocks[${blockIndex}]`,
      blockIndex,
      blockId: block.id,
    };
  }

  private collect(fn: FunctionDefinition, fi: number, blocks: Set<object>): void {
    if (fn.body === undefined) {
      this.report('invalid-block', 'Function has no defined body', this.functionLocation(fn, fi));
      return;
    }
    if (!fn.body.blocks.includes(fn.body.entry))
      this.report(
        'invalid-block',
        'Entry must be an actual block in this function',
        this.functionLocation(fn, fi),
      );
    const ids = new Set<number>();
    const define = (
      value: Value,
      block: BlockDefinition,
      position: number,
      at: IRDiagnosticLocation,
    ): void => {
      if (this.definitions.has(value))
        this.report('duplicate-definition', 'SSA value identity is defined more than once', at);
      else this.definitions.set(value, { functionIndex: fi, block, position });
    };
    fn.body.blocks.forEach((block, bi) => {
      const at = this.blockLocation(fn, fi, block, bi);
      if (blocks.has(block) || ids.has(block.id))
        this.report(
          'duplicate-definition',
          'Block identity or local ID is defined more than once',
          at,
        );
      blocks.add(block);
      ids.add(block.id);
      if (!Number.isSafeInteger(block.id) || block.id < 0 || block.defined !== true)
        this.report('invalid-block', 'Block must have a non-negative safe ID and be defined', at);
      if (
        block === fn.body?.entry &&
        !sameTypes(
          block.params.map((value) => value.type),
          fn.params,
        )
      )
        this.report(
          'signature-mismatch',
          'Entry parameters differ from the function signature',
          at,
        );
      block.params.forEach((value) => define(value, block, -1, at));
      block.instructions.forEach((node, ii) => {
        const location = { ...at, path: `${at.path}.instructions[${ii}]`, instructionIndex: ii };
        node.results.forEach((value) => define(value, block, ii, location));
      });
    });
  }

  private dominators(fn: FunctionDefinition): Map<BlockDefinition, Set<BlockDefinition>> {
    const body = fn.body!;
    const successors = (block: BlockDefinition): readonly BlockDefinition[] => {
      const term = block.terminator;
      if (term?.kind === 'jump') return [term.target];
      if (term?.kind === 'branch') return [term.yes.target, term.no.target];
      return [];
    };
    const members = new Set(body.blocks);
    const reachable = new Set<BlockDefinition>();
    const pending = [body.entry];
    while (pending.length > 0) {
      const block = pending.pop()!;
      if (!members.has(block) || reachable.has(block)) continue;
      reachable.add(block);
      pending.push(...successors(block));
    }
    const predecessors = new Map(body.blocks.map((block) => [block, new Set<BlockDefinition>()]));
    for (const block of reachable) {
      for (const next of successors(block))
        if (members.has(next)) predecessors.get(next)!.add(block);
    }
    const result = new Map(
      body.blocks.map((block) => [
        block,
        new Set(block === body.entry || !reachable.has(block) ? [block] : reachable),
      ]),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const block of reachable) {
        if (block === body.entry) continue;
        const parents = [...predecessors.get(block)!];
        const next = new Set(result.get(parents[0]!)!);
        for (const parent of parents.slice(1))
          for (const candidate of next)
            if (!result.get(parent)!.has(candidate)) next.delete(candidate);
        next.add(block);
        const previous = result.get(block)!;
        if (
          next.size !== previous.size ||
          [...next].some((candidate) => !previous.has(candidate))
        ) {
          result.set(block, next);
          changed = true;
        }
      }
    }
    return result;
  }

  private recursion(functions: readonly FunctionDefinition[]): void {
    const outgoing = new Map(functions.map((fn) => [fn, [] as FunctionDefinition[]]));
    for (const call of this.callSites) outgoing.get(call.source)!.push(call.target);
    // Iterative reachability avoids using the JS stack for adversarial call graphs.
    for (const call of this.callSites) {
      const pending = [call.target];
      const seen = new Set<FunctionDefinition>();
      while (pending.length > 0) {
        const next = pending.pop()!;
        if (next === call.source) {
          this.report(
            'recursive-call',
            'Call participates in a recursive ordinary call graph',
            call.location,
          );
          break;
        }
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(...outgoing.get(next)!);
      }
    }
  }
}

function sameTypes(left: readonly unknown[], right: readonly ScalarType[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.hasOwn(left, index) || left[index] !== right[index]) return false;
  }
  return true;
}
