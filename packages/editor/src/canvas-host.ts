import type { CanvasBindingTarget, CanvasPortDescriptor } from '@mica-js/document/canvas';

export interface ICanvasTarget {
  readonly kind: 'widget';
  readonly id: string;
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
