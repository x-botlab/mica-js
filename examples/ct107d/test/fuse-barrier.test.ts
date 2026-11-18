import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, JitInstructionBuilder, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { fuseBlock } from '../device/src/fuse.ts';
import {
  DIRTY_GROUP_MEMORY,
  PIN_DIRTY_MEMORY,
  dirtyGroup,
} from '../device/shared/dirty-protocol.mjs';

/**
 * Fused pin-write barrier regressions.
 *
 * A drive change is only visible to board models after `fusedSeq` changes. The barrier
 * must commit before every reachable block exit, not merely before the top-level
 * `elapse`: SERVICE blocks can take a nested IRQ redirect before their normal
 * `jumpToValue`, and SETTLE blocks can end in an early redirect without touching a pin.
 */

function makeBlock(build: (b: JitInstructionBuilder) => void): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 1 }, (b) => {
    build(b);
  });

  return builder.finish();
}

function drive(b: JitInstructionBuilder, pin = 'P3_1'): void {
  b.writeIntent(pin, b.resistor(b.pin('VCC'), b.constant(types.number, 25)));
}

function isSeqCommit(operation: OperationIR): boolean {
  return (
    operation.kind === 'write' && operation.resource === 'state' && operation.name === 'fusedSeq'
  );
}

function isSeqCommitBlock(operation: OperationIR): boolean {
  return (
    operation.kind === 'if' &&
    operation.yes.operations.some(isSeqCommit) &&
    operation.yes.operations.some(
      (entry) => entry.kind === 'localWrite' && entry.value !== undefined,
    )
  );
}

function seqCommits(region: RegionIR): OperationIR[] {
  const found: OperationIR[] = [];

  for (const operation of region.operations) {
    if (isSeqCommit(operation)) found.push(operation);
    if (operation.kind === 'if') {
      found.push(...seqCommits(operation.yes));
      if (operation.no !== undefined) found.push(...seqCommits(operation.no));
    } else if (operation.kind === 'match') {
      for (const arm of operation.arms) found.push(...seqCommits(arm.body));
      if (operation.otherwise !== undefined) found.push(...seqCommits(operation.otherwise));
    } else if (operation.kind === 'while' || operation.kind === 'loop') {
      found.push(...seqCommits(operation.body));
    }
  }

  return found;
}

function firstIndex(region: RegionIR, predicate: (operation: OperationIR) => boolean): number {
  return region.operations.findIndex(predicate);
}

function onlyInstruction(block: BlockIR): RegionIR {
  expect(block.instructions).toHaveLength(1);

  return block.instructions[0]!.body;
}

/** Resolve dirty store offsets for one memory back to indices. */
function dirtyOffsets(region: RegionIR, memory: string): number[] {
  const constants = new Map<number, number>();
  const offsets: number[] = [];
  const walk = (current: RegionIR): void => {
    for (const operation of current.operations) {
      if (operation.kind === 'constant' && operation.constant.kind === 'number')
        constants.set(operation.result, operation.constant.value);
      if (
        operation.kind === 'store8' &&
        operation.memory.kind === 'memory' &&
        operation.memory.name === memory
      ) {
        const offset = constants.get(operation.offset);
        if (offset !== undefined) offsets.push(offset);
      }
      if (operation.kind === 'if') {
        walk(operation.yes);
        if (operation.no !== undefined) walk(operation.no);
      } else if (operation.kind === 'match') {
        for (const arm of operation.arms) walk(arm.body);
        if (operation.otherwise !== undefined) walk(operation.otherwise);
      } else if (operation.kind === 'while' || operation.kind === 'loop') {
        walk(operation.body);
      }
    }
  };
  walk(region);
  return offsets;
}

function dirtyDrives(region: RegionIR): number[] {
  return dirtyOffsets(region, PIN_DIRTY_MEMORY);
}

describe('fused pin drive commit barriers', () => {
  it('commits before a service redirect', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        drive(b);
        b.redirect(b.constant(types.number, 0x1234), b.constant(types.number, 0));
      }),
    );
    const body = onlyInstruction(fused);
    const redirect = firstIndex(body, (operation) => operation.kind === 'redirect');
    const commit = firstIndex(body, isSeqCommitBlock);

    expect(redirect).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(commit).toBeLessThan(redirect);
  });

  it('commits before a nested IRQ-take redirect in the same service block', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        drive(b);
        b.if(b.constant(types.bool, true), (taken) => {
          taken.redirect(taken.constant(types.number, 0x23), taken.constant(types.number, 2));
        });
        b.elapse(b.constant(types.number, 0));
      }),
    );
    const body = onlyInstruction(fused);
    const branch = body.operations.find(
      (operation) =>
        operation.kind === 'if' &&
        firstIndex(operation.yes, (entry) => entry.kind === 'redirect') >= 0,
    );

    expect(branch?.kind).toBe('if');
    if (branch?.kind !== 'if') return;

    const nestedRedirect = firstIndex(branch.yes, (operation) => operation.kind === 'redirect');
    const nestedCommit = firstIndex(branch.yes, isSeqCommitBlock);

    expect(nestedRedirect).toBeGreaterThanOrEqual(0);
    expect(nestedCommit).toBeGreaterThanOrEqual(0);
    expect(nestedCommit).toBeLessThan(nestedRedirect);
  });

  it('does not add a commit when a block has no pin intent', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        b.if(b.constant(types.bool, false), (taken) => {
          taken.redirect(taken.constant(types.number, 0x23), taken.constant(types.number, 0));
        });
        b.elapse(b.constant(types.number, 5));
      }),
    );

    expect(seqCommits(onlyInstruction(fused))).toHaveLength(0);
  });

  it('keeps the commit changed-only and before a normal instruction elapse', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        drive(b);
        b.elapse(b.constant(types.number, 7));
      }),
    );
    const body = onlyInstruction(fused);
    const elapse = firstIndex(body, (operation) => operation.kind === 'elapse');
    const commit = firstIndex(body, isSeqCommitBlock);

    expect(commit).toBeGreaterThanOrEqual(0);
    expect(commit).toBeLessThan(elapse);
    // The inserted guard reads the per-instruction dirty local; the drive write sets it.
    const guard = body.operations[commit];
    expect(guard?.kind).toBe('if');
    if (guard?.kind === 'if')
      expect(guard.yes.operations.some((operation) => operation.kind === 'localWrite')).toBe(true);
  });

  it('marks the changed MCU pin dirty from the generator impact map', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        drive(b);
        b.elapse(b.constant(types.number, 7));
      }),
    );

    // P3_1 is drive 25. The generated map currently contains only itself, but the
    // assertion is on the resolved storage so aliases added by the netlist generator
    // are covered without changing this test.
    expect(dirtyDrives(onlyInstruction(fused))).toEqual([25]);
  });

  it('marks the dirty group of every pin marked by a drive change', () => {
    const fused = fuseBlock(
      makeBlock((b) => {
        drive(b);
        b.elapse(b.constant(types.number, 7));
      }),
    );

    expect(dirtyOffsets(onlyInstruction(fused), DIRTY_GROUP_MEMORY)).toEqual([dirtyGroup(25)]);
  });
});
