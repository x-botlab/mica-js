export type {
  BorrowedBytes,
  ReadonlyBytes,
  ChannelMessage,
  Notification,
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  DeviceFactory,
  InputChannel,
  InputNotification,
  TopicBridge,
  TopicMessage,
  JitHost,
  JitOptions,
  JitTranslate,
  JitTranslateInput,
  InstructionHook,
  Disposable,
  Event,
} from '@mica-js/simulator';

/**
 * Author-facing contracts of the unified device model (RFC 0021) and its property values
 * (RFC 0026).
 *
 * Model entries and display entries import the model context, instance, client and payload types
 * from this entry. Runtime implementations (`createHeadlessRuntime`, `prepareFusedSession`,
 * package opening, firmware decoding) and host preparation types stay in `@mica-js/sdk/fused`.
 */
export type {
  AsyncMethods,
  EventListeners,
  Methods,
  ModelClient,
  ModelContext,
  ModelEvent,
  ModelEventEmitter,
  ModelEvents,
  ModelFactory,
  ModelInstance,
  ModelModule,
  Params,
  Result,
  Value,
  ValueType,
} from './fused/model.js';
export type { MethodError } from './fused/model.js';
export type { FirmwareImage, FirmwareSegment } from '@mica-js/document/fused';
