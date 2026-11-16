import { describe, expect, it } from 'vitest';
import { parseFusedDocument } from './document';
import {
  INSTANCE_ID,
  NODE_ID,
  OTHER_INSTANCE_ID,
  catchError,
  codesOf,
  documentValue,
  instance,
  pointersOf,
  rfcExample,
} from './test-helpers';

function parseError(value: unknown): ReturnType<typeof catchError> {
  return catchError(() => parseFusedDocument(value));
}

describe('parseFusedDocument', () => {
  it('parses the full RFC 0024 example', () => {
    const value = parseFusedDocument(rfcExample('0024-fused-schematic.json'));

    expect(value.version).toBe(2);
    expect(Object.keys(value.dependencies)).toEqual(['example:button', 'example:label']);
    expect(value.instances).toHaveLength(2);
    expect(value.instances[0]?.designator).toBe('S1');
    expect(value.instances[0]?.properties?.['firmware']).toEqual({
      mode: 'project',
      projectId: 'controller',
      addressSpace: 'code',
      loadAddress: 256,
    });
    expect(value.instances[0]?.viewLayout?.views[0]).toEqual({
      viewId: 'monitor',
      location: 'floating',
      height: 240,
      collapsed: false,
      floatingBounds: { x: 40, y: 60, width: 480, height: 320 },
    });
    expect(value.instances[1]?.placement).toEqual({
      x: 10,
      y: 3,
      rotation: 0,
      width: 30,
      height: 8,
    });
    expect(value.nodes).toHaveLength(2);
    expect(value.wires[0]?.bends).toEqual([{ x: 14, y: 16 }]);
    expect(value.labels[0]?.name).toBe('KEY');
    expect(value.references[0]).toMatchObject({
      voltage: 5,
      symbol: 'power',
      rotation: 90,
      label: { name: 'VCC', offset: { x: 0, y: -2 } },
    });
    expect(value.references[1]).toMatchObject({ voltage: 0, symbol: 'ground', rotation: 0 });
    expect(value.display).toEqual({ body: true, designators: false });
  });

  it('parses JSON text and returns an immutable snapshot', () => {
    const value = parseFusedDocument(JSON.stringify(documentValue()));

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.instances)).toBe(true);
  });

  it('rejects the previous schematic version', () => {
    const error = parseError(documentValue({ version: 1 }));

    expect(codesOf(error)).toEqual(['schema/unsupported-version']);
    expect(pointersOf(error)).toEqual(['/version']);
  });

  it('rejects an unknown root field', () => {
    const error = parseError(documentValue({ sheet: {} }));

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/sheet']);
  });

  it('rejects an instance id that is used twice', () => {
    const error = parseError(
      documentValue({
        instances: [instance(), instance({ designator: 'S2' })],
      }),
    );

    expect(codesOf(error)).toEqual(['document/duplicate-id']);
    expect(pointersOf(error)).toEqual(['/instances/1/id']);
  });

  it('rejects a saved designator that is used twice', () => {
    const error = parseError(
      documentValue({
        instances: [instance(), instance({ id: OTHER_INSTANCE_ID, device: 'example:button' })],
      }),
    );

    expect(codesOf(error)).toEqual(['document/duplicate-designator']);
    expect(pointersOf(error)).toEqual(['/instances/1/designator']);
  });

  it('rejects an instance whose device is not locked', () => {
    const error = parseError(documentValue({ instances: [instance({ device: 'example:label' })] }));

    expect(codesOf(error)).toEqual(['document/unlocked-device']);
    expect(pointersOf(error)).toEqual(['/instances/0/device']);
  });

  it('rejects a wire endpoint on an unknown instance', () => {
    const error = parseError(
      documentValue({
        wires: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            from: { kind: 'pin', instance: OTHER_INSTANCE_ID, pin: 'a1' },
            to: { kind: 'node', node: NODE_ID },
            bends: [],
          },
        ],
        nodes: [{ id: NODE_ID, kind: 'free', x: 1, y: 2 }],
      }),
    );

    expect(codesOf(error)).toEqual(['connection/unknown-endpoint']);
    expect(pointersOf(error)).toEqual(['/wires/0/from/instance']);
  });

  it('rejects a label on an unknown node', () => {
    const error = parseError(
      documentValue({
        labels: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            target: { kind: 'node', node: NODE_ID },
            name: 'KEY',
          },
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['connection/unknown-endpoint']);
    expect(pointersOf(error)).toEqual(['/labels/0/target/node']);
  });

  it('rejects a wire that connects an endpoint to itself', () => {
    const error = parseError(
      documentValue({
        wires: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            from: { kind: 'pin', instance: INSTANCE_ID, pin: 'a1' },
            to: { kind: 'pin', instance: INSTANCE_ID, pin: 'a1' },
            bends: [],
          },
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['connection/self-edge']);
    expect(pointersOf(error)).toEqual(['/wires/0/to']);
  });

  it('rejects a ground symbol with a non-zero voltage', () => {
    const error = parseError(
      documentValue({
        nodes: [{ id: NODE_ID, kind: 'free', x: 1, y: 2 }],
        references: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            target: { kind: 'node', node: NODE_ID },
            voltage: 5,
            symbol: 'ground',
          },
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/references/0/voltage']);
  });

  it('rejects a symbol label without a symbol', () => {
    const error = parseError(
      documentValue({
        nodes: [{ id: NODE_ID, kind: 'free', x: 1, y: 2 }],
        references: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            target: { kind: 'node', node: NODE_ID },
            voltage: 5,
            label: { name: 'VCC' },
          },
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/references/0/label']);
  });

  it('rejects a flexible placement that declares only a width', () => {
    const error = parseError(
      documentValue({
        instances: [instance({ placement: { x: 0, y: 0, rotation: 0, width: 10 } })],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/instances/0/placement']);
  });

  it('rejects a duplicate view id in one layout', () => {
    const view = { viewId: 'monitor', location: 'sidebar', height: 200, collapsed: false };
    const error = parseError(
      documentValue({
        instances: [
          instance({
            viewLayout: { properties: { height: 200, collapsed: false }, views: [view, view] },
          }),
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['document/invalid-view-layout']);
    expect(pointersOf(error)).toEqual(['/instances/0/viewLayout/views/1']);
  });

  it('rejects a layout height that is not positive', () => {
    const error = parseError(
      documentValue({
        instances: [
          instance({ viewLayout: { properties: { height: 0, collapsed: false }, views: [] } }),
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['document/invalid-view-layout']);
    expect(pointersOf(error)).toEqual(['/instances/0/viewLayout/properties/height']);
  });

  it('rejects a dependency with an invalid integrity digest', () => {
    const error = parseError(
      documentValue({
        dependencies: { 'example:button': { version: '1.0.0', integrity: 'sha256:abc' } },
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/dependencies/example:button/integrity']);
  });

  it('rejects a dependency with a short SemVer version', () => {
    const error = parseError(
      documentValue({
        dependencies: {
          'example:button': { version: '1.0', integrity: `sha256:${'0'.repeat(64)}` },
        },
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/dependencies/example:button/version']);
  });

  it('rejects a dependency key that is not a publisher:name pair', () => {
    const error = parseError(
      documentValue({
        dependencies: { button: { version: '1.0.0', integrity: `sha256:${'0'.repeat(64)}` } },
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/dependencies/button']);
  });

  it('rejects a project firmware reference that also carries a path', () => {
    const error = parseError(
      documentValue({
        instances: [
          instance({
            properties: { firmware: { mode: 'project', projectId: 'p', src: 'main.bin' } },
          }),
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/instances/0/properties/firmware/src']);
  });

  it('rejects an unknown resource mode', () => {
    const error = parseError(
      documentValue({
        instances: [instance({ properties: { icon: { src: 'a.png', mode: 'remote' } } })],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/instances/0/properties/icon/mode']);
  });

  it('rejects a file resource that escapes the project root', () => {
    const error = parseError(
      documentValue({
        instances: [instance({ properties: { icon: { src: '../a.png', mode: 'file' } } })],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/instances/0/properties/icon/src']);
  });

  it('accepts every firmware source of the RFC 0026 example', () => {
    const sources = rfcExample('0026-firmware-sources.json') as Record<string, unknown>;
    const properties = Object.fromEntries(
      Object.entries(sources).map(([key, value]) => [key, value]),
    );
    const value = parseFusedDocument(documentValue({ instances: [instance({ properties })] }));

    expect(value.instances[0]?.properties).toEqual(sources);
  });

  it('rejects a negative firmware load address override', () => {
    const error = parseError(
      documentValue({
        instances: [
          instance({
            properties: { firmware: { mode: 'file', src: 'main.bin', loadAddress: -1 } },
          }),
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/instances/0/properties/firmware/loadAddress']);
  });

  it('rejects a bare inline firmware reference with an address override', () => {
    const error = parseError(
      documentValue({
        instances: [
          instance({
            properties: { firmware: { mode: 'inline', src: 'AAAA', addressSpace: 'code' } },
          }),
        ],
      }),
    );

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/instances/0/properties/firmware/addressSpace']);
  });
});
