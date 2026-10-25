import { describe, expect, it } from 'vitest';
import { getDeviceRegistry } from '@/lib/registry';
import { DEFAULT_EXAMPLE_ID, EXAMPLES, exampleById, examplePath, examplesOf } from './index';

describe('example registry', () => {
  it('keeps ids unique and every field populated', () => {
    const ids = EXAMPLES.map((example) => example.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const example of EXAMPLES) {
      expect(example.title.length, example.id).toBeGreaterThan(0);
      expect(example.capability.length, example.id).toBeGreaterThan(0);
      expect(example.summary.length, example.id).toBeGreaterThan(0);
      expect(example.devices.length, example.id).toBeGreaterThan(0);
      expect(examplePath(example.id), example.id).toBe(`/examples/${example.id}`);
    }
  });

  it('resolves the default example and every registered id', () => {
    expect(exampleById(DEFAULT_EXAMPLE_ID)).toBeDefined();
    for (const example of EXAMPLES) {
      expect(exampleById(example.id)).toBe(example);
    }
    expect(exampleById('nope')).toBeUndefined();
  });

  it('groups examples into categories the sidebar can render', () => {
    const grouped = [...examplesOf('capability'), ...examplesOf('editor')];
    expect(grouped).toHaveLength(EXAMPLES.length);
    for (const example of grouped) {
      expect(EXAMPLES).toContain(example);
    }
  });

  it('mounts documents with content', () => {
    for (const example of EXAMPLES) {
      if (example.kind === 'schematic') {
        expect(example.document.sheet.symbols.length, example.id).toBeGreaterThan(0);
        continue;
      }
      expect(example.document.widgets.length, example.id).toBeGreaterThan(0);
      if (example.schematic !== undefined) {
        expect(example.schematic.sheet.symbols.length, example.id).toBeGreaterThan(0);
      }
    }
  });

  it('only names devices the registry knows', () => {
    const registry = getDeviceRegistry();
    for (const example of EXAMPLES) {
      const references =
        example.kind === 'schematic'
          ? example.document.sheet.symbols.map((symbol) => symbol.device)
          : (example.schematic?.sheet.symbols.map((symbol) => symbol.device) ?? []);
      for (const device of references) {
        if (device.startsWith('builtin:') || !device.includes(':')) {
          continue;
        }
        const [packageId, deviceId] = device.split(':');
        if (packageId === undefined || deviceId === undefined) {
          throw new Error(`${example.id} has a malformed device reference ${device}`);
        }
        expect(
          registry.getDeviceSymbol({ raw: device, packageId, deviceId }),
          `${example.id} → ${device}`,
        ).toBeDefined();
      }
    }
  });
});
