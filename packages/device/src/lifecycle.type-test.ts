import { createScheduler } from '@mica-js/core';
import type { IRDeclarations, LifecycleRef } from '@mica-js/ir';
import {
  createDeviceInstance,
  type DeviceAPI,
  type DeviceBindings,
  type DeviceFactory,
  type DeviceInstance,
  type DeviceInstanceOptions,
  type DeviceInstanceState,
  type LoadedDeviceModule,
} from './index';

declare const loaded: LoadedDeviceModule;
declare const api: DeviceAPI;
declare const initialized: LifecycleRef<readonly []>;
declare const parameterized: LifecycleRef<readonly ['u32']>;

const scheduler = createScheduler();
const options: DeviceInstanceOptions = { instanceId: 'typed', properties: {} };
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

void [instance, state, declarations, bindings, factory, api.props];

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
// @ts-expect-error the bridge is not part of the #53 context
api.subscribe('port', () => undefined);
// @ts-expect-error the raw module surface is not exposed to factories
const moduleSurface = api.ir.functions;
// @ts-expect-error domain declarations are not part of the #53 context
const domainSurface = api.ir.domainInstruction;
// @ts-expect-error reset has no result
const resetResult: undefined = instance.reset();
// @ts-expect-error destroy has no result
const destroyResult: undefined = instance.destroy();
void [wrongBinding, asyncFactory, moduleSurface, domainSurface, resetResult, destroyResult];
