import { describe, expect, it } from 'vitest';
import { parseUnifiedManifest } from './manifest';
import { catchError, codesOf, pointersOf, rfcExample } from './test-helpers';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publisher: 'example',
    name: 'button',
    version: '1.2.3-rc.1+build.5',
    engines: { mica: '^1.0.0' },
    displayName: '轻触开关',
    ...overrides,
  };
}

function parseError(value: unknown): ReturnType<typeof catchError> {
  return catchError(() => parseUnifiedManifest(value));
}

describe('parseUnifiedManifest', () => {
  it('parses the full RFC 0020 example', () => {
    const value = parseUnifiedManifest(rfcExample('0020-device-package.json'));

    expect(value.publisher).toBe('example');
    expect(value.name).toBe('button');
    expect(value.version).toBe('1.0.0');
    expect(value.displayName).toBe('轻触开关');
    expect(value.icon).toBe('assets/device-icon.svg');
    expect(value.designatorPrefix).toBe('S');
    expect(value.entries).toEqual({ view3d: 'views/3d/index.js' });
    expect(Object.keys(value.properties ?? {})).toEqual([
      'label',
      'debounceSamples',
      'actuationForce',
      'travel',
      'normallyClosed',
      'capColor',
      'mode',
      'icon',
      'profile',
      'firmware',
    ]);
    const firmware = value.properties?.['firmware'];
    expect(firmware?.type).toBe('firmware');
    expect(firmware?.addressSpaces).toEqual({
      code: { title: '程序存储器', start: 0, size: 8192 },
    });
    expect(firmware?.addressSpace).toBe('code');
    expect(firmware?.loadAddress).toBe(0);
    expect(value.properties?.['profile']?.extensions).toEqual(['.bin', '.hex']);
    expect(Object.keys(value.pins ?? {})).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(value.model?.entry).toBe('model.js');
    expect(Object.keys(value.model?.methods ?? {})).toEqual(['press', 'getStatus']);
    expect(Object.keys(value.model?.events ?? {})).toEqual(['onDidStateChange']);
    expect(value.model?.types?.['ButtonState']).toEqual({
      type: 'object',
      properties: {
        pressed: { type: 'boolean' },
        samples: { type: 'array', items: { type: 'number' } },
      },
      optional: ['samples'],
      additionalProperties: { type: 'string' },
    });
    expect(value.view2d).toEqual({
      geometry: 'views/2d/geometry.json',
      entry: 'views/2d/index.js',
    });
    expect(value.view?.['monitor']).toEqual({
      title: '按键状态',
      entry: 'views/index.html',
      defaultLocation: 'sidebar',
      icon: 'dashboard',
    });
  });

  it('parses JSON text and returns an immutable snapshot', () => {
    const value = parseUnifiedManifest(JSON.stringify(manifest()));

    expect(value.publisher).toBe('example');
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.engines)).toBe(true);
  });

  it('tolerates package-manager fields without interpreting them', () => {
    const value = parseUnifiedManifest(
      manifest({ scripts: { test: 'vitest' }, files: ['dist'], author: 'someone', private: true }),
    );

    expect(value.displayName).toBe('轻触开关');
  });

  it('rejects an invalid publisher identity', () => {
    const error = parseError(manifest({ publisher: 'Example' }));

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/publisher']);
  });

  it('rejects a version that is not full SemVer', () => {
    const error = parseError(manifest({ version: '1.0' }));

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/version']);
  });

  it('rejects an unknown root field', () => {
    const error = parseError(manifest({ geometry: {} }));

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/geometry']);
  });

  it('rejects an unsupported entry mapping', () => {
    const error = parseError(
      manifest({ entries: { view3d: 'views/3d/index.js', view2d: 'x.js' } }),
    );

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/entries/view2d']);
  });

  it('rejects an unknown model field', () => {
    const error = parseError(manifest({ model: { entry: 'model.js', props: {} } }));

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/model/props']);
  });

  it('rejects an entry outside the package root', () => {
    const error = parseError(manifest({ model: { entry: '../model.js' } }));

    expect(codesOf(error)).toEqual(['package/invalid-path']);
    expect(pointersOf(error)).toEqual(['/model/entry']);
  });

  it('rejects a model entry that is not a script', () => {
    const error = parseError(manifest({ model: { entry: 'model.mjs' } }));

    expect(codesOf(error)).toEqual(['package/invalid-path']);
    expect(pointersOf(error)).toEqual(['/model/entry']);
  });

  it('rejects an icon that is not a PNG or SVG', () => {
    const error = parseError(manifest({ icon: 'assets/device-icon.gif' }));

    expect(codesOf(error)).toEqual(['package/invalid-icon']);
    expect(pointersOf(error)).toEqual(['/icon']);
  });

  it('requires a model for a device that declares pins', () => {
    const error = parseError(manifest({ pins: { a1: { label: '1' } } }));

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/model']);
  });

  it('rejects a pin declaration with an unknown field', () => {
    const error = parseError(
      manifest({ pins: { a1: { label: '1', footprint: '4' } }, model: { entry: 'model.js' } }),
    );

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/pins/a1/footprint']);
  });

  it('rejects a pin id that is not a legal model pin name', () => {
    const error = parseError(
      manifest({ pins: { 'a-1': { label: '1' } }, model: { entry: 'model.js' } }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/pins/a-1']);
  });

  it('rejects an unknown public type reference', () => {
    const error = parseError(
      manifest({
        model: {
          entry: 'model.js',
          methods: { read: { params: { type: 'null' }, returns: { ref: 'Missing' } } },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['type/unknown']);
    expect(pointersOf(error)).toEqual(['/model/methods/read/returns/ref']);
  });

  it('rejects a cycle of "ref" declarations', () => {
    const error = parseError(
      manifest({
        model: {
          entry: 'model.js',
          types: { Loop: { ref: 'Loop' } },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['model/invalid-interface']);
    expect(pointersOf(error)).toEqual(['/model/types/Loop']);
  });

  it('rejects an optional property that is not declared', () => {
    const error = parseError(
      manifest({
        model: {
          entry: 'model.js',
          types: {
            State: { type: 'object', properties: {}, optional: ['pressed'] },
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['model/invalid-interface']);
    expect(pointersOf(error)).toEqual(['/model/types/State/optional/0']);
  });

  it('rejects an event key that is not an onDidXxx name', () => {
    const error = parseError(
      manifest({
        model: { entry: 'model.js', events: { brightnessChange: { type: 'number' } } },
      }),
    );

    expect(codesOf(error)).toEqual(['model/invalid-interface']);
    expect(pointersOf(error)).toEqual(['/model/events/brightnessChange']);
  });

  it('rejects a property default that violates its own description', () => {
    const error = parseError(
      manifest({
        properties: {
          debounceSamples: {
            type: 'integer',
            default: 0,
            min: 1,
            max: 32,
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/debounceSamples/default']);
  });

  it('rejects a constraint that belongs to another property type', () => {
    const error = parseError(manifest({ properties: { text: { type: 'string', maxBytes: 16 } } }));

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/properties/text/maxBytes']);
  });

  it('rejects a declared file default that is not a package resource', () => {
    const error = parseError(
      manifest({
        properties: {
          icon: {
            type: 'image',
            nullable: true,
            default: { src: 'assets/icon.png', mode: 'file' },
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/icon/default/mode']);
  });

  it('rejects a null default on a non-nullable property', () => {
    const error = parseError(
      manifest({
        properties: {
          mode: { type: 'enum', options: [{ value: 'a', label: 'A' }], default: null },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/mode/default']);
  });

  it('rejects a firmware description without an address space', () => {
    const error = parseError(
      manifest({
        properties: {
          firmware: {
            type: 'firmware',
            nullable: true,
            addressSpaces: { code: { start: 0, size: 1024 } },
            addressSpace: 'data',
            loadAddress: 0,
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/firmware/addressSpace']);
  });

  it('rejects a load address outside the declared range', () => {
    const error = parseError(
      manifest({
        properties: {
          firmware: {
            type: 'firmware',
            nullable: true,
            addressSpaces: { code: { start: 0, size: 256 } },
            addressSpace: 'code',
            loadAddress: 256,
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/firmware/loadAddress']);
  });

  it('rejects duplicate extension filters after ASCII case folding', () => {
    const error = parseError(
      manifest({
        properties: { profile: { type: 'binary', extensions: ['.bin', '.BIN'] } },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/properties/profile/extensions/1']);
  });

  it('validates inline geometry pins against the manifest pins', () => {
    const error = parseError(
      manifest({
        pins: { a1: {}, b1: {} },
        model: { entry: 'model.js' },
        view2d: {
          geometry: {
            sizing: 'physical',
            bounds: { x: 0, y: 0, width: 4, height: 4 },
            bodyBounds: { x: 0, y: 0, width: 4, height: 4 },
            pins: { a1: { position: { x: 0, y: 1 }, outward: { x: -1, y: 0 } } },
          },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['view2d/pin-mismatch']);
    expect(pointersOf(error)).toEqual(['/view2d/geometry/pins']);
  });

  it('accepts inline geometry whose pins match', () => {
    const value = parseUnifiedManifest(
      manifest({
        pins: { a1: {} },
        model: { entry: 'model.js' },
        view2d: {
          geometry: {
            sizing: 'flexible',
            bounds: { x: 0, y: 0, width: 4, height: 4 },
            bodyBounds: { x: 1, y: 1, width: 2, height: 2 },
            pins: { a1: { position: { x: 0, y: 1 }, outward: { x: -1, y: 0 } } },
          },
        },
      }),
    );

    expect(value.view2d?.geometry).toMatchObject({ sizing: 'flexible' });
  });

  it('rejects an HTML view without a title', () => {
    const error = parseError(manifest({ view: { monitor: { entry: 'views/index.html' } } }));

    expect(codesOf(error)).toEqual(['schema/missing-field']);
    expect(pointersOf(error)).toEqual(['/view/monitor/title']);
  });

  it('rejects an HTML view icon that is not a Codicons name', () => {
    const error = parseError(
      manifest({
        view: { monitor: { title: 'M', entry: 'views/index.html', icon: 'Not An Icon' } },
      }),
    );

    expect(codesOf(error)).toEqual(['package/invalid-manifest']);
    expect(pointersOf(error)).toEqual(['/view/monitor/icon']);
  });

  it('rejects a non-object manifest', () => {
    const error = parseError([]);

    expect(codesOf(error)).toEqual(['json/not-object']);
  });
});
