import { useEffect, useRef, useState } from 'react';
import type { Disposable } from '@mica-js/core/lifecycle';
import type {
  IWorkbenchDiagnostic,
  IWorkbenchExtensionContext,
  IWorkbenchView,
  IWorkbenchViewContainer,
} from '../types';
import { Icon } from './activity-bar-part';

function ContributedView(props: {
  readonly hideHeader: boolean;
  readonly view: IWorkbenchView;
  readonly context: IWorkbenchExtensionContext;
  readonly report: (diagnostic: IWorkbenchDiagnostic) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const abort = new AbortController();
    const scope = props.context.contextKeys.createScope();
    let result: Disposable | undefined;
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!abort.signal.aborted) setError(message);
      props.report({
        code: 'workbench/view-failed',
        message: `${props.view.title}: ${message}`,
        severity: 'error',
      });
    };
    setError(undefined);
    void Promise.resolve()
      .then(() =>
        props.view.mount(target, { ...props.context, contextKeys: scope, signal: abort.signal }),
      )
      .then((disposable) => {
        if (typeof disposable?.dispose !== 'function')
          throw new TypeError(`视图 ${props.view.id} 必须返回 Disposable`);
        if (abort.signal.aborted) disposable.dispose();
        else result = disposable;
      })
      .catch(fail);
    return () => {
      abort.abort();
      scope.dispose();
      try {
        result?.dispose();
      } catch (error) {
        fail(error);
      }
    };
  }, [props.view, props.context]);
  return (
    <section className="mica-wb-contributed-view" aria-label={props.view.title}>
      {!props.hideHeader && <h3>{props.view.title}</h3>}
      {error !== undefined && <p role="alert">{error}</p>}
      <div ref={element} className="mica-wb-view-mount" />
    </section>
  );
}

export function SidebarPart(props: {
  readonly container: IWorkbenchViewContainer;
  readonly views: readonly IWorkbenchView[];
  readonly context: IWorkbenchExtensionContext;
  readonly onClose: () => void;
  readonly report: (diagnostic: IWorkbenchDiagnostic) => void;
  readonly children?: React.ReactNode;
  readonly hideHeader?: boolean;
  readonly title?: string | undefined;
  readonly actions?: React.ReactNode;
  readonly properties?: boolean;
  readonly singleView?: boolean;
}) {
  const sidebar = useRef<HTMLElement>(null);
  return (
    <aside
      ref={sidebar}
      className={`mica-wb-sidebar${props.properties ? ' mica-wb-sidebar-properties' : ''}${props.singleView ? ' mica-wb-sidebar-single' : ''}`}
      aria-label={props.container.title}
    >
      <div
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        className="mica-wb-sidebar-resizer"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const root = sidebar.current?.closest<HTMLElement>('.mica-workbench');
          if (root !== null && root !== undefined)
            root.style.setProperty(
              '--mica-sidebar-width',
              `${Math.max(240, Math.min(480, (sidebar.current?.offsetWidth ?? 320) + (event.key === 'ArrowLeft' ? 20 : -20)))}px`,
            );
        }}
        onPointerDown={(event) => {
          const root = sidebar.current?.closest<HTMLElement>('.mica-workbench');
          if (root === null || root === undefined) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const start = event.clientX;
          const width = sidebar.current?.offsetWidth ?? 320;
          const handle = event.currentTarget;
          const move = (input: PointerEvent) =>
            root.style.setProperty(
              '--mica-sidebar-width',
              `${Math.max(240, Math.min(480, width + start - input.clientX))}px`,
            );
          const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', end);
          handle.addEventListener('pointercancel', end);
        }}
      />
      {!props.hideHeader && (
        <header className="mica-wb-sidebar-header">
          <span>
            {props.title ??
              (props.singleView
                ? (props.views[0]?.title ?? props.container.title)
                : props.container.title)}
          </span>
          <span className="mica-wb-panel-actions">
            {props.actions}
            <button title="收起侧栏" aria-label="收起侧栏" onClick={props.onClose}>
              <Icon name="chevron-right" />
            </button>
          </span>
        </header>
      )}
      <div className="mica-wb-sidebar-content">
        {props.children}
        {props.views.map((view) => (
          <ContributedView
            key={view.id}
            hideHeader={props.singleView === true}
            view={view}
            context={props.context}
            report={props.report}
          />
        ))}
      </div>
    </aside>
  );
}
