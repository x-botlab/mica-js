import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCU_PIN } from '../device/src/nets';

/**
 * Generated dirty-mark regressions.
 *
 * A jumper event may only dirty the pins reachable from that jumper, and a button
 * closure refresh may only dirty the row/column pin whose own bit changed. Both rules
 * live entirely in the generated `model.ddl`, so this checks the generated dependency
 * edges instead of relying on timing-sensitive refresh counts.
 */

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'device', 'src', 'model.ddl'), 'utf8');

interface Branch {
  readonly condition: string;
  readonly drives: readonly number[];
  readonly groups: readonly number[];
}

/** Slice a generated two-space-indented function body. */
function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`  fn ${name}(`);
  if (start < 0) throw new Error(`Missing generated function ${name}`);
  const open = SOURCE.indexOf('{', start);
  const close = SOURCE.indexOf('\n  }', open);
  if (open < 0 || close < 0) throw new Error(`Unterminated generated function ${name}`);
  return SOURCE.slice(open + 1, close);
}

/** Parse `if <condition> { store8(...); ... }` branches and their dirty marks. */
function branches(body: string): Branch[] {
  const result: Branch[] = [];
  for (const match of body.matchAll(/\n {4}if ([^\n]+) \{\n([\s\S]*?)\n {4}\}/g)) {
    const condition = match[1];
    const block = match[2];
    if (condition === undefined || block === undefined)
      throw new Error('Malformed generated dirty-mark branch');
    const drives = [...block.matchAll(/store8\(fusedPinDirty, (\d+), 1\);/g)].map((entry) =>
      Number(entry[1]),
    );
    const groups = [...block.matchAll(/store8\(fusedDirtyGroups, (\d+), 1\);/g)].map((entry) =>
      Number(entry[1]),
    );
    result.push({ condition, drives, groups });
  }
  return result;
}

const totalGroups = (drives: readonly number[]): number[] => [
  ...new Set(drives.map((drive) => Math.floor(drive / 8))),
];

describe('generated fused dirty marks', () => {
  it('marks only the pins reachable from the changed jumper index', () => {
    // J13 (index 0) only selects the U25 WR net, which no MCU pin mirrors, so it must
    // not mark P1.1/P3.4/P4.4 through a union. J3 mirrors P3.4, J2 mirrors P1.1 and J5
    // mirrors the P4.4 matrix column.
    expect(branches(bodyOf('fusedMarkJumperPins'))).toEqual([
      { condition: 'index == 1', drives: [MCU_PIN.P3_4.drive], groups: [3] },
      { condition: 'index == 2', drives: [MCU_PIN.P1_1.drive], groups: [1] },
      { condition: 'index == 3', drives: [MCU_PIN.P4_4.drive], groups: [4] },
    ]);
    expect(SOURCE).toContain('fusedMarkJumperPins(event.index);');
    expect(SOURCE).not.toContain('fusedMarkJumperPins();');
  });

  it('marks button row/column pins from the changed closure bits only', () => {
    // Rows 0-3 are P3.0-P3.3; columns 4-7 are KCOL0/P4.4, P4.2, P3.5 and P3.4.
    const marks = branches(bodyOf('fusedMarkButtonPins'));
    expect(marks.map((branch) => branch.condition)).toEqual(
      Array.from({ length: 8 }, (_, bit) => `(changed & ${1 << bit}) != 0`),
    );
    expect(marks.map((branch) => branch.drives)).toEqual([
      [MCU_PIN.P3_0.drive],
      [MCU_PIN.P3_1.drive],
      [MCU_PIN.P3_2.drive],
      [MCU_PIN.P3_3.drive],
      [MCU_PIN.P4_4.drive],
      [MCU_PIN.P4_2.drive],
      [MCU_PIN.P3_5.drive],
      [MCU_PIN.P3_4.drive],
    ]);
    for (const branch of marks) expect(branch.groups).toEqual(totalGroups(branch.drives));
  });

  it('accumulates per-bit changes and passes them to the button mark', () => {
    const compute = bodyOf('fusedComputeButtons');
    const masks = [
      ...compute.matchAll(
        /if previousButtonLow(\d) != load8\(fusedButtonLow, (\d)\) \{ buttonChanged = buttonChanged \| (\d+); \}/g,
      ),
    ].map((match) => ({
      previous: Number(match[1]),
      current: Number(match[2]),
      mask: Number(match[3]),
    }));

    expect(masks).toEqual(
      Array.from({ length: 8 }, (_, bit) => ({ previous: bit, current: bit, mask: 1 << bit })),
    );
    expect(compute).not.toContain('buttonChanged = true');
    expect(compute).toContain('if buttonChanged != 0 { fusedMarkButtonPins(buttonChanged); }');
    // LED and actuator observables read no button bits, so the diff must not raise them.
    expect(compute).not.toMatch(/fusedLedDirty|fusedActuatorDirty/);
  });

  it('gates key events through the matrix instead of an empty button source', () => {
    const start = SOURCE.indexOf('  process consumeSwitches on fusedStarted {');
    const end = SOURCE.indexOf('\n  }', start);
    const consume = SOURCE.slice(start, end);

    // S4-S19 are the matrix keys (indices 1-16); S1 index 0 is independent.
    expect(consume).toContain(
      'if event.index >= 1 && event.index <= 16 { fusedButtonDirty = true; }',
    );
    expect(consume).not.toMatch(/fusedLedDirty|fusedActuatorDirty/);
  });
});
