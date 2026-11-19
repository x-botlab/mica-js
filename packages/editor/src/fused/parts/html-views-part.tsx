import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  FloatingBounds,
  FusedInstance,
  InstanceViewLayout,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type { IHtmlViewHandle } from '../html';
import { isHtmlViewError } from '../html';
import type { IWorkbenchUI } from './workbench-part';
import { Icon } from './activity-bar-part';

function ViewSlot({
  handle,
  height,
  visible,
}: {
  readonly handle: IHtmlViewHandle | undefined;
  readonly height?: number;
  readonly visible: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (handle === undefined) return;
    handle.attach(slot.current);
    handle.setVisible(visible);
    return () => handle.attach(null);
  }, [handle, visible]);
  return (
    <div ref={slot} className="mica-wb-html-slot" style={{ height }}>
      {handle?.state === 'failed' && <p role="alert">{handle.failure?.message}</p>}
      {(handle === undefined || handle.state === 'loading') && <p role="status">正在加载视图…</p>}
    </div>
  );
}

export function PanelResizer(props: {
  readonly height: number;
  readonly onPreview: (height: number | undefined) => void;
  readonly onCommit: (height: number) => void;
}) {
  const drag = useRef<{ readonly y: number; readonly height: number } | undefined>(undefined);
  return (
    <div
      className="mica-wb-panel-resizer"
      role="separator"
      aria-label="调整视图大小"
      aria-orientation="horizontal"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        props.onCommit(Math.max(64, props.height + (event.key === 'ArrowDown' ? 20 : -20)));
      }}
      onPointerDown={(event) => {
        drag.current = { y: event.clientY, height: props.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const value = drag.current;
        if (value === undefined) return;
        props.onPreview(Math.max(64, value.height + event.clientY - value.y));
      }}
      onPointerUp={(event) => {
        const value = drag.current;
        drag.current = undefined;
        if (value !== undefined)
          props.onCommit(Math.max(64, value.height + event.clientY - value.y));
        props.onPreview(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        props.onPreview(undefined);
      }}
    />
  );
}

export function HtmlViewsPart(props: {
  readonly ui: IWorkbenchUI;
  readonly instance: FusedInstance;
  readonly manifest: UnifiedDeviceManifest;
  readonly layout: InstanceViewLayout;
}) {
  const { ui, instance, manifest, layout } = props;
  const [draft, setDraft] = useState<Readonly<Record<string, number | undefined>>>({});
  const ordering = useRef<string | undefined>(undefined);
  const running = ui.workbench.getState().mode === 'run' && !ui.workbench.getState().busy;
  const run = (task: Promise<unknown>) => void task.catch(ui.error);
  const lastExpanded = layout.views
    .filter(
      (view) =>
        view.location === 'sidebar' &&
        !view.collapsed &&
        manifest.view?.[view.viewId] !== undefined,
    )
    .at(-1)?.viewId;
  useEffect(() => {
    if (!running) return;
    for (const view of layout.views) {
      if (view.location !== 'sidebar') continue;
      const handle = ui.htmlViews.get(instance.id, view.viewId);
      if (view.collapsed) handle?.setVisible(false);
      else if (handle === undefined)
        void ui.htmlViews
          .open({ instanceId: instance.id, viewId: view.viewId, location: 'sidebar' })
          .catch((reason: unknown) => {
            if (ui.context.signal.aborted) return;
            const selection = ui.workbench.getSelection();
            if (
              isHtmlViewError(reason) &&
              reason.code === 'view/unavailable-mode' &&
              (ui.workbench.getState().mode !== 'run' ||
                selection.length !== 1 ||
                selection[0]?.id !== instance.id)
            )
              return;
            ui.error(reason);
          });
      else handle.setVisible(true);
    }
  }, [running, instance.id, layout, ui]);
  const change = (viewId: string, patch: Partial<InstanceViewLayout['views'][number]>) =>
    run(
      ui.changeViewLayout(instance.id, {
        ...layout,
        views: layout.views.map((view) => (view.viewId === viewId ? { ...view, ...patch } : view)),
      }),
    );
  return (
    <div className="mica-wb-html-views">
      {layout.views
        .filter((view) => view.location === 'sidebar')
        .map((view) => {
          const definition = manifest.view?.[view.viewId];
          if (definition === undefined) return null;
          const handle = ui.htmlViews.get(instance.id, view.viewId);
          return (
            <section
              className={`mica-wb-html-view${view.viewId === lastExpanded ? ' is-fill' : ''}`}
              key={view.viewId}
              aria-label={definition.title}
            >
              <div
                className="mica-wb-panel-title"
                draggable
                onDragStart={(event) => {
                  ordering.current = view.viewId;
                  event.dataTransfer.setData('text/plain', view.viewId);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  if (ordering.current !== undefined) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = ordering.current;
                  ordering.current = undefined;
                  if (from === undefined || from === view.viewId) return;
                  const ordered = [...layout.views];
                  const source = ordered.findIndex((entry) => entry.viewId === from);
                  const target = ordered.findIndex((entry) => entry.viewId === view.viewId);
                  const [item] = ordered.splice(source, 1);
                  if (item !== undefined) {
                    ordered.splice(target, 0, item);
                    run(ui.changeViewLayout(instance.id, { ...layout, views: ordered }));
                  }
                }}
                onDragEnd={() => {
                  ordering.current = undefined;
                }}
              >
                <button
                  aria-expanded={!view.collapsed}
                  onClick={() => change(view.viewId, { collapsed: !view.collapsed })}
                >
                  <Icon name={view.collapsed ? 'chevron-right' : 'chevron-down'} />
                  {definition.title}
                </button>
                <span className="mica-wb-panel-actions">
                  <button
                    title="上移视图"
                    aria-label={`上移${definition.title}`}
                    onClick={() => {
                      const ordered = [...layout.views];
                      const index = ordered.findIndex((entry) => entry.viewId === view.viewId);
                      if (index <= 0) return;
                      const previous = ordered[index - 1];
                      if (previous === undefined) return;
                      ordered[index - 1] = view;
                      ordered[index] = previous;
                      run(ui.changeViewLayout(instance.id, { ...layout, views: ordered }));
                    }}
                  >
                    <Icon name="arrow-up" />
                  </button>
                  <button
                    title="浮动视图"
                    aria-label={`将${definition.title}设为浮动`}
                    onClick={() =>
                      run(
                        ui.workbench.executeCommand('view.setLocation', {
                          instanceId: instance.id,
                          viewId: view.viewId,
                          location: 'floating',
                        }),
                      )
                    }
                  >
                    <Icon name="link-external" />
                  </button>
                </span>
              </div>
              {!view.collapsed &&
                (running ? (
                  <ViewSlot handle={handle} height={draft[view.viewId] ?? view.height} visible />
                ) : (
                  <p className="mica-wb-empty">切换到运行模式后可打开此视图。</p>
                ))}
              {!view.collapsed && (
                <PanelResizer
                  height={view.height}
                  onPreview={(height) =>
                    setDraft((current) => ({ ...current, [view.viewId]: height }))
                  }
                  onCommit={(height) => change(view.viewId, { height })}
                />
              )}
            </section>
          );
        })}
    </div>
  );
}

export function FloatingViewsPart({ ui }: { readonly ui: IWorkbenchUI }) {
  return (
    <div className="mica-wb-floating-layer">
      {ui.htmlViews.views
        .filter((view) => view.location === 'floating' && view.state !== 'closed')
        .map((view) => (
          <FloatingView key={view.key} ui={ui} handle={view} />
        ))}
    </div>
  );
}

const floatingResizeHandles = [
  ['n', '上'],
  ['ne', '右上'],
  ['e', '右'],
  ['se', '右下'],
  ['s', '下'],
  ['sw', '左下'],
  ['w', '左'],
  ['nw', '左上'],
] as const;
type FloatingResizeEdge = (typeof floatingResizeHandles)[number][0];

function FloatingView({
  ui,
  handle,
}: {
  readonly ui: IWorkbenchUI;
  readonly handle: IHtmlViewHandle;
}) {
  const pane = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<FloatingBounds>();
  const [area, setArea] = useState({ width: 640, height: 480 });
  const drag = useRef<
    | {
        readonly kind: 'move' | FloatingResizeEdge;
        readonly x: number;
        readonly y: number;
        readonly bounds: FloatingBounds;
        next: FloatingBounds;
      }
    | undefined
  >(undefined);
  const instance = ui.workbench
    .getDocument()
    .instances.find((item) => item.id === handle.instanceId);
  const layout = ui.viewLayout(handle.instanceId);
  const saved = layout.views.find((view) => view.viewId === handle.viewId)?.floatingBounds;
  const requested = preview ??
    saved ?? { x: (area.width - 360) / 2, y: 80, width: 360, height: 280 };
  const constrain = (value: FloatingBounds): FloatingBounds => {
    const width = Math.max(180, Math.min(value.width, area.width));
    const height = Math.max(100, Math.min(value.height, area.height));
    return {
      width,
      height,
      x: Math.max(0, Math.min(value.x, area.width - width)),
      y: Math.max(0, Math.min(value.y, area.height - height)),
    };
  };
  const resize = (original: FloatingBounds, edge: FloatingResizeEdge, dx: number, dy: number) => {
    const next = { ...original };
    if (edge.includes('e'))
      next.width = Math.max(180, Math.min(original.width + dx, area.width - original.x));
    if (edge.includes('s'))
      next.height = Math.max(100, Math.min(original.height + dy, area.height - original.y));
    if (edge.includes('w')) {
      const right = original.x + original.width;
      next.x = Math.max(0, Math.min(original.x + dx, right - 180));
      next.width = right - next.x;
    }
    if (edge.includes('n')) {
      const bottom = original.y + original.height;
      next.y = Math.max(0, Math.min(original.y + dy, bottom - 100));
      next.height = bottom - next.y;
    }
    return next;
  };
  const bounds = constrain(requested);
  const cancel = () => {
    drag.current = undefined;
    setPreview(undefined);
  };
  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  useLayoutEffect(() => {
    const host = pane.current?.parentElement;
    if (host === null || host === undefined) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined)
        setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => ui.htmlViews.refresh(), [bounds.x, bounds.y, bounds.width, bounds.height]);
  const commit = (value: FloatingBounds) =>
    void ui
      .changeViewLayout(handle.instanceId, {
        ...layout,
        views: layout.views.map((view) =>
          view.viewId === handle.viewId ? { ...view, floatingBounds: constrain(value) } : view,
        ),
      })
      .catch(ui.error);
  const start = (event: React.PointerEvent<HTMLElement>, kind: 'move' | FloatingResizeEdge) => {
    if (event.button !== 0 || drag.current !== undefined) return;
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    event.preventDefault();
    drag.current = { kind, x: event.clientX, y: event.clientY, bounds, next: bounds };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (active === undefined) return;
    active.next =
      active.kind === 'move'
        ? {
            ...active.bounds,
            x: active.bounds.x + event.clientX - active.x,
            y: active.bounds.y + event.clientY - active.y,
          }
        : resize(active.bounds, active.kind, event.clientX - active.x, event.clientY - active.y);
    setPreview(active.next);
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (active !== undefined) move(event);
    drag.current = undefined;
    if (active !== undefined) commit(active.next);
    setPreview(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section
      ref={pane}
      className="mica-wb-floating-view"
      role="dialog"
      aria-label={`${instance?.designator ?? handle.instanceId} · ${handle.title}`}
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
    >
      <div
        className="mica-wb-panel-title"
        onPointerDown={(event) => start(event, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        <span>
          {instance?.designator ?? handle.instanceId} · {handle.title}
        </span>
        <span className="mica-wb-panel-actions">
          <button
            title="停靠视图"
            aria-label={`停靠${handle.title}`}
            onClick={() =>
              void ui.workbench
                .executeCommand('view.setLocation', {
                  instanceId: handle.instanceId,
                  viewId: handle.viewId,
                  location: 'sidebar',
                })
                .catch(ui.error)
            }
          >
            <Icon name="layout-sidebar-right" />
          </button>
          <button
            title="关闭视图"
            aria-label={`关闭${handle.title}`}
            onClick={() => handle.close()}
          >
            <Icon name="close" />
          </button>
        </span>
      </div>
      <ViewSlot handle={handle} visible />
      {floatingResizeHandles.map(([edge, label]) => (
        <div
          key={edge}
          className={`mica-wb-floating-resizer mica-wb-floating-resizer-${edge}`}
          role="separator"
          aria-label={`调整浮动视图大小（${label}）`}
          aria-orientation={edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'}
          aria-valuetext={`${Math.round(bounds.width)} × ${Math.round(bounds.height)}`}
          tabIndex={edge === 'se' ? 0 : -1}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 40 : 10;
            const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
            const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
            if (dx === 0 && dy === 0) return;
            event.preventDefault();
            commit(resize(bounds, edge, dx, dy));
          }}
          onPointerDown={(event) => start(event, edge)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        />
      ))}
    </section>
  );
}
