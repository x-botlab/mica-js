import type { FusedDocument, Point2D } from '@mica-js/document/fused';
import type { IWorkbenchTarget, WorkbenchMode } from '../types';
import {
  designatorPosition,
  endpointPosition,
  labelBounds,
  localToScene,
  referenceSymbolBounds,
  type ICanvasDevice,
  type IViewport,
} from './geometry';
import type { WorkbenchThemeColors } from '../theme';
import {
  labelAnchorNode,
  moveLabel,
  moveReference,
  moveWireSegment,
  orthogonalPath,
  routeDocumentWires,
} from '../wiring';
import {
  setTextOffset,
  type IFusedTextTarget,
  DEFAULT_POWER_NET_NAME,
  DEFAULT_POWER_VOLTAGE,
} from '../document/edits';

export interface IRenderState {
  readonly document: FusedDocument;
  readonly devices: ReadonlyMap<string, ICanvasDevice>;
  readonly images: ReadonlyMap<string, CanvasImageSource>;
  readonly overlays: ReadonlyMap<string, ImageBitmap>;
  readonly viewport: IViewport;
  readonly mode: WorkbenchMode;
  readonly selection: readonly IWorkbenchTarget[];
  readonly preview?: {
    readonly from: Point2D;
    readonly bends: readonly Point2D[];
    readonly to: Point2D;
  };
  readonly drag?: { readonly instanceId: string; readonly position: Point2D };
  readonly wireDrag?: {
    readonly wireId: string;
    readonly segment: number;
    readonly delta: Point2D;
  };
  readonly textDrag?: { readonly target: IFusedTextTarget; readonly offset: Point2D };
  readonly referenceDrag?: { readonly referenceId: string; readonly position: Point2D };
  readonly labelDrag?: { readonly labelId: string; readonly position: Point2D };
  readonly ghost?: {
    readonly device: string;
    readonly position: Point2D;
    readonly rotation: number;
  };
  readonly annotation?: {
    readonly kind: 'power' | 'ground' | 'label';
    readonly position: Point2D;
    readonly name: string;
    readonly rotation: number;
  };
  readonly colors: WorkbenchThemeColors;
}

export function drawCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: IRenderState,
): void {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas2D is not available');
  const ratio = globalThis.devicePixelRatio || 1;
  const bitmapWidth = Math.max(1, Math.round(width * ratio));
  const bitmapHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = state.colors['canvas.background'];
  context.fillRect(0, 0, width, height);
  const { scale, x, y } = state.viewport;
  context.translate(x, y);
  context.scale(scale, scale);
  const ink = state.colors['canvas.foreground'];
  context.lineWidth = 1 / scale;
  if (state.mode === 'edit') {
    let grid = 1;
    while (grid * scale < 10) grid *= 5;
    context.fillStyle = state.colors['canvas.grid'];
    for (let gx = Math.floor(-x / scale / grid) * grid; gx < (width - x) / scale; gx += grid)
      for (let gy = Math.floor(-y / scale / grid) * grid; gy < (height - y) / scale; gy += grid)
        context.fillRect(gx, gy, 1 / scale, 1 / scale);
  }
  let document =
    state.drag === undefined
      ? state.document
      : routeDocumentWires(
          {
            ...state.document,
            instances: state.document.instances.map((instance) =>
              instance.id === state.drag?.instanceId
                ? { ...instance, placement: { ...instance.placement, ...state.drag.position } }
                : instance,
            ),
          },
          state.devices,
          state.document,
        );
  if (state.wireDrag !== undefined)
    document = moveWireSegment(
      document,
      state.devices,
      state.wireDrag.wireId,
      state.wireDrag.segment,
      state.wireDrag.delta,
    );
  if (state.textDrag !== undefined)
    document = setTextOffset(document, state.textDrag.target, state.textDrag.offset);
  if (state.referenceDrag !== undefined) {
    let previewId = 0;
    document = moveReference(
      document,
      state.devices,
      state.referenceDrag.referenceId,
      state.referenceDrag.position,
      () => `__reference_drag_${previewId++}__`,
    );
  }
  if (
    state.labelDrag !== undefined &&
    labelAnchorNode(document, state.labelDrag.labelId) !== undefined
  )
    document = moveLabel(
      document,
      state.devices,
      state.labelDrag.labelId,
      state.labelDrag.position,
    );
  const stroke = (points: readonly Point2D[]): void => {
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  };
  if (state.mode === 'edit') {
    for (const wire of document.wires) {
      context.strokeStyle = state.selection.some(
        (target) => target.kind === 'wire' && target.id === wire.id,
      )
        ? state.colors['canvas.selection']
        : state.colors['canvas.wire'];
      context.lineWidth =
        (state.selection.some((target) => target.id === wire.id) ? 2.5 : 1.5) / scale;
      stroke(
        orthogonalPath([
          endpointPosition(document, state.devices, wire.from),
          ...wire.bends,
          endpointPosition(document, state.devices, wire.to),
        ]),
      );
    }
    context.fillStyle = ink;
    for (const node of document.nodes) {
      context.beginPath();
      context.arc(node.x, node.y, (node.kind === 'junction' ? 3 : 2) / scale, 0, Math.PI * 2);
      context.fill();
    }
    context.lineWidth = 1.5 / scale;
    context.strokeStyle = state.colors['canvas.pin'];
    if (state.preview !== undefined) {
      context.setLineDash([5 / scale, 4 / scale]);
      stroke(orthogonalPath([state.preview.from, ...state.preview.bends, state.preview.to]));
      context.setLineDash([]);
    }
  }
  const instances =
    state.ghost === undefined
      ? document.instances
      : [
          ...document.instances,
          {
            id: '__preview__',
            device: state.ghost.device,
            placement: { ...state.ghost.position, rotation: state.ghost.rotation },
          },
        ];
  for (const instance of instances) {
    const device = state.devices.get(instance.device);
    if (device === undefined) continue;
    const geometry = device.geometry;
    const bounds = geometry.bounds;
    const body =
      state.mode === 'edit' || (instance.display?.body ?? document.display?.body ?? true);
    const overlay = state.overlays.get(instance.id);
    if (!body && overlay === undefined) continue;
    context.save();
    if (instance.id === '__preview__') context.globalAlpha = 0.5;
    context.translate(instance.placement.x, instance.placement.y);
    context.rotate((instance.placement.rotation * Math.PI) / 180);
    if (geometry.sizing === 'flexible') {
      context.scale(
        (instance.placement.width ?? bounds.width) / bounds.width,
        (instance.placement.height ?? bounds.height) / bounds.height,
      );
      context.translate(-bounds.x, -bounds.y);
    }
    if (body) {
      const image = state.images.get(instance.device);
      if (image !== undefined)
        context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
    }
    if (overlay !== undefined)
      context.drawImage(overlay, bounds.x, bounds.y, bounds.width, bounds.height);
    if (state.selection.some((target) => target.kind === 'instance' && target.id === instance.id)) {
      context.strokeStyle = state.colors['canvas.selection'];
      context.lineWidth = 1.5 / scale;
      context.setLineDash([4 / scale, 3 / scale]);
      context.strokeRect(
        bounds.x - 3 / scale,
        bounds.y - 3 / scale,
        bounds.width + 6 / scale,
        bounds.height + 6 / scale,
      );
      context.setLineDash([]);
    }
    context.restore();
    if (
      (state.mode === 'edit' || (document.display?.designators ?? true)) &&
      instance.designator !== undefined
    ) {
      const anchor = designatorPosition(instance, geometry);
      context.font = `600 ${11 / scale}px system-ui`;
      context.fillStyle = ink;
      context.fillText(instance.designator, anchor.x, anchor.y - 5 / scale);
    }
    if (state.mode === 'edit') {
      const selected = state.selection.some((target) => target.id === instance.id);
      for (const [id, pin] of Object.entries(geometry.pins)) {
        const point = localToScene(instance, geometry, pin.position);
        context.strokeStyle = state.colors['canvas.pin'];
        context.lineWidth = 1.25 / scale;
        context.beginPath();
        context.arc(point.x, point.y, 2.5 / scale, 0, Math.PI * 2);
        context.stroke();
        if (selected || scale >= 3) {
          context.font = `${10 / scale}px system-ui`;
          context.fillStyle = ink;
          const length = Math.hypot(pin.outward.x, pin.outward.y);
          const label =
            pin.label?.visible === false ? undefined : (device.manifest.pins?.[id]?.label ?? id);
          if (label === undefined) continue;
          if (pin.label?.position !== undefined) {
            const labelPoint = localToScene(instance, geometry, pin.label.position);
            context.textAlign = 'left';
            context.fillText(label, labelPoint.x, labelPoint.y);
          } else {
            const outwardPoint = localToScene(instance, geometry, {
              x: pin.position.x + pin.outward.x / length,
              y: pin.position.y + pin.outward.y / length,
            });
            const dx = outwardPoint.x - point.x;
            const dy = outwardPoint.y - point.y;
            context.textAlign = dx < -0.1 ? 'right' : 'left';
            context.fillText(
              label,
              point.x + (dx * 7) / scale,
              point.y + (dy * 7) / scale + 3 / scale,
            );
          }
        }
      }
      context.textAlign = 'left';
    }
  }
  if (state.mode === 'edit') {
    const annotations: FusedDocument =
      state.annotation === undefined
        ? document
        : {
            ...document,
            nodes: [
              ...document.nodes,
              { id: '__annotation__', kind: 'free', ...state.annotation.position },
            ],
            labels:
              state.annotation.kind === 'label'
                ? [
                    ...document.labels,
                    {
                      id: '__annotation__',
                      target: { kind: 'node', node: '__annotation__' },
                      name: state.annotation.name,
                    },
                  ]
                : document.labels,
            references:
              state.annotation.kind === 'label'
                ? document.references
                : [
                    ...document.references,
                    {
                      id: '__annotation__',
                      target: { kind: 'node', node: '__annotation__' },
                      symbol: state.annotation.kind,
                      voltage: state.annotation.kind === 'ground' ? 0 : DEFAULT_POWER_VOLTAGE,
                      rotation: state.annotation.rotation,
                      ...(state.annotation.kind === 'power'
                        ? { label: { name: DEFAULT_POWER_NET_NAME } }
                        : {}),
                    },
                  ],
          };
    context.strokeStyle = ink;
    context.fillStyle = ink;
    context.lineWidth = 0.1;
    context.font = '0.75px system-ui';
    for (const label of annotations.labels) {
      const point = endpointPosition(annotations, state.devices, label.target);
      context.save();
      if (label.id === '__annotation__') context.globalAlpha = 0.5;
      if (state.selection.some((target) => target.kind === 'label' && target.id === label.id)) {
        const bounds = labelBounds(label);
        context.strokeStyle = state.colors['canvas.selection'];
        context.lineWidth = 1.5 / scale;
        context.setLineDash([4 / scale, 3 / scale]);
        context.strokeRect(
          point.x + bounds.x - 3 / scale,
          point.y + bounds.y - 3 / scale,
          bounds.width + 6 / scale,
          bounds.height + 6 / scale,
        );
        context.setLineDash([]);
      }
      context.fillText(
        label.name,
        point.x + (label.offset?.x ?? 0.3),
        point.y + (label.offset?.y ?? -0.35),
      );
      context.restore();
    }
    for (const reference of annotations.references) {
      const point = endpointPosition(annotations, state.devices, reference.target);
      context.save();
      if (reference.id === '__annotation__') context.globalAlpha = 0.5;
      context.translate(point.x, point.y);
      context.rotate(((reference.rotation ?? 0) * Math.PI) / 180);
      if (
        state.selection.some((target) => target.kind === 'reference' && target.id === reference.id)
      ) {
        const bounds = referenceSymbolBounds(reference);
        context.strokeStyle = state.colors['canvas.selection'];
        context.lineWidth = 1.5 / scale;
        context.setLineDash([4 / scale, 3 / scale]);
        context.strokeRect(
          bounds.x - 3 / scale,
          bounds.y - 3 / scale,
          bounds.width + 6 / scale,
          bounds.height + 6 / scale,
        );
        context.setLineDash([]);
      }
      context.strokeStyle = ink;
      context.lineWidth = 0.1;
      const unit = 0.1;
      stroke([
        { x: 0, y: 0 },
        { x: 0, y: -12 * unit },
      ]);
      if (reference.symbol === 'ground') {
        for (let index = 0; index < 3; index++)
          stroke([
            { x: (-7 + index * 2) * unit, y: (-12 - index * 3) * unit },
            { x: (7 - index * 2) * unit, y: (-12 - index * 3) * unit },
          ]);
      } else {
        stroke([
          { x: -5 * unit, y: -8 * unit },
          { x: 0, y: -13 * unit },
          { x: 5 * unit, y: -8 * unit },
        ]);
      }
      if (reference.symbol !== 'ground')
        context.fillText(
          reference.label?.name ?? `${reference.voltage} V`,
          reference.label?.offset?.x ?? 7 * unit,
          reference.label?.offset?.y ?? -14 * unit,
        );
      context.restore();
    }
  }
}
