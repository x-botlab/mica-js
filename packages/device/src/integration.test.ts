import { describe, expect, it } from 'vitest';
import { createDeviceRegistry } from '@mica-js/core/schematic';
import { parseDeviceDescription } from './description';
import { resolveDeviceProperties } from './properties';

describe('schematic registry integration', () => {
  it('feeds parsed descriptions into the existing device registry without redefining schema', () => {
    const raw = {
      properties: {
        label: { type: 'string', default: 'Display', maxLength: 16 },
        speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
        accent: { type: 'color', default: '#3b82f6', alpha: true },
      },
      ports: {
        frame: { direction: 'output', type: 'bytes<rgb565>' },
      },
      designatorPrefix: 'U',
    };
    const description = parseDeviceDescription(raw, {
      name: 'acme:demo',
      displayName: 'Demo device',
      description: 'Device used by the integration test',
    });
    const registry = createDeviceRegistry([
      {
        packageId: 'acme',
        devices: [
          {
            id: 'demo',
            displayName: description.displayName,
            ...(description.description === undefined
              ? {}
              : { description: description.description }),
            raw,
          },
        ],
      },
    ]);
    const device = registry.resolve('acme:demo');
    expect(device?.displayName).toBe('Demo device');
    expect(device?.description).toBe('Device used by the integration test');
    expect(device?.designatorPrefix).toBe('U');
    expect(device?.propertyDescriptors).toEqual(description.properties);
    expect(registry.getDevicePropertyDescriptors?.(device?.reference ?? acmeReference())).toEqual(
      description.properties,
    );

    const snapshot = resolveDeviceProperties(description, { label: 'LCD' });
    expect(snapshot['label']).toBe('LCD');
    expect(snapshot['accent']).toBe('#3B82F6');
  });
});

function acmeReference() {
  return { raw: 'acme:demo', packageId: 'acme', deviceId: 'demo' };
}
