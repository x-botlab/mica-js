import { describe, expect, it } from 'vitest';
import { editorSnapshot } from './snapshot';

describe('editorSnapshot', () => {
  it('detaches and freezes nested document and selection data', () => {
    const source = { widgets: [{ id: 'widget', properties: { label: 'Initial' } }] };
    const snapshot = editorSnapshot(source);
    expect(snapshot).toEqual(source);
    expect(snapshot).not.toBe(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.widgets)).toBe(true);
    expect(Object.isFrozen(snapshot.widgets[0]?.properties)).toBe(true);
    expect(() => {
      snapshot.widgets[0]!.properties.label = 'Host edit';
    }).toThrow(TypeError);
    source.widgets[0]!.properties.label = 'Next source value';
    expect(snapshot.widgets[0]?.properties.label).toBe('Initial');
  });

  it('keeps private copies of binary values without freezing populated typed arrays', () => {
    const source = { bytes: new Uint8Array([1, 2]) };
    const snapshot = editorSnapshot(source);
    snapshot.bytes[0] = 9;
    expect(source.bytes[0]).toBe(1);
    expect(snapshot.bytes[0]).toBe(9);
  });

  it('accepts optional values and shared nested references', () => {
    const target = { id: 'symbol' };
    const snapshot = editorSnapshot({ a: target, b: target, optional: undefined });
    expect(snapshot.a).toBe(snapshot.b);
    expect(snapshot.a).not.toBe(target);
    expect(snapshot.optional).toBeUndefined();
    expect(editorSnapshot(undefined)).toBeUndefined();
  });
});
