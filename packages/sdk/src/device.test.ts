import { describe, expect, it, vi } from 'vitest';
import { Emitter, toDisposable } from '@mica-js/core/lifecycle';
import type { DeviceBatch, DeviceContext, TopicMessage } from '@mica-js/simulator';
import {
  adaptModelFactory,
  firmwareImage,
  readonlyBytes,
  type ModelContext,
  type FirmwareImage,
  type ModelEventEmitter,
  type ModelInstance,
  type Value,
} from './device';

const emptyBatch: DeviceBatch = { from: 0, to: 0, outputs: {} };

function context(): {
  context: DeviceContext;
  published: { topic: string; payload: unknown }[];
  dispatch: Emitter<TopicMessage>;
  errors: unknown[];
} {
  const dispatch = new Emitter<TopicMessage>();
  const published: { topic: string; payload: unknown }[] = [];
  const errors: unknown[] = [];
  return {
    dispatch,
    published,
    errors,
    context: {
      props: { label: 'flat' },
      inputs: {},
      memory: {},
      topics: {
        onDidReceive: dispatch.event,
        publish(topic, payload) {
          published.push({ topic, payload });
        },
      },
      loadBytes() {},
      attachJit() {
        return toDisposable(() => {});
      },
      reportError(error) {
        errors.push(error);
      },
    } as DeviceContext,
  };
}

describe('unified device runtime types', () => {
  it('captures read-only bytes and firmware images', () => {
    const source = new Uint8Array([1, 2, 3]);
    const bytes = readonlyBytes(source);
    source[0] = 9;
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(() => {
      (bytes as unknown as number[])[0] = 4;
    }).toThrow(/read-only/);

    const image = firmwareImage([{ addressSpace: 'code', address: 0x100, data: source }]);
    expect(image.segments[0]?.address).toBe(0x100);
    expect(image.segments[0]?.data.slice()).toEqual(new Uint8Array([9, 2, 3]));
    expect(Object.isFrozen(image)).toBe(true);
    expect(Object.isFrozen(image.segments)).toBe(true);

    const sorted = firmwareImage([
      { addressSpace: 'z', address: 0, data: new Uint8Array([1]) },
      { addressSpace: 'a', address: 8, data: new Uint8Array([2]) },
      { addressSpace: 'a', address: 0, data: new Uint8Array([3]) },
    ]);
    expect(sorted.segments.map((segment) => [segment.addressSpace, segment.address])).toEqual([
      ['a', 0],
      ['a', 8],
      ['z', 0],
    ]);
    expect(() => firmwareImage([])).toThrow(/at least one segment/);
    expect(() =>
      firmwareImage([{ addressSpace: 'code', address: 0, data: new Uint8Array() }]),
    ).toThrow(/must not be empty/);
    expect(() =>
      firmwareImage([
        { addressSpace: 'code', address: 0, data: new Uint8Array([1, 2]) },
        { addressSpace: 'code', address: 1, data: new Uint8Array([3]) },
      ]),
    ).toThrow(/overlap/);
    expect(() =>
      firmwareImage([
        {
          addressSpace: 'code',
          address: Number.MAX_SAFE_INTEGER,
          data: new Uint8Array([1]),
        },
      ]),
    ).toThrow(/safe integer/);
  });

  it('deeply snapshots complete props for each adapted instance', () => {
    const { context: legacy } = context();
    const source = new Uint8Array([7]);
    const fullProps = {
      label: 'full',
      nested: { value: 1 },
      firmware: firmwareImage([{ addressSpace: 'code', address: 0, data: source }]),
    };
    const captured: Readonly<Record<string, unknown>>[] = [];
    const factory = (
      ctx: ModelContext<DeviceContext, Record<string, unknown>, Record<string, never>>,
    ) => {
      captured.push(ctx.props);
      return { methods: {}, sync() {}, dispose() {} };
    };
    const adapted = adaptModelFactory(factory, {
      props: () => fullProps as unknown as Record<string, unknown>,
    });
    const first = adapted(legacy);
    const second = adapted(context().context);
    source[0] = 9;
    fullProps.nested.value = 2;
    const firstProps = captured[0]!;
    const nested = firstProps.nested as { value: number };
    const firmware = firstProps.firmware as FirmwareImage;
    expect(nested.value).toBe(1);
    expect(firmware.segments[0]?.data.slice()).toEqual(new Uint8Array([7]));
    expect(Object.isFrozen(firstProps)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(firstProps.firmware)).toBe(true);
    expect(() => {
      nested.value = 3;
    }).toThrow(/read-only|Cannot assign/);
    expect(captured[0]).not.toBe(captured[1]);
    first.dispose();
    second.dispose();
  });

  it('discards events without an explicit legacy mapping', () => {
    const { context: legacy } = context();
    const factory = (ctx: ModelContext<DeviceContext, object, { onDidKnown: Value }>) => {
      (ctx.events as unknown as Record<string, ModelEventEmitter<Value>>).onDidUnknown?.fire(1);
      return { methods: {}, sync() {}, dispose() {} };
    };
    const instance = adaptModelFactory(factory)(legacy);
    expect(() => instance.dispose()).not.toThrow();
  });

  it('maps only explicitly configured model events and inputs', () => {
    const { context: legacy, published, dispatch, errors } = context();
    const calls: unknown[] = [];
    const dispose = vi.fn();
    const factory = (
      ctx: ModelContext<
        DeviceContext,
        { label: string; firmware?: unknown },
        { onDidChange: Value }
      >,
    ): ModelInstance<{ set: (value: Value) => null }, DeviceBatch> => ({
      methods: {
        set(value: Value) {
          calls.push(value);
          ctx.events.onDidChange.fire(value);
          return null;
        },
      },
      sync() {},
      dispose,
    });

    const adapted = adaptModelFactory(factory, {
      props: { label: 'full', firmware: { segments: [] } },
      events: { onDidChange: { topic: 'changed', transform: (value) => ({ value }) } },
      inputs: { command: { method: 'set', params: (payload) => payload } },
    });
    const instance = adapted(legacy);

    expect(instance.methods.set).toBeTypeOf('function');
    instance.sync(emptyBatch);
    instance.methods.set(7);
    expect(calls).toEqual([7]);
    expect(published).toEqual([{ topic: 'changed', payload: { value: 7 } }]);

    dispatch.fire({ topic: 'command', payload: 'go' });
    expect(calls).toEqual([7, 'go']);
    expect(errors).toEqual([]);

    dispatch.fire({ topic: 'unmapped', payload: 'ignored' });
    expect(calls).toEqual([7, 'go']);

    instance.dispose();
    instance.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    dispatch.fire({ topic: 'command', payload: 'after' });
    expect(calls).toEqual([7, 'go']);
  });

  it('reports inputs mapped to a missing method instead of guessing', () => {
    const { context: legacy, dispatch, errors } = context();
    const adapted = adaptModelFactory(
      () => ({
        methods: {},
        sync() {},
        dispose() {},
      }),
      { inputs: { missing: 'unknown' } },
    );
    const instance = adapted(legacy);
    dispatch.fire({ topic: 'missing', payload: true });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(String(errors[0])).toMatch(/unknown model method/);
    instance.dispose();
  });
});
