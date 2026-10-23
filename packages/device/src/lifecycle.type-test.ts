import { createScheduler } from '@mica-js/core';
import type {
  BytesOutputRef,
  BytesRef,
  EntryRef,
  InboxRef,
  IRDeclarations,
  LifecycleRef,
  OutputRef,
} from '@mica-js/ir';
import {
  createDeviceInstance,
  type DeviceAPI,
  type DeviceBindings,
  type DeviceFactory,
  type DeviceInstance,
  type DeviceInstanceOptions,
  type DeviceInstanceState,
  type LoadedDeviceModule,
  type TopicPayload,
  type Unsubscribe,
} from './index';

declare const loaded: LoadedDeviceModule;
declare const api: DeviceAPI;
declare const initialized: LifecycleRef<readonly []>;
declare const parameterized: LifecycleRef<readonly ['u32']>;
declare const setValue: EntryRef<readonly ['u32']>;
declare const receiveBytes: EntryRef<readonly ['u32', 'u32']>;
declare const inbox: InboxRef;
declare const scalarOutput: OutputRef<readonly ['u32', 'bool']>;
declare const bytesOutput: BytesOutputRef;
declare const bytesResource: BytesRef<false>;

const scheduler = createScheduler();
const options: DeviceInstanceOptions = {
  instanceId: 'typed',
  properties: {},
  messaging: { postCapacity: 8, outputByteBudget: 1024 },
  updateResources: ['firmware'],
  onTopic: (message) => {
    const payload: TopicPayload = message.payload;
    void [message.port, payload];
  },
};
const instance: DeviceInstance = createDeviceInstance(loaded, scheduler, options);
const state: DeviceInstanceState = instance.state;
const declarations: IRDeclarations = api.ir;
const bindings: DeviceBindings = { initialize: initialized, onDispose: () => undefined };
const factory: DeviceFactory = (context) => {
  const value = context.ir.state('value', 'u32', 0);
  const initialize = context.ir.lifecycle('initialize', []);
  initialize.body((b) => {
    b.state.store(value, b.const('u32', 1));
    b.return([]);
  });
  return { initialize, onDispose: () => undefined };
};

const unsubscribeTopic: Unsubscribe = api.subscribe('value', (payload, meta) => {
  const time: number = meta.simTime;
  void [payload, time];
});
const unsubscribeOutput: Unsubscribe = api.onOutput(scalarOutput, ([value, enabled], meta) => {
  const captured: number = meta.timePs;
  void [value, enabled, captured];
});
void api.onOutput(bytesOutput, (bytes, meta) => {
  const captured: number = meta.timePs;
  void [bytes.byteLength, captured];
});
api.publish('value', true);
api.publish('vector', { x: 1, y: 2 });
void api.post(setValue, [1]);
void api.postBytes(receiveBytes, inbox, new Uint8Array(1));
void api.updateBytes(bytesResource, 0, new Uint8Array(1));
instance.deliver('value', 1, { simTime: 0 });
// @ts-expect-error updateResources is a list of declared resource names, not refs or numbers
const invalidOptions: DeviceInstanceOptions = { instanceId: 'typed', updateResources: [1] };
void invalidOptions;

void [
  instance,
  state,
  declarations,
  bindings,
  factory,
  api.props,
  unsubscribeTopic,
  unsubscribeOutput,
];

// @ts-expect-error lifecycle bindings require zero parameters
const wrongBinding: DeviceBindings = { initialize: parameterized };
// @ts-expect-error a Promise is not a synchronous binding object
const asyncFactory: DeviceFactory = async () => ({});
// @ts-expect-error options are mandatory
createDeviceInstance(loaded, scheduler);
// @ts-expect-error instance state is readonly
instance.state = 'ready';
// @ts-expect-error props are recursively readonly
api.props['x'] = 1;
// @ts-expect-error the raw module surface is not exposed to factories
const moduleSurface = api.ir.functions;
// @ts-expect-error domain declarations are not part of the #53 context
const domainSurface = api.ir.domainInstruction;
// @ts-expect-error reset has no result
const resetResult: undefined = instance.reset();
// @ts-expect-error destroy has no result
const destroyResult: undefined = instance.destroy();
// @ts-expect-error publish payload must be a topic payload, not a function
api.publish('value', () => undefined);
// @ts-expect-error post arguments are captured JS scalars, not SSA handles
api.post(setValue, [api.ir.state('other', 'u32', 0)]);
// @ts-expect-error delivery metadata requires simTime
instance.deliver('value', 1, {});
void [wrongBinding, asyncFactory, moduleSurface, domainSurface, resetResult, destroyResult];
