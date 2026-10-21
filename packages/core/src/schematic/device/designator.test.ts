import { describe, expect, it } from 'vitest';
import type { SchematicDocument } from '../format/types';
import {
  DEFAULT_DESIGNATOR_PREFIX,
  createDesignatorFactory,
  defaultDesignatorFactory,
  designatorPrefixOf,
  nextDesignator,
} from './designator';
import { createDeviceRegistry } from './registry';

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

describe('createDesignatorFactory', () => {
  const devices = createDeviceRegistry([
    {
      packageId: 'pkg',
      devices: [
        { id: 'resistor', designatorPrefix: 'R' },
        { id: 'display', designatorPrefix: 'DS' },
        { id: 'chip' },
      ],
    },
  ]);

  it('reads the prefix from the device definition', () => {
    const factory = createDesignatorFactory(devices);
    expect(factory('pkg:resistor', documentWith(['R1', 'R2']))).toBe('R3');
    expect(factory('pkg:display', documentWith(['DS1']))).toBe('DS2');
  });

  it('falls back to the global prefix for devices without one or unknown devices', () => {
    const factory = createDesignatorFactory(devices);
    expect(factory('pkg:chip', documentWith(['U1']))).toBe('U2');
    expect(factory('pkg:missing', documentWith([]))).toBe('U1');
    expect(createDesignatorFactory(undefined)('pkg:resistor', documentWith([]))).toBe('U1');
  });

  it('reports the resolved prefix', () => {
    expect(designatorPrefixOf(devices, 'pkg:resistor')).toBe('R');
    expect(designatorPrefixOf(devices, 'pkg:chip')).toBe(DEFAULT_DESIGNATOR_PREFIX);
    expect(designatorPrefixOf(undefined, 'pkg:resistor')).toBe(DEFAULT_DESIGNATOR_PREFIX);
  });
});
