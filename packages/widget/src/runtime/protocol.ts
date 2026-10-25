import type { WidgetDefinition } from '../types';
import type { WidgetInputEvent } from './types';

/**
 * Guest event names. The sandbox reserves the `mica:` namespace for its own traffic: guest events
 * with that prefix never reach host listeners, and `sandbox.on('mica:...')` throws. Widget traffic
 * therefore lives in the `widget:` namespace.
 */
export const WIDGET_FRAME_EVENT = 'widget:frame';
export const WIDGET_PUBLISH_EVENT = 'widget:publish';
export const WIDGET_ERROR_EVENT = 'widget:error';
/** A resource the guest could not hand to a widget; non-fatal, the instance keeps running. */
export const WIDGET_ASSET_FAILED_EVENT = 'widget:asset-failed';
/**
 * The guest asks the host to open, move or close a native text control. Widgets have no DOM, so
 * every IME composition and native selection goes through the host `<textarea>` overlay.
 */
export const WIDGET_TEXT_INPUT_EVENT = 'widget:text-input';

/** Guest methods the host reaches through `sandbox.call()`. */
export const WIDGET_LOAD_METHOD = 'load';
export const WIDGET_MOUNT_METHOD = 'mount';
export const WIDGET_UNMOUNT_METHOD = 'unmount';
export const WIDGET_RESIZE_METHOD = 'resize';
export const WIDGET_SET_PROPERTIES_METHOD = 'set-properties';
export const WIDGET_DELIVER_METHOD = 'deliver';
export const WIDGET_POINTER_METHOD = 'pointer';
/** Native control events for the text input session of one instance. */
export const WIDGET_TEXT_INPUT_METHOD = 'text-input';
/** Native control events for the selection session of one instance. */
export const WIDGET_TEXT_SELECTION_METHOD = 'text-selection';
/**
 * Releases every instance without terminating the guest. Widget modules stay evaluated, so the next
 * `load` reuses their factories and only fresh instances are created.
 */
export const WIDGET_RESET_RUNTIME_METHOD = 'reset-runtime';
/** Instance boundary that produced a widget error. */
export type WidgetErrorPhase = 'mount' | 'render' | 'deliver';

/** Widget errors cross the sandbox boundary as plain data. */
export interface SerializedWidgetError {
  readonly name: string;
  readonly message: string;
}

/** One rendered frame, always transferred so the host owns the bitmap. */
export interface WidgetFrameMessage {
  readonly instanceId: string;
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Payload a widget published on an output port. */
export interface WidgetPublishMessage {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  /** Simulation time supplied by the widget; `0` when it did not pass one. */
  readonly simTime: number;
}

/** Asset read that failed inside the guest; reported once per instance and `src`. */
export interface WidgetAssetFailedMessage {
  readonly instanceId: string;
  readonly src: string;
  readonly error: SerializedWidgetError;
}

/** Failure contained to one instance; the guest keeps every other instance running. */
export interface WidgetErrorMessage {
  readonly instanceId: string;
  readonly phase: WidgetErrorPhase;
  readonly error: SerializedWidgetError;
}

export interface WidgetLoadModule {
  readonly definition: WidgetDefinition;
  readonly code: string;
}

export interface WidgetLoadPackage {
  readonly id: string;
  readonly modules: Readonly<Record<string, WidgetLoadModule>>;
}

export interface WidgetLoadRequest {
  readonly packages: readonly WidgetLoadPackage[];
}

export interface WidgetMountRequest {
  readonly instanceId: string;
  readonly widget: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly props?: Readonly<Record<string, unknown>>;
  /** Bytes the host prefetched for this instance, keyed by `WidgetAssetRef.src`. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
}

export interface WidgetPointerRequest {
  readonly instanceId: string;
  readonly event: WidgetInputEvent;
}

/** Which native control backs a session: a `<textarea>` for input, a selecting one for selection. */
export type WidgetTextSessionKind = 'input' | 'selection';

/** Opens the native input control at the widget-local position the guest asked for. */
export interface WidgetTextInputBeginMessage {
  readonly type: 'begin';
  readonly session: 'input';
  readonly instanceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly cursorPosition: number;
}

/** Opens the native selection control over text the widget drew itself. */
export interface WidgetTextSelectionBeginMessage {
  readonly type: 'begin';
  readonly session: 'selection';
  readonly instanceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Moves the native input control. */
export interface WidgetTextInputMoveMessage {
  readonly type: 'update';
  readonly session: 'input';
  readonly instanceId: string;
  readonly x: number;
  readonly y: number;
}

/** Applies a widget-driven selection range. */
export interface WidgetTextSelectionRangeMessage {
  readonly type: 'update';
  readonly session: 'selection';
  readonly instanceId: string;
  readonly start: number;
  readonly end: number;
}

/** Ends a session; `commit` keeps the value, `cancel` discards the session. */
export interface WidgetTextSessionEndMessage {
  readonly type: 'commit' | 'cancel';
  readonly session: WidgetTextSessionKind;
  readonly instanceId: string;
}

/** Everything the guest asks the host's native control overlay to do. */
export type WidgetTextCommandMessage =
  | WidgetTextInputBeginMessage
  | WidgetTextSelectionBeginMessage
  | WidgetTextInputMoveMessage
  | WidgetTextSelectionRangeMessage
  | WidgetTextSessionEndMessage;

/**
 * Native control event for a text input session.
 *
 * `text` is the composition string for `compositionstart` / `compositionupdate` /
 * `compositionend` (what the IME is editing right now) and the full control value for `input` and
 * `commit`.
 */
export interface WidgetTextInputNativeEvent {
  readonly type:
    'compositionstart' | 'compositionupdate' | 'compositionend' | 'input' | 'commit' | 'cancel';
  readonly text: string;
  readonly cursorPosition: number;
}

/** Native control event for a selection session; offsets index the text passed to `begin`. */
export interface WidgetTextSelectionNativeEvent {
  readonly type: 'change' | 'commit' | 'cancel';
  readonly start: number;
  readonly end: number;
  readonly selectedText: string;
}
