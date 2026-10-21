import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../format/types';
import { DEFAULT_DESIGNATOR_PREFIX, defaultDesignatorFactory, nextDesignator } from './designator';

function documentWith(designators: readonly (string | undefined)[]): SchematicDocument {
  return {
    version: 1,
    id: 'designators',
    sheet: {
      symbols: designators.map((designator, index) => ({
        id: `s${index}`,
        device: 'pkg:a',
        x: 0,
        y: 0,
        rotation: 0,
        ...(designator === undefined ? {} : { designator }),
      })),
      wires: [],
      junctions: [],
    },
  };
}

describe('nextDesignator', () => {
  it('starts at U1 and skips taken designators', () => {
    expect(nextDesignator(documentWith([]))).toBe(`${DEFAULT_DESIGNATOR_PREFIX}1`);
    expect(nextDesignator(documentWith(['U1', 'U3']))).toBe('U2');
  });

  it('leaves U1 free when components fall back to their ids', () => {
    expect(nextDesignator(documentWith([undefined]))).toBe('U1');
    expect(nextDesignator(documentWith(['U1']))).toBe('U2');
  });

  it('accepts a device-specific prefix', () => {
    expect(nextDesignator(documentWith(['R1', 'R2']), 'R')).toBe('R3');
  });

  it('ignores net-naming symbols, which carry no designator', () => {
    const document: SchematicDocument = {
      version: 1,
      id: 'mixed',
      sheet: {
        symbols: [{ id: 'l1', device: 'builtin:label', net: 'N1', x: 0, y: 0, rotation: 0 }],
        wires: [],
        junctions: [],
      },
    };
    expect(nextDesignator(document)).toBe('U1');
  });
});

describe('defaultDesignatorFactory', () => {
  it('uses the U prefix regardless of the device', () => {
    expect(defaultDesignatorFactory('pkg:ne555', documentWith(['U1']))).toBe('U2');
    expect(defaultDesignatorFactory('pkg:ne555', documentWith([]))).toBe('U1');
  });
});
