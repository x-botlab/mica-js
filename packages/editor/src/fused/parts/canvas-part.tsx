import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { DeviceLock, Endpoint, FusedDocument, Point2D } from '@mica-js/document/fused';
import type { IWorkbenchState, IWorkbenchTarget } from '../types';
import {
  contains,
  distanceToSegment,
  endpointPosition,
  fitViewport,
  pickInstance,
  pickPins,
  sceneToLocal,
  toScene,
  type ICanvasDevice,
  type IPinHit,
  type IViewport,
} from '../canvas/geometry';
import { drawCanvas } from '../canvas/renderer';
import { orthogonalPath } from '../wiring';
import { projectOnSegment } from '@mica-js/document/schematic';
import { readCanvasTheme, type IResolvedWorkbenchTheme } from '../theme';

export interface ICanvasHandle {
  readonly scale: number;
  fit(): void;
  zoom(factor: number): void;
  reveal(instanceId: string): void;
}

export interface IViewInput {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup';
  readonly position: Point2D;
  readonly button: number;
  readonly buttons: number;
}

export interface ICanvasPartProps {
  readonly document: FusedDocument;
  readonly devices: ReadonlyMap<string, ICanvasDevice>;
  readonly images: ReadonlyMap<string, CanvasImageSource>;
  readonly overlays: ReadonlyMap<string, ImageBitmap>;
  readonly state: IWorkbenchState;
  readonly selection: readonly IWorkbenchTarget[];
  readonly placement: DeviceLock | undefined;
  readonly labelName: string;
  readonly theme: IResolvedWorkbenchTheme;
  readonly frame: number;
  readonly onReady: (handle: ICanvasHandle | undefined) => void;
  readonly onSelection: (selection: readonly IWorkbenchTarget[]) => void;
  readonly onOpenProperties: () => void;
  readonly onPlace: (device: DeviceLock, position: Point2D) => Promise<void>;
  readonly onMove: (instanceId: string, position: Point2D) => Promise<void>;
  readonly onConnect: (
    from: Endpoint | Point2D,
    to: Endpoint | Point2D,
    bends: readonly Point2D[],
  ) => Promise<void>;
  readonly onEndpoint: (endpoint: Endpoint | Point2D) => Promise<void>;
  readonly onCancel: () => void;
  readonly onDelete: () => Promise<void>;
  readonly onInput: (instanceId: string, input: IViewInput) => void;
  readonly onError: (error: unknown) => void;
  readonly onFocus: (focused: boolean) => void;
  readonly onViewport: () => void;
  readonly children?: React.ReactNode;
}

export function CanvasPart(props: ICanvasPartProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<IViewport>({ x: 80, y: 80, scale: 10 });
  const [pointer, setPointer] = useState<Point2D>({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);
  const committing = useRef(false);
  const [connection, setConnection] = useState<{
    readonly endpoint: Endpoint | Point2D;
    readonly bends: readonly Point2D[];
  }>();
  const [drag, setDrag] = useState<{ readonly instanceId: string; readonly position: Point2D }>();
  const [candidates, setCandidates] = useState<readonly IPinHit[]>([]);
  const gesture = useRef<
    | {
        readonly kind: 'pan' | 'move';
        readonly pointerId: number;
        readonly start: Point2D;
        readonly original: Point2D;
        readonly instanceId?: string;
      }
    | undefined
  >(undefined);
  const business = useRef<
    | {
        readonly instanceId: string;
        readonly pointerId: number;
        position: Point2D;
        readonly button: number;
      }
    | undefined
  >(undefined);
  const space = useRef(false);
  const current = useRef(props);
  current.current = props;

  const run = (task: Promise<void>) => {
    void task.catch(props.onError);
  };
  const fit = () =>
    setViewport(fitViewport(props.document, props.devices, size.width, size.height));
  const zoom = (factor: number, center: Point2D = { x: size.width / 2, y: size.height / 2 }) => {
    setViewport((value) => {
      const scale = Math.max(0.25, Math.min(100, value.scale * factor));
      return {
        scale,
        x: center.x - ((center.x - value.x) * scale) / value.scale,
        y: center.y - ((center.y - value.y) * scale) / value.scale,
      };
    });
  };
  const currentZoom = useRef(zoom);
  currentZoom.current = zoom;
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      currentZoom.current(Math.exp(-event.deltaY * 0.001), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const reveal = (instanceId: string) => {
    const instance = props.document.instances.find((item) => item.id === instanceId);
    if (instance === undefined) throw new Error(`Unknown instance: ${instanceId}`);
    setViewport((value) => ({
      ...value,
      x: size.width / 2 - instance.placement.x * value.scale,
      y: size.height / 2 - instance.placement.y * value.scale,
    }));
    canvas.current?.focus();
  };
  function cancelGesture(): void {
    const active = business.current;
    const pointerId = active?.pointerId ?? gesture.current?.pointerId;
    business.current = undefined;
    gesture.current = undefined;
    setDrag(undefined);
    if (active !== undefined)
      current.current.onInput(active.instanceId, {
        type: 'pointerup',
        position: active.position,
        button: active.button,
        buttons: 0,
      });
    if (pointerId !== undefined && canvas.current?.hasPointerCapture(pointerId))
      canvas.current.releasePointerCapture(pointerId);
    space.current = false;
  }
  useLayoutEffect(() => {
    props.onReady({ fit, zoom, reveal, scale: viewport.scale });
    return () => props.onReady(undefined);
  });
  useEffect(() => props.onViewport(), [viewport.scale]);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    let initialized = false;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      if (!initialized && width > 0 && height > 0) {
        initialized = true;
        setViewport(fitViewport(current.current.document, current.current.devices, width, height));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setConnection(undefined);
    setCandidates([]);
    cancelGesture();
  }, [props.state.mode, props.state.tool, props.state.readOnly]);
  useEffect(() => {
    const release = () => cancelGesture();
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, []);
  const annotationTool =
    props.state.tool === 'power' || props.state.tool === 'ground' || props.state.tool === 'label'
      ? props.state.tool
      : undefined;
  useEffect(() => {
    if (canvas.current === null) return;
    const frame = requestAnimationFrame(() => {
      if (canvas.current === null) return;
      try {
        drawCanvas(canvas.current, size.width, size.height, {
          document: props.document,
          devices: props.devices,
          images: props.images,
          overlays: props.overlays,
          viewport,
          mode: props.state.mode,
          selection: props.selection,
          colors: readCanvasTheme(canvas.current),
          ...(drag === undefined ? {} : { drag }),
          ...(!hovered || props.placement === undefined
            ? {}
            : { ghost: { device: props.placement.id, position: pointer } }),
          ...(!hovered ||
          props.state.mode !== 'edit' ||
          props.state.readOnly ||
          annotationTool === undefined
            ? {}
            : {
                annotation: { kind: annotationTool, position: pointer, name: props.labelName },
              }),
          ...(connection === undefined
            ? {}
            : {
                preview: {
                  from: anchorPoint(connection.endpoint),
                  bends: connection.bends,
                  to: pointer,
                },
              }),
        });
      } catch (error) {
        props.onError(error);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    props.document,
    props.devices,
    props.images,
    props.overlays,
    props.selection,
    props.state.mode,
    props.theme,
    props.frame,
    props.placement,
    props.labelName,
    props.state.tool,
    props.state.readOnly,
    hovered,
    viewport,
    size,
    connection,
    pointer,
    drag,
  ]);

  function local(
    event: Pick<ReactPointerEvent<HTMLCanvasElement>, 'currentTarget' | 'clientX' | 'clientY'>,
  ): Point2D {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  const snap = (point: Point2D, alt: boolean): Point2D =>
    alt ? point : { x: Math.round(point.x), y: Math.round(point.y) };
  function anchorPoint(anchor: Endpoint | Point2D): Point2D {
    return 'kind' in anchor ? endpointPosition(props.document, props.devices, anchor) : anchor;
  }
  function snappedAnchor(point: Point2D, alt: boolean): Endpoint | Point2D {
    const pin = pickPins(props.document, props.devices, point, 7 / viewport.scale)[0];
    if (pin !== undefined) return pin.endpoint;
    const node = props.document.nodes.find(
      (value) => Math.hypot(value.x - point.x, value.y - point.y) <= 7 / viewport.scale,
    );
    if (node !== undefined) return { kind: 'node', node: node.id };
    let best: { point: Point2D; distance: number } | undefined;
    for (const wire of props.document.wires) {
      const points = orthogonalPath([
        endpointPosition(props.document, props.devices, wire.from),
        ...wire.bends,
        endpointPosition(props.document, props.devices, wire.to),
      ]);
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        if (from === undefined || to === undefined) continue;
        const projected = projectOnSegment(point, from, to);
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (distance > 7 / viewport.scale || (best !== undefined && distance >= best.distance))
          continue;
        const grid = snap(projected, alt);
        const onAxis = from.x === to.x ? { x: from.x, y: grid.y } : { x: grid.x, y: from.y };
        best = { point: projectOnSegment(onAxis, from, to), distance };
      }
    }
    return best?.point ?? snap(point, alt);
  }
  function commit(action: () => Promise<void>): void {
    if (committing.current) return;
    committing.current = true;
    void action()
      .catch(props.onError)
      .finally(() => {
        committing.current = false;
      });
  }
  function useEndpoint(endpoint: Endpoint | Point2D) {
    setCandidates([]);
    if (props.state.tool !== 'wire') {
      commit(() => props.onEndpoint(endpoint));
      return;
    }
    if (connection === undefined) setConnection({ endpoint, bends: [] });
    else {
      commit(async () => {
        await props.onConnect(connection.endpoint, endpoint, connection.bends);
        setConnection(undefined);
        props.onCancel();
      });
    }
  }
  function input(event: ReactPointerEvent<HTMLCanvasElement>, type: IViewInput['type']): void {
    const active = business.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    const instance = props.document.instances.find((value) => value.id === active.instanceId);
    const geometry =
      instance === undefined ? undefined : props.devices.get(instance.device)?.geometry;
    if (instance === undefined || geometry === undefined) return;
    active.position = sceneToLocal(instance, geometry, toScene(local(event), viewport));
    props.onInput(instance.id, {
      type,
      position: active.position,
      button: active.button,
      buttons: type === 'pointerup' ? 0 : event.buttons,
    });
  }
  return (
    <div className="mica-wb-canvas-part" ref={host}>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="电路画布"
        className={`mica-wb-canvas mica-wb-tool-${props.state.tool}`}
        onFocus={() => props.onFocus(true)}
        onBlur={() => {
          cancelGesture();
          props.onFocus(false);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setConnection(undefined);
          props.onCancel();
        }}
        onKeyDown={(event) => {
          if (event.code === 'Space') {
            event.preventDefault();
            space.current = true;
          }
          if (event.key === 'Escape') {
            setConnection(undefined);
            setCandidates([]);
            cancelGesture();
            props.onCancel();
          }
          if (
            (event.key === 'Delete' || event.key === 'Backspace') &&
            !props.state.readOnly &&
            props.state.mode === 'edit'
          ) {
            event.preventDefault();
            run(props.onDelete());
          }
        }}
        onKeyUp={(event) => {
          if (event.code === 'Space') space.current = false;
        }}
        onPointerDown={(event) => {
          if (gesture.current !== undefined || business.current !== undefined) return;
          event.currentTarget.focus();
          const screen = local(event);
          const point = toScene(screen, viewport);
          if (event.button === 1 || (event.button === 0 && space.current)) {
            gesture.current = {
              kind: 'pan',
              pointerId: event.pointerId,
              start: screen,
              original: { x: viewport.x, y: viewport.y },
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
            return;
          }
          if (event.button !== 0 || props.state.busy || committing.current) return;
          if (props.state.mode === 'run') {
            const instance = pickInstance(
              props.document,
              props.devices,
              point,
              (value) =>
                props.overlays.has(value.id) ||
                ((value.display?.body ?? props.document.display?.body ?? true) &&
                  props.images.has(value.device)),
            );
            if (instance === undefined) return;
            const geometry = props.devices.get(instance.device)?.geometry;
            if (
              geometry === undefined ||
              !contains(geometry.bounds, sceneToLocal(instance, geometry, point))
            )
              return;
            props.onSelection([{ kind: 'instance', id: instance.id }]);
            business.current = {
              instanceId: instance.id,
              pointerId: event.pointerId,
              position: sceneToLocal(instance, geometry, point),
              button: event.button,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            input(event, 'pointerdown');
            return;
          }
          const placing = props.placement;
          if (placing !== undefined && !props.state.readOnly) {
            commit(() => props.onPlace(placing, snap(point, event.altKey)));
            return;
          }
          if (props.state.tool !== 'select' && !props.state.readOnly) {
            const pins = pickPins(props.document, props.devices, point, 7 / viewport.scale);
            if (pins.length > 1) {
              setCandidates(pins);
              return;
            }
            if (pins[0] !== undefined) {
              useEndpoint(pins[0].endpoint);
              return;
            }
            const node = props.document.nodes.find(
              (value) => Math.hypot(value.x - point.x, value.y - point.y) <= 7 / viewport.scale,
            );
            if (node !== undefined) {
              useEndpoint({ kind: 'node', node: node.id });
              return;
            }
            const anchor = snappedAnchor(point, event.altKey);
            if (props.state.tool !== 'wire') useEndpoint(anchor);
            else if (
              'kind' in anchor ||
              props.document.wires.some((wire) => {
                const points = [
                  endpointPosition(props.document, props.devices, wire.from),
                  ...wire.bends,
                  endpointPosition(props.document, props.devices, wire.to),
                ];
                return points.some(
                  (value, index) =>
                    index > 0 &&
                    distanceToSegment(anchorPoint(anchor), points[index - 1] ?? value, value) <
                      1e-8,
                );
              })
            )
              useEndpoint(anchor);
            else if (connection === undefined) setConnection({ endpoint: anchor, bends: [] });
            else
              setConnection({
                ...connection,
                bends: orthogonalPath([
                  anchorPoint(connection.endpoint),
                  ...connection.bends,
                  anchorPoint(anchor),
                ]).slice(1),
              });
            return;
          }
          const instance = pickInstance(props.document, props.devices, point);
          if (instance !== undefined) {
            const target: IWorkbenchTarget = { kind: 'instance', id: instance.id };
            props.onSelection(
              event.shiftKey
                ? [...props.selection.filter((value) => value.id !== instance.id), target]
                : [target],
            );
            if (!props.state.readOnly && !props.state.busy) {
              gesture.current = {
                kind: 'move',
                pointerId: event.pointerId,
                start: point,
                original: instance.placement,
                instanceId: instance.id,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            return;
          }
          const wire = props.document.wires.find((value) => {
            const points = [
              endpointPosition(props.document, props.devices, value.from),
              ...value.bends,
              endpointPosition(props.document, props.devices, value.to),
            ];
            return points.some(
              (p, index) =>
                index > 0 &&
                distanceToSegment(point, points[index - 1] ?? p, p) <= 6 / viewport.scale,
            );
          });
          props.onSelection(wire === undefined ? [] : [{ kind: 'wire', id: wire.id }]);
        }}
        onDoubleClick={(event) => {
          if (props.state.mode !== 'edit' || props.state.busy || props.placement !== undefined)
            return;
          if (props.state.tool === 'wire') {
            if (connection !== undefined)
              useEndpoint(snappedAnchor(toScene(local(event), viewport), event.altKey));
            return;
          }
          const instance = pickInstance(
            props.document,
            props.devices,
            toScene(local(event), viewport),
          );
          if (instance === undefined) return;
          props.onSelection([{ kind: 'instance', id: instance.id }]);
          props.onOpenProperties();
        }}
        onPointerMove={(event) => {
          const point = toScene(local(event), viewport);
          setPointer(
            props.placement !== undefined || props.state.tool === 'select'
              ? snap(point, event.altKey)
              : anchorPoint(snappedAnchor(point, event.altKey)),
          );
          if (business.current !== undefined) {
            input(event, 'pointermove');
            return;
          }
          const active = gesture.current;
          if (active !== undefined && active.pointerId !== event.pointerId) return;
          if (active?.kind === 'pan') {
            const screen = local(event);
            setViewport({
              ...viewport,
              x: active.original.x + screen.x - active.start.x,
              y: active.original.y + screen.y - active.start.y,
            });
          } else if (active?.kind === 'move' && active.instanceId !== undefined) {
            setDrag({
              instanceId: active.instanceId,
              position: snap(
                {
                  x: active.original.x + point.x - active.start.x,
                  y: active.original.y + point.y - active.start.y,
                },
                event.altKey,
              ),
            });
          }
        }}
        onPointerUp={(event) => {
          if (business.current?.pointerId === event.pointerId) {
            input(event, 'pointerup');
            business.current = undefined;
          }
          const active = gesture.current;
          if (active !== undefined && active.pointerId !== event.pointerId) return;
          if (active?.kind === 'move' && active.instanceId !== undefined) {
            const point = toScene(local(event), viewport);
            const position = snap(
              {
                x: active.original.x + point.x - active.start.x,
                y: active.original.y + point.y - active.start.y,
              },
              event.altKey,
            );
            if (position.x !== active.original.x || position.y !== active.original.y)
              run(props.onMove(active.instanceId, position));
          }
          gesture.current = undefined;
          setDrag(undefined);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerCancel={(event) => {
          if (
            business.current?.pointerId === event.pointerId ||
            gesture.current?.pointerId === event.pointerId
          )
            cancelGesture();
        }}
        onLostPointerCapture={(event) => {
          if (
            business.current?.pointerId === event.pointerId ||
            gesture.current?.pointerId === event.pointerId
          )
            cancelGesture();
        }}
      />
      {candidates.length > 0 && (
        <div className="mica-wb-pin-candidates" role="dialog" aria-label="选择引脚">
          {candidates.map((value) => (
            <button key={value.title} onClick={() => useEndpoint(value.endpoint)}>
              {value.title}
            </button>
          ))}
          <button onClick={() => setCandidates([])}>取消</button>
        </div>
      )}
      <div className="mica-wb-viewport-controls" aria-label="视口控制">
        <button title="缩小" aria-label="缩小" onClick={() => zoom(1 / 1.2)}>
          −
        </button>
        <span>{Math.round(viewport.scale * 10)}%</span>
        <button title="放大" aria-label="放大" onClick={() => zoom(1.2)}>
          +
        </button>
        <button title="适应画布" aria-label="适应画布" onClick={fit}>
          适应
        </button>
      </div>
      {props.children}
    </div>
  );
}
