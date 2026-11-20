/**
 * Test-only bridge between a unified model factory and the legacy simulator `DeviceFactory`.
 *
 * The production SDK dropped `adaptModelFactory` and `firmwareImage`; only the project-local
 * correctness oracles and benchmarks still build a legacy board from unified packages. This
 * module stays outside every published device package and must not be imported by `src/`.
 */

function readonlyByteView(bytes) {
  const copy = bytes.slice();
  const target = Object.freeze({
    get length() {
      return copy.length;
    },
    get byteLength() {
      return copy.length;
    },
    slice(start, end) {
      return copy.slice(start, end);
    },
    *[Symbol.iterator]() {
      yield* copy;
    },
  });
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return copy[Number(key)];
      return Reflect.get(object, key, receiver);
    },
    set() {
      throw new TypeError('Bytes are read-only');
    },
    defineProperty() {
      throw new TypeError('Bytes are read-only');
    },
  });
}

/**
 * Captures, validates and sorts an immutable firmware image for a factory property.
 *
 * Segment data is copied, so later mutation of the caller's bytes cannot reach the model.
 */
export function firmwareImage(segments) {
  if (!Array.isArray(segments) || segments.length === 0)
    throw new TypeError('Firmware image must contain at least one segment');
  const captured = segments.map((segment) => {
    if (typeof segment.addressSpace !== 'string' || segment.addressSpace.length === 0)
      throw new TypeError('Firmware segment addressSpace must be a nonempty string');
    if (!Number.isSafeInteger(segment.address) || segment.address < 0)
      throw new RangeError('Firmware segment address must be a nonnegative safe integer');
    if (!(segment.data instanceof Uint8Array))
      throw new TypeError('Firmware segment data must be a Uint8Array');
    if (segment.data.length === 0) throw new RangeError('Firmware segment data must not be empty');
    if (!Number.isSafeInteger(segment.address + segment.data.length))
      throw new RangeError('Firmware segment range must be a safe integer');
    return Object.freeze({
      addressSpace: segment.addressSpace,
      address: segment.address,
      data: readonlyByteView(segment.data),
    });
  });
  captured.sort((left, right) => {
    if (left.addressSpace < right.addressSpace) return -1;
    if (left.addressSpace > right.addressSpace) return 1;
    return left.address - right.address;
  });
  let previous;
  for (const segment of captured) {
    const end = segment.address + segment.data.length;
    if (previous !== undefined && previous.addressSpace === segment.addressSpace) {
      if (segment.address < previous.end)
        throw new RangeError(
          `Firmware segments overlap in address space "${segment.addressSpace}"`,
        );
    }
    previous = { addressSpace: segment.addressSpace, end };
  }
  return Object.freeze({ segments: Object.freeze(captured) });
}

function byteSnapshot(value) {
  const candidate = value;
  return (
    typeof candidate.slice === 'function' &&
    typeof candidate.byteLength === 'number' &&
    typeof candidate.length === 'number'
  );
}

/** Copies and deeply freezes factory properties; each adapter instance receives its own aliases. */
function snapshotProps(value, seen = new Set()) {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'number' || kind === 'string') return value;
  if (value instanceof Uint8Array) return readonlyByteView(value);
  if (kind !== 'object') throw new TypeError('Adapter props must contain only data values');
  if (seen.has(value)) throw new TypeError('Adapter props must be acyclic');
  seen.add(value);
  try {
    if (byteSnapshot(value)) return readonlyByteView(value.slice());
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshotProps(item, seen)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError(
        'Adapter props must contain only plain objects, arrays and byte snapshots',
      );
    const copy = {};
    for (const [key, item] of Object.entries(value))
      Object.defineProperty(copy, key, {
        value: snapshotProps(item, seen),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}

function eventConfig(value) {
  return typeof value === 'string' ? { topic: value } : value;
}

function inputConfig(value) {
  return typeof value === 'string' ? { method: value } : value;
}

/**
 * Connects a unified model factory to the legacy simulator boundary.
 *
 * It forwards sync batches, publishes configured model events as legacy topics and invokes
 * configured model methods for legacy topics. Full resolved properties (including firmware and
 * resource snapshots) must be supplied explicitly when the legacy board cannot represent them.
 */
export function adaptModelFactory(factory, options = {}) {
  return (context) => {
    const { topics, props: legacyProps, ...capabilities } = context;
    void legacyProps;
    const resolved =
      typeof options.props === 'function'
        ? options.props(context)
        : (options.props ?? context.props);
    const isolated = snapshotProps(resolved);
    const events = {};
    for (const [name, raw] of Object.entries(options.events ?? {})) {
      const config = eventConfig(raw);
      events[name] = Object.freeze({
        fire(value) {
          topics.publish(config.topic, config.transform ? config.transform(value) : value);
        },
        fireTransferred(value) {
          topics.publish(config.topic, config.transform ? config.transform(value) : value);
        },
      });
    }
    Object.freeze(events);
    const discarded = Object.freeze({ fire() {}, fireTransferred() {} });
    const eventSink = new Proxy(events, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !Object.hasOwn(target, key)) return discarded;
        return Reflect.get(target, key, receiver);
      },
    });
    const instance = factory({ ...capabilities, props: isolated, events: eventSink });
    const subscriptions = [];
    if (options.inputs !== undefined && Object.keys(options.inputs).length > 0) {
      const mappings = new Map(
        Object.entries(options.inputs).map(([topic, raw]) => [topic, inputConfig(raw)]),
      );
      subscriptions.push(
        topics.onDidReceive(({ topic, payload }) => {
          const mapping = mappings.get(topic);
          if (mapping === undefined) return;
          const method = instance.methods[mapping.method];
          if (typeof method !== 'function') {
            context.reportError(
              new Error(`Legacy topic "${topic}" maps to unknown model method "${mapping.method}"`),
            );
            return;
          }
          try {
            const result = method(mapping.params ? mapping.params(payload) : payload);
            if (result !== null && typeof result?.then === 'function')
              context.reportError(new Error(`Model method "${mapping.method}" returned a thenable`));
          } catch (error) {
            context.reportError(error);
          }
        }),
      );
    }
    let disposed = false;
    return {
      methods: instance.methods,
      sync(batch) {
        instance.sync(batch);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        let failure;
        for (const subscription of subscriptions.splice(0).reverse()) {
          try {
            subscription.dispose();
          } catch (error) {
            failure ??= error;
          }
        }
        try {
          instance.dispose();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      },
    };
  };
}
