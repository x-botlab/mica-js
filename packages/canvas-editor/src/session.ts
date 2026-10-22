import type {
  CanvasCommand,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '@mica-js/core/canvas';
import type { WidgetInputEvent } from '@mica-js/widget';
import {
  hitTestHandle,
  hitTestTopmost,
  placementCenter,
  pointerAngle,
  resizePlacement,
  rotationFromPointer,
  toLocalPoint,
  type CanvasHandle,
  type Point,
  type ResizeHandle,
} from './geometry';
import type { CanvasMode } from './types';
import { IDENTITY_VIEWPORT, panBy, screenToDocument, zoomAt, type ViewportState } from './viewport';

/**
 * Interaction state machine of the canvas editor. It owns selection, viewport and preview geometry,
 * and returns the commands a host must apply; it never edits the document itself.
 *
 * `mount.ts` only translates DOM events into the `PointerInput`/`KeyInput`/`WheelInput` shapes
 * below, so every rule in here is testable without a DOM.
 */

/** A press must travel this far (CSS pixels) before it becomes a drag, so clicks never nudge. */
export const DRAG_THRESHOLD = 3;
/** Screen-space radius of a handle hit test. */
export const HANDLE_HIT_RADIUS = 8;
/** Screen-space distance of the rotation handle above the top edge. */
export const ROTATE_HANDLE_OFFSET = 20;
/** Document units moved by an arrow key, and by `Shift` + arrow key. */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 10;
/** Exponent factor of one wheel notch: `scale * Math.exp(-deltaY * step)`. */
export const WHEEL_ZOOM_STEP = 0.0015;

export interface PointerInput {
  /** Canvas-relative CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  /** Space is held, so a primary-button drag pans instead of selecting. */
  readonly spaceKey?: boolean;
}

export interface KeyInput {
  readonly key: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface WheelInput {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey?: boolean;
}

/** One run-mode input aimed at a widget instance. */
export interface ForwardedInput {
  readonly instanceId: string;
  readonly event: WidgetInputEvent;
}

export interface InteractionResult {
  readonly selection: readonly string[];
  readonly viewport: ViewportState;
  /** Commands the host applies with `applyCanvasCommand`; empty for pure view changes. */
  readonly commands: readonly CanvasCommand[];
  /** Run-mode events to hand to the widget host. */
  readonly events: readonly ForwardedInput[];
  /** Whether something visible changed and the canvas needs a repaint. */
  readonly redraw: boolean;
}

export type InteractionKind = 'idle' | 'pressed' | 'dragging' | 'scaling' | 'rotating' | 'panning';

type Interaction =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pressed'; readonly origin: Point; readonly targetId: string | undefined }
  | {
      readonly kind: 'dragging';
      readonly origin: Point;
      readonly start: ReadonlyMap<string, WidgetPlacement>;
    }
  | {
      readonly kind: 'scaling';
      readonly instanceId: string;
      readonly handle: ResizeHandle;
      readonly start: WidgetPlacement;
    }
  | {
      readonly kind: 'rotating';
      readonly instanceId: string;
      readonly start: WidgetPlacement;
      readonly grabOffset: number;
    }
  | {
      readonly kind: 'panning';
      readonly origin: Point;
      readonly start: ViewportState;
    };

export interface CanvasInteractionSessionOptions {
  readonly mode?: CanvasMode;
  readonly selection?: readonly string[];
  readonly viewport?: ViewportState;
}

export class CanvasInteractionSession {
  #mode: CanvasMode;
  #selection: readonly string[];
  #viewport: ViewportState;
  #interaction: Interaction = { kind: 'idle' };
  #previews = new Map<string, WidgetPlacement>();
  #activeInstanceId: string | undefined;
  #lastPointer: Point = { x: 0, y: 0 };

  constructor(options: CanvasInteractionSessionOptions = {}) {
    this.#mode = options.mode ?? 'edit';
    this.#selection = options.selection ?? [];
    this.#viewport = options.viewport ?? IDENTITY_VIEWPORT;
  }

  get mode(): CanvasMode {
    return this.#mode;
  }

  get selection(): readonly string[] {
    return this.#selection;
  }

  get viewport(): ViewportState {
    return this.#viewport;
  }

  get interaction(): InteractionKind {
    return this.#interaction.kind;
  }

  /** Instance that received the last run-mode pointer hit; keyboard input goes there. */
  get activeInstanceId(): string | undefined {
    return this.#activeInstanceId;
  }

  /** In-progress geometry, keyed by instance id. Empty while idle. */
  get previews(): ReadonlyMap<string, WidgetPlacement> {
    return this.#previews;
  }

  setMode(mode: CanvasMode): void {
    this.#mode = mode;
  }

  setSelection(ids: readonly string[]): void {
    this.#selection = [...ids];
  }

  setViewport(viewport: ViewportState): void {
    this.#viewport = viewport;
  }

  clearActiveInstance(): void {
    this.#activeInstanceId = undefined;
  }

  /** Drops the gesture and its previews without emitting a command. */
  cancelInteraction(): void {
    this.#interaction = { kind: 'idle' };
    this.#previews.clear();
  }

  pointerDown(document: CanvasDocument, input: PointerInput): InteractionResult {
    this.#lastPointer = { x: input.x, y: input.y };
    if (this.#mode === 'run') {
      return this.#runPointer(document, 'pointerdown', input);
    }

    const point = this.#lastPointer;
    // Middle button and Space + drag pan; they never touch the selection.
    if (input.button === 1 || input.spaceKey === true) {
      this.#interaction = { kind: 'panning', origin: point, start: this.#viewport };
      return this.#result(false);
    }
    if (input.button !== undefined && input.button !== 0) {
      return this.#result(false);
    }

    const documentPoint = screenToDocument(this.#viewport, point);
    const handle = this.#handleAt(document, documentPoint);
    if (handle !== undefined) {
      const instance = findInstance(document, handle.instanceId);
      if (instance !== undefined) {
        const start = toPlacement(instance);
        this.#interaction =
          handle.handle === 'rotate'
            ? {
                kind: 'rotating',
                instanceId: instance.id,
                start,
                grabOffset:
                  start.rotation - (pointerAngle(placementCenter(start), documentPoint) + 90),
              }
            : { kind: 'scaling', instanceId: instance.id, handle: handle.handle, start };
        return this.#result(false);
      }
    }

    const hit = hitTestTopmost(document.widgets, documentPoint);
    const toggle = input.shiftKey === true || input.ctrlKey === true;
    let selection = this.#selection;
    if (hit === undefined) {
      if (!toggle) {
        selection = [];
      }
    } else if (toggle) {
      selection = selection.includes(hit.id)
        ? selection.filter((id) => id !== hit.id)
        : [...selection, hit.id];
    } else if (!selection.includes(hit.id)) {
      selection = [hit.id];
    }
    const changed = !sameIds(selection, this.#selection);
    this.#selection = selection;

    // A shift-click that removed the instance leaves nothing to drag.
    const targetId = hit !== undefined && this.#selection.includes(hit.id) ? hit.id : undefined;
    this.#interaction = { kind: 'pressed', origin: point, targetId };
    return this.#result(changed);
  }

  pointerMove(document: CanvasDocument, input: PointerInput): InteractionResult {
    this.#lastPointer = { x: input.x, y: input.y };
    if (this.#mode === 'run') {
      return this.#runPointer(document, 'pointermove', input);
    }

    const point = this.#lastPointer;
    const interaction = this.#interaction;
    switch (interaction.kind) {
      case 'panning': {
        const next = panBy(
          interaction.start,
          point.x - interaction.origin.x,
          point.y - interaction.origin.y,
        );
        if (sameViewport(next, this.#viewport)) {
          return this.#result(false);
        }
        this.#viewport = next;
        return this.#result(true);
      }
      case 'pressed': {
        if (interaction.targetId === undefined) {
          return this.#result(false);
        }
        const travelled = Math.hypot(
          point.x - interaction.origin.x,
          point.y - interaction.origin.y,
        );
        if (travelled <= DRAG_THRESHOLD) {
          return this.#result(false);
        }
        const start = new Map<string, WidgetPlacement>();
        for (const id of this.#selection) {
          const instance = findInstance(document, id);
          if (instance !== undefined) {
            start.set(id, toPlacement(instance));
          }
        }
        this.#interaction = { kind: 'dragging', origin: interaction.origin, start };
        return this.#drag(point);
      }
      case 'dragging':
        return this.#drag(point);
      case 'scaling': {
        const documentPoint = screenToDocument(this.#viewport, point);
        const next = resizePlacement(interaction.start, interaction.handle, documentPoint, {
          keepAspect: input.shiftKey === true,
        });
        return this.#result(this.#setPreviews(new Map([[interaction.instanceId, next]])));
      }
      case 'rotating': {
        const documentPoint = screenToDocument(this.#viewport, point);
        const rotation = rotationFromPointer(placementCenter(interaction.start), documentPoint, {
          grabOffset: interaction.grabOffset,
          snap: input.shiftKey === true,
        });
        const next = { ...interaction.start, rotation };
        return this.#result(this.#setPreviews(new Map([[interaction.instanceId, next]])));
      }
      default:
        return this.#result(false);
    }
  }

  pointerUp(document: CanvasDocument, input: PointerInput): InteractionResult {
    this.#lastPointer = { x: input.x, y: input.y };
    if (this.#mode === 'run') {
      return this.#runPointer(document, 'pointerup', input);
    }

    const interaction = this.#interaction;
    this.#interaction = { kind: 'idle' };
    if (
      interaction.kind !== 'dragging' &&
      interaction.kind !== 'scaling' &&
      interaction.kind !== 'rotating'
    ) {
      return this.#result(false);
    }

    // One `set-placement` per changed instance, built from the final preview only: the intermediate
    // geometry of the gesture never reaches the document.
    const commands: CanvasCommand[] = [];
    for (const [instanceId, placement] of this.#previews) {
      const instance = findInstance(document, instanceId);
      if (instance !== undefined && !samePlacement(instance, placement)) {
        commands.push({ type: 'set-placement', instanceId, placement });
      }
    }
    const redraw = this.#clearPreviews();
    return this.#result(redraw, commands);
  }

  pointerCancel(document: CanvasDocument): InteractionResult {
    if (this.#mode === 'run' && this.#activeInstanceId !== undefined) {
      const instance = findInstance(document, this.#activeInstanceId);
      if (instance !== undefined) {
        return this.#result(
          false,
          [],
          [
            {
              instanceId: instance.id,
              event: pointerEvent(
                'pointercancel',
                instance,
                screenToDocument(this.#viewport, this.#lastPointer),
                {},
              ),
            },
          ],
        );
      }
    }
    const redraw = this.#interaction.kind !== 'idle' || this.#previews.size > 0;
    this.cancelInteraction();
    return this.#result(redraw);
  }

  wheel(input: WheelInput): InteractionResult {
    if (this.#mode === 'run') {
      return this.#result(false);
    }
    const point = { x: input.x, y: input.y };
    const next =
      input.shiftKey === true
        ? panBy(this.#viewport, -(input.deltaX !== 0 ? input.deltaX : input.deltaY), 0)
        : zoomAt(this.#viewport, point, Math.exp(-input.deltaY * WHEEL_ZOOM_STEP));
    if (sameViewport(next, this.#viewport)) {
      return this.#result(false);
    }
    this.#viewport = next;
    return this.#result(true);
  }

  keyDown(document: CanvasDocument, key: KeyInput): InteractionResult {
    if (this.#mode === 'run') {
      return this.#runKey('keydown', document, key);
    }

    const modifier = key.ctrlKey === true || key.metaKey === true;
    if (modifier && (key.key === 'a' || key.key === 'A')) {
      const selection = document.widgets.map((widget) => widget.id);
      const changed = !sameIds(selection, this.#selection);
      this.#selection = selection;
      return this.#result(changed);
    }

    if (key.key === 'Delete' || key.key === 'Backspace') {
      if (this.#selection.length === 0) {
        return this.#result(false);
      }
      const commands = this.#selection.map((instanceId): CanvasCommand => ({
        type: 'remove-instance',
        instanceId,
      }));
      this.#selection = [];
      const hadPreview = this.#clearPreviews();
      const redraw = this.#interaction.kind !== 'idle' || hadPreview;
      this.#interaction = { kind: 'idle' };
      return this.#result(redraw, commands);
    }

    const step = key.shiftKey === true ? NUDGE_STEP_LARGE : NUDGE_STEP;
    const delta = arrowDelta(key.key, step);
    if (delta === undefined || this.#selection.length === 0) {
      return this.#result(false);
    }
    const commands: CanvasCommand[] = [];
    for (const instanceId of this.#selection) {
      const instance = findInstance(document, instanceId);
      if (instance === undefined) {
        continue;
      }
      const placement = toPlacement(instance);
      commands.push({
        type: 'set-placement',
        instanceId,
        placement: { ...placement, x: placement.x + delta.x, y: placement.y + delta.y },
      });
    }
    return this.#result(false, commands);
  }

  keyUp(document: CanvasDocument, key: KeyInput): InteractionResult {
    if (this.#mode !== 'run') {
      return this.#result(false);
    }
    return this.#runKey('keyup', document, key);
  }

  #drag(point: Point): InteractionResult {
    const interaction = this.#interaction;
    if (interaction.kind !== 'dragging') {
      return this.#result(false);
    }
    const dx = (point.x - interaction.origin.x) / this.#viewport.scale;
    const dy = (point.y - interaction.origin.y) / this.#viewport.scale;
    const previews = new Map<string, WidgetPlacement>();
    for (const [id, placement] of interaction.start) {
      previews.set(id, { ...placement, x: placement.x + dx, y: placement.y + dy });
    }
    return this.#result(this.#setPreviews(previews));
  }

  #runPointer(
    document: CanvasDocument,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    input: PointerInput,
  ): InteractionResult {
    const documentPoint = screenToDocument(this.#viewport, this.#lastPointer);
    if (type === 'pointerdown') {
      const hit = hitTestTopmost(document.widgets, documentPoint);
      this.#activeInstanceId = hit?.id;
      if (hit === undefined) {
        return this.#result(false);
      }
      return this.#result(
        false,
        [],
        [{ instanceId: hit.id, event: pointerEvent(type, hit, documentPoint, input) }],
      );
    }

    // Moves follow the instance that took the press; hover moves go to whatever is under the
    // pointer, so widgets can highlight themselves before a press.
    const target =
      this.#activeInstanceId === undefined
        ? type === 'pointermove'
          ? hitTestTopmost(document.widgets, documentPoint)
          : undefined
        : findInstance(document, this.#activeInstanceId);
    if (target === undefined) {
      return this.#result(false);
    }
    return this.#result(
      false,
      [],
      [{ instanceId: target.id, event: pointerEvent(type, target, documentPoint, input) }],
    );
  }

  #runKey(type: 'keydown' | 'keyup', document: CanvasDocument, key: KeyInput): InteractionResult {
    const instanceId = this.#activeInstanceId;
    if (instanceId === undefined) {
      return this.#result(false);
    }
    const instance = findInstance(document, instanceId);
    if (instance === undefined) {
      this.#activeInstanceId = undefined;
      return this.#result(false);
    }
    return this.#result(
      false,
      [],
      [
        {
          instanceId,
          event: {
            type,
            key: key.key,
            shiftKey: key.shiftKey === true,
            ctrlKey: key.ctrlKey === true,
            altKey: key.altKey === true,
            metaKey: key.metaKey === true,
            repeat: key.repeat === true,
            ...(key.code === undefined ? {} : { code: key.code }),
          },
        },
      ],
    );
  }

  #handleAt(
    document: CanvasDocument,
    point: Point,
  ): { readonly instanceId: string; readonly handle: CanvasHandle } | undefined {
    return handleUnderPointer(document, this.#selection, this.#viewport, point);
  }

  #setPreviews(next: ReadonlyMap<string, WidgetPlacement>): boolean {
    let changed = next.size !== this.#previews.size;
    for (const [id, placement] of next) {
      const previous = this.#previews.get(id);
      if (previous === undefined || !samePlacement(previous, placement)) {
        changed = true;
      }
    }
    this.#previews = new Map(next);
    return changed;
  }

  #clearPreviews(): boolean {
    const had = this.#previews.size > 0;
    this.#previews = new Map();
    return had;
  }

  #result(
    redraw: boolean,
    commands: readonly CanvasCommand[] = [],
    events: readonly ForwardedInput[] = [],
  ): InteractionResult {
    return { selection: this.#selection, viewport: this.#viewport, commands, events, redraw };
  }
}

function findInstance(
  document: CanvasDocument,
  instanceId: string,
): CanvasWidgetInstance | undefined {
  return document.widgets.find((widget) => widget.id === instanceId);
}

/**
 * Handle under a document point, for the state machine and for host cursors. Handles belong to a
 * single selection, so a multi-selection yields `undefined`.
 */
export function handleUnderPointer(
  document: CanvasDocument,
  selection: readonly string[],
  viewport: ViewportState,
  point: Point,
): { readonly instanceId: string; readonly handle: CanvasHandle } | undefined {
  if (selection.length !== 1) {
    return undefined;
  }
  const instanceId = selection[0];
  if (instanceId === undefined) {
    return undefined;
  }
  const instance = findInstance(document, instanceId);
  if (instance === undefined) {
    return undefined;
  }
  const handle = hitTestHandle(
    instance,
    point,
    HANDLE_HIT_RADIUS / viewport.scale,
    ROTATE_HANDLE_OFFSET / viewport.scale,
  );
  return handle === undefined ? undefined : { instanceId, handle };
}

function toPlacement(instance: WidgetPlacement): WidgetPlacement {
  return {
    x: instance.x,
    y: instance.y,
    width: instance.width,
    height: instance.height,
    rotation: instance.rotation,
  };
}

function samePlacement(left: WidgetPlacement, right: WidgetPlacement): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameViewport(left: ViewportState, right: ViewportState): boolean {
  return left.x === right.x && left.y === right.y && left.scale === right.scale;
}

function arrowDelta(key: string, step: number): Point | undefined {
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return undefined;
  }
}

/**
 * Pointer position in instance-local logical units, with position and rotation removed: `(0, 0)`
 * is the instance's top-left corner, matching the coordinate space widgets render in.
 */
function pointerEvent(
  type: string,
  instance: WidgetPlacement,
  documentPoint: Point,
  input: Pick<PointerInput, 'button' | 'buttons' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
): WidgetInputEvent {
  const local = toLocalPoint(instance, documentPoint);
  return {
    type,
    x: local.x + instance.width / 2,
    y: local.y + instance.height / 2,
    shiftKey: input.shiftKey === true,
    ctrlKey: input.ctrlKey === true,
    altKey: input.altKey === true,
    metaKey: input.metaKey === true,
    ...(input.button === undefined ? {} : { button: input.button }),
    ...(input.buttons === undefined ? {} : { buttons: input.buttons }),
  };
}
