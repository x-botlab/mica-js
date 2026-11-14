import type { TimePs } from '@mica-js/core';
import type { CanvasBindingTarget, CanvasPortDescriptor } from '@mica-js/document/canvas';

export interface ICanvasTarget {
  readonly kind: 'widget';
  readonly id: string;
}

/** One completed whole-surface paint on the host thread. */
export interface ICanvasRenderSample {
  /** 1-based render order within the view. */
  readonly sequence: number;
  /** Wall-clock start on the performance timeline, in milliseconds. */
  readonly startedAt: number;
  /** Wall clock when every widget bitmap was drawn and selection handles were laid out. */
  readonly completedAt: number;
  /** Time spent inside the paint call, in milliseconds. */
  readonly durationMs: number;
  readonly mode: 'edit' | 'simulation';
  /** Widget instances painted in this pass. */
  readonly widgets: number;
  /** Logical surface size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Optional synchronous sink for main-thread canvas paint timing. */
export type ICanvasRenderObserver = (sample: ICanvasRenderSample) => void;

/** One bitmap frame that reached the host; the bitmap itself is not retained. */
export interface ICanvasWidgetFrameSample {
  /** Wall clock when the widget runtime handed the frame to the host, in milliseconds. */
  readonly at: number;
  readonly instanceId: string;
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** One simulation publication on its way to the widget topic bridge. */
export interface ICanvasTopicMessageSample {
  /** Wall clock when the host observed the publication, in milliseconds. */
  readonly at: number;
  readonly symbol: string;
  readonly port: string;
  readonly simTime: TimePs;
  /** Payload as delivered by the simulator; consumers must not mutate it. */
  readonly payload: unknown;
}

export interface ICanvasBindingCandidate {
  readonly target: CanvasBindingTarget;
  readonly label: string;
  readonly compatible: boolean;
  readonly reason?: string;
}

export interface ICanvasBindingInfo extends CanvasPortDescriptor {
  readonly port: string;
  readonly target: CanvasBindingTarget | null;
  readonly candidates: readonly ICanvasBindingCandidate[];
}

export { editorSnapshot as canvasSnapshot } from './snapshot';
