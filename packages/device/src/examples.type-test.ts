import type { EntryRef, FunctionRef, LifecycleRef, Value } from '@mica-js/ir';
import type {
  ConnectionRef,
  DeviceAPI,
  DeviceBindings,
  DeviceFactory,
  ObserverRef,
  PinRef,
  Unsubscribe,
} from './index';

/**
 * Compile-time mirrors of `examples/ideal-button/*.js` and `examples/ideal-relay/*.js`.
 *
 * The shipped examples must stay plain `.js` (#11 pairing), so this file keeps their combined
 * author surface - pins, connections, entries, observeDigital, subscribe/post and lifecycle -
 * under `tsc` without duplicating them as runtime tests.
 */
export function createIdealButton(api: DeviceAPI): DeviceBindings {
  const contact: ConnectionRef = api.ir.connection('contact');
  const setPressed: EntryRef<readonly ['bool']> = api.ir.entry('setPressed', ['bool']);
  const initialize: LifecycleRef<readonly []> = api.ir.lifecycle('initialize', []);
  const reset: LifecycleRef<readonly []> = api.ir.lifecycle('reset', []);

  setPressed.body((b, [pressed]) => {
    b.connection.apply([{ connection: contact, closed: pressed }]);
    b.return([]);
  });
  initialize.body((b) => {
    b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
    b.return([]);
  });
  reset.body((b) => {
    b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
    b.return([]);
  });

  const stop: Unsubscribe = api.subscribe('pressed', (pressed) => {
    // The JS example posts the payload directly and the runtime validates it against the
    // declared `boolean` port; a TypeScript author narrows the topic union first.
    if (typeof pressed !== 'boolean') {
      return;
    }
    return api.post(setPressed, [pressed]);
  });
  return { initialize, reset, onDispose: stop };
}

export function createIdealRelay(api: DeviceAPI): DeviceBindings {
  const ir = api.ir;
  const input: PinRef = ir.pin('IN');
  const normallyOpen: ConnectionRef = ir.connection('normallyOpen');
  const normallyClosed: ConnectionRef = ir.connection('normallyClosed');
  const apply: FunctionRef<readonly ['u32'], readonly []> = ir.func('apply', {
    params: ['u32'],
    results: [],
  });
  const changed: EntryRef<readonly ['u8', 'u32']> = ir.entry('changed', ['u8', 'u32']);
  const observation: ObserverRef = ir.observeDigital('control', {
    trigger: input,
    captures: [input],
    target: changed,
  });
  const initialize: LifecycleRef<readonly []> = ir.lifecycle('initialize', []);

  apply.body((b, [sample]) => {
    const active: Value<'bool'> = b.int.cmp(
      'ne',
      b.int.and(sample, b.const('u32', 1)),
      b.const('u32', 0),
    );
    b.connection.apply([
      { connection: normallyOpen, closed: active },
      { connection: normallyClosed, closed: b.bool.not(active) },
    ]);
    b.return([]);
  });
  changed.body((b, [, captured]) => {
    b.call(apply, [captured]);
    b.return([]);
  });
  initialize.body((b) => {
    b.pin.configure(input, { mode: 'high-z', outputEnabled: false, pull: 'none' });
    b.call(apply, [b.pin.sampleDigital(input)]);
    b.observe.configure(observation, { enabled: true, edges: 'both' });
    b.return([]);
  });
  return { initialize };
}

declare const api: DeviceAPI;
const buttonFactory: DeviceFactory = createIdealButton;
const relayFactory: DeviceFactory = createIdealRelay;
const buttonBindings: DeviceBindings = createIdealButton(api);
const relayBindings: DeviceBindings = createIdealRelay(api);

// Combination regressions the per-domain type tests do not cover.
const pressedEntry = api.ir.entry('setPressed', ['bool']);
api.subscribe('pressed', (pressed) => {
  // @ts-expect-error a topic payload is the whole union; post requires the narrowed boolean
  return api.post(pressedEntry, [pressed]);
});
const wrongCapture = api.ir.entry('changed', ['u8']);
api.ir.observeDigital('control', {
  trigger: api.ir.pin('IN'),
  captures: [api.ir.pin('IN')],
  // @ts-expect-error one captured pin requires the entry to accept one extra u32
  target: wrongCapture,
});
const relayPin = api.ir.pin('IN');
const run = api.ir.entry('run', []);
run.body((b) => {
  // @ts-expect-error pin.writeDigital takes an SSA bool, not an integer value
  b.pin.writeDigital(relayPin, b.const('u32', 1));
  b.return([]);
});

void [buttonFactory, relayFactory, buttonBindings, relayBindings];
