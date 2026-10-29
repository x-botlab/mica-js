// The ambient module is declared in `virtual-runtime.d.ts`; referencing it keeps workspace
// consumers that compile this source aware of the `?audio-worklet` queries.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./virtual-runtime.d.ts" />

export type { Disposable, Event } from '@mica-js/core/lifecycle';

export type {
  PortDefinition,
  PropertyDefinition,
  WidgetDefinition,
  WidgetModule,
  WidgetProvider,
} from './types';

export { WidgetLoadError } from './errors';
export type { WidgetLoadErrorCode, WidgetLoadErrorOptions } from './errors';

export { loadWidgetPackage } from './package/load';
export type { PackageFiles, WidgetPackage } from './package/load';

export { createStaticWidgetProvider } from './package/static-provider';
export { createPackageWidgetProvider } from './package/package-provider';
export type { PackageWidgetProviderOptions } from './package/package-provider';

export type { HostFs } from './host-fs/types';
export {
  HostFsError,
  fromHostFsErrorPayload,
  isHostFsError,
  toHostFsErrorPayload,
} from './host-fs/errors';
export type { HostFsErrorCode, HostFsErrorOptions, HostFsErrorPayload } from './host-fs/errors';
export { decodeDataUri, decodeDataUriText } from './host-fs/data-uri';
export { isAbsoluteHostUri, resolveHostUri } from './host-fs/uri';

export { createWidgetHost } from './host/widget-host';
export { createWidgetSandboxFromWorker } from './host/sandbox';
export { createWidgetHostGuestSandbox, widgetGuestScript } from './host/guest';
export { createWidgetAudioWorklet, widgetAudioWorkletUrl } from './host/audio/worklet';
export type {
  Widget,
  WidgetAssetProvider,
  WidgetBinding,
  WidgetDiagnostic,
  WidgetDiagnosticCode,
  WidgetHost,
  WidgetHostFrameOptions,
  WidgetHostMode,
  WidgetHostOptions,
  WidgetInstance,
  WidgetLayer,
  WidgetLayerChange,
  WidgetLayers,
  WidgetPublish,
  WidgetSandbox,
  WidgetSandboxAudio,
  WidgetSandboxFactory,
  WidgetSandboxHostOptions,
} from './host/types';
export type {
  WidgetAssetApi,
  WidgetAssetRef,
  WidgetDeliveryMeta,
  WidgetFactory,
  WidgetInputEvent,
  WidgetImplementation,
  WidgetInstanceApi,
  WidgetPortListener,
} from './guest/widget/types';
export type {
  WidgetAudioApi,
  WidgetAudioEnded,
  WidgetAudioEndReason,
  WidgetAudioFormat,
  WidgetAudioRampOptions,
  WidgetAudioState,
  WidgetAudioStopOptions,
  WidgetAudioStream,
  WidgetAudioStreamOptions,
  WidgetAudioStreamState,
  WidgetAudioStreamStatus,
  WidgetAudioTone,
  WidgetAudioToneOptions,
  WidgetAudioVoice,
  WidgetAudioVoiceSettings,
  WidgetOscillatorType,
} from './guest/audio/types';
export type {
  WidgetAudioControls,
  WidgetAudioLimits,
  WidgetAudioOptions,
} from './host/audio/types';
