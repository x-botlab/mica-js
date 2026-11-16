import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Event } from '@mica-js/core/lifecycle';
import type {
  DeviceLock,
  Endpoint,
  InstanceViewLayout,
  PropertyValue,
  Point2D,
} from '@mica-js/document/fused';
import type { IHtmlViewHost } from '../html';
import type {
  IWorkbench,
  IWorkbenchDiagnostic,
  IWorkbenchExtensionContext,
  IWorkbenchOptions,
} from '../types';
import type { ICanvasDevice } from '../canvas/geometry';
import type { ContributionRegistry } from '../contributions/registry';
import { ActivityBarPart } from './activity-bar-part';
import { CanvasPart, type ICanvasHandle, type IViewInput } from './canvas-part';
import { SidebarPart } from './sidebar-part';
import { ToolbarPart } from './toolbar-part';
import { InstancesView } from '../views/instances';
import { InspectorView } from '../views/inspector';
import { ProblemsView } from '../views/problems';
import { FloatingViewsPart, HtmlViewsPart, PanelResizer } from './html-views-part';
import { Icon } from './activity-bar-part';
import { readCanvasTheme, resolveTheme, themeStyle, type IWorkbenchTheme } from '../theme';

export interface IWorkbenchUI {
  readonly workbench: IWorkbench;
  readonly options: IWorkbenchOptions;
  readonly context: IWorkbenchExtensionContext;
  readonly theme: IWorkbenchTheme;
  readonly htmlViews: IHtmlViewHost;
  readonly viewLayout: (instanceId: string) => InstanceViewLayout;
  readonly changeViewLayout: (
    instanceId: string,
    layout: InstanceViewLayout | undefined,
  ) => Promise<void>;
  readonly contributions: ContributionRegistry;
  readonly onDidUpdate: Event<void>;
  readonly devices: ReadonlyMap<string, ICanvasDevice>;
  readonly images: ReadonlyMap<string, CanvasImageSource>;
  readonly overlays: ReadonlyMap<string, ImageBitmap>;
  readonly diagnostics: readonly IWorkbenchDiagnostic[];
  readonly placement: DeviceLock | undefined;
  readonly version: number;
  readonly setCanvas: (canvas: ICanvasHandle | undefined) => void;
  readonly report: (diagnostic: IWorkbenchDiagnostic) => void;
  readonly error: (error: unknown) => void;
  readonly input: (instanceId: string, event: IViewInput) => void;
  readonly labelName: string;
  readonly setLabelName: (name: string) => void;
  readonly connect: (
    from: Endpoint | Point2D,
    to: Endpoint | Point2D,
    bends: readonly Point2D[],
  ) => Promise<void>;
  readonly endpoint: (endpoint: Endpoint | Point2D) => Promise<void>;
  readonly cancel: () => void;
  readonly focus: (focused: boolean) => void;
  readonly viewport: () => void;
  readonly reveal: (instanceId: string) => void;
  readonly importResource: (instanceId: string, key: string, file: File) => Promise<void>;
  readonly openProject: (projectId: string) => void;
}

export function WorkbenchPart({ ui }: { readonly ui: IWorkbenchUI }) {
  const frame = useSyncExternalStore(
    (callback) => {
      const subscription = ui.onDidUpdate(callback);
      return () => subscription.dispose();
    },
    () => ui.version,
  );
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const root = useRef<HTMLDivElement>(null);
  const [propertyHeight, setPropertyHeight] = useState<number>();
  const [emptyPropertiesCollapsed, setEmptyPropertiesCollapsed] = useState(false);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const state = ui.workbench.getState();
  const document = ui.workbench.getDocument();
  const selection = ui.workbench.getSelection();
  const active = ui.contributions.containers.find(
    (container) => container.id === state.activeContainer && ui.contributions.visible(container),
  );
  const single =
    selection.length === 1 && selection[0]?.kind === 'instance'
      ? document.instances.find((instance) => instance.id === selection[0]?.id)
      : undefined;
  const manifest = single === undefined ? undefined : ui.devices.get(single.device)?.manifest;
  const layout =
    single === undefined || manifest === undefined ? undefined : ui.viewLayout(single.id);
  const run = (task: Promise<unknown>) => {
    void task.catch(ui.error);
  };
  const setProperty = (key: string, value: PropertyValue) => {
    if (single !== undefined)
      run(ui.workbench.executeCommand('device.setProperty', { instanceId: single.id, key, value }));
  };
  const propertyCollapsed = layout?.properties.collapsed ?? emptyPropertiesCollapsed;
  const toggleProperties = (collapsed: boolean) => {
    if (single === undefined || layout === undefined) setEmptyPropertiesCollapsed(collapsed);
    else
      run(
        ui.changeViewLayout(single.id, {
          ...layout,
          properties: { ...layout.properties, collapsed },
        }),
      );
  };
  const deviceViewIds = new Set<string>();
  const floating = new Map<
    string,
    { instanceId: string; viewId: string; title: string; icon: string | undefined }
  >();
  if (state.mode === 'run') {
    for (const view of layout?.views ?? []) {
      const definition = manifest?.view?.[view.viewId];
      if (single === undefined || definition === undefined) continue;
      const key = `${single.id}/${view.viewId}`;
      deviceViewIds.add(key);
      if (view.location === 'floating')
        floating.set(key, {
          instanceId: single.id,
          viewId: view.viewId,
          title: definition.title,
          icon: definition.icon,
        });
    }
    for (const handle of ui.htmlViews.views) {
      if (handle.location !== 'floating' || handle.state === 'closed') continue;
      deviceViewIds.add(`${handle.instanceId}/${handle.viewId}`);
      floating.set(`${handle.instanceId}/${handle.viewId}`, {
        instanceId: handle.instanceId,
        viewId: handle.viewId,
        title: handle.title,
        icon: undefined,
      });
    }
  }
  const multipleInfoViews =
    deviceViewIds.size > 0 ||
    ui.contributions.views.some(
      (view) => view.containerId === 'mica.properties' && ui.contributions.visible(view),
    );
  const propertyActions =
    single === undefined || layout === undefined ? undefined : (
      <button
        title="恢复视图布局"
        aria-label="恢复视图布局"
        onClick={() => run(ui.changeViewLayout(single.id, undefined))}
      >
        <Icon name="discard" />
      </button>
    );
  const floatingActions = [...floating]
    .filter(([, view]) => ui.htmlViews.get(view.instanceId, view.viewId) === undefined)
    .map(([key, view]) => (
      <button
        key={key}
        title={view.title}
        aria-label={`${document.instances.find((instance) => instance.id === view.instanceId)?.designator ?? view.instanceId} ${view.title}`}
        disabled={state.busy}
        onClick={() =>
          run(
            ui.workbench.executeCommand('view.open', {
              instanceId: view.instanceId,
              viewId: view.viewId,
            }),
          )
        }
      >
        <Icon name={view.icon ?? 'link-external'} />
      </button>
    ));
  const theme = useMemo(() => resolveTheme(ui.theme, systemDark), [ui.theme, systemDark]);
  // Device HTML views mirror the *computed* colors, so a host `var(...)` token is already resolved
  // when the environment writes it into its author document.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    ui.htmlViews.setTheme({
      appearance: theme.appearance,
      colors: readCanvasTheme(element),
    });
  }, [ui.htmlViews, theme]);
  return (
    <div
      ref={root}
      className={`mica-workbench mica-wb-${theme.appearance} ${active === undefined ? '' : 'mica-wb-sidebar-open'}`}
      style={{ ...themeStyle(theme), colorScheme: theme.appearance }}
      data-theme={theme.appearance}
      role="region"
      aria-label="电路工作台"
      lang="zh-CN"
      aria-busy={state.busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (ui.placement !== undefined || state.tool !== 'select')) {
          event.preventDefault();
          ui.cancel();
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.matches('input,textarea,select') || target.isContentEditable)
        )
          return;
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key.toLowerCase() === 's') {
          event.preventDefault();
          run(ui.workbench.save());
        }
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          run(ui.workbench.executeCommand(event.shiftKey ? 'document.redo' : 'document.undo'));
        }
        if (event.key.toLowerCase() === 'y') {
          event.preventDefault();
          run(ui.workbench.executeCommand('document.redo'));
        }
      }}
    >
      <CanvasPart
        document={document}
        devices={ui.devices}
        images={ui.images}
        overlays={ui.overlays}
        state={state}
        selection={selection}
        placement={ui.placement}
        labelName={ui.labelName}
        theme={theme}
        frame={frame}
        onReady={ui.setCanvas}
        onSelection={(targets) => ui.workbench.setSelection(targets)}
        onOpenProperties={() =>
          run(
            ui.workbench.executeCommand('workbench.openContainer', {
              id: 'mica.properties',
              focus: true,
            }),
          )
        }
        onPlace={async (device, position) => {
          await ui.workbench.executeCommand('device.add', {
            device,
            placement: { ...position, rotation: 0 },
          });
          ui.cancel();
        }}
        onMove={async (instanceId, position) => {
          await ui.workbench.executeCommand('device.move', { instanceId, position });
        }}
        onConnect={ui.connect}
        onEndpoint={ui.endpoint}
        onCancel={ui.cancel}
        onDelete={async () => {
          await ui.workbench.executeCommand('selection.delete');
        }}
        onInput={ui.input}
        onError={ui.error}
        onFocus={ui.focus}
        onViewport={ui.viewport}
      >
        <ToolbarPart
          state={state}
          registry={ui.contributions}
          context={ui.context}
          onError={ui.error}
        />
        {state.busy && (
          <div className="mica-wb-status" role="status">
            正在准备…
          </div>
        )}
        {!state.busy && state.mode === 'edit' && state.readOnly && (
          <div className="mica-wb-status" role="status">
            只读
          </div>
        )}
        {!state.busy && ui.placement !== undefined && (
          <div className="mica-wb-status" role="status">
            单击放置 · Esc 取消
          </div>
        )}
        {!state.busy &&
          state.mode === 'edit' &&
          !state.readOnly &&
          ['power', 'ground', 'label'].includes(state.tool) && (
            <div className="mica-wb-status" role="status">
              {state.tool === 'label' && (
                <label>
                  网标{' '}
                  <input
                    aria-label="网标名称"
                    value={ui.labelName}
                    onChange={(event) => ui.setLabelName(event.target.value)}
                  />
                </label>
              )}
              单击放置 · Esc 取消
            </div>
          )}
        {ui.diagnostics.some((diagnostic) => diagnostic.severity === 'error') && (
          <button
            className="mica-wb-problem-indicator"
            onClick={() =>
              run(ui.workbench.executeCommand('workbench.openContainer', { id: 'mica.problems' }))
            }
          >
            {ui.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length} problems
          </button>
        )}
      </CanvasPart>
      {active !== undefined && (
        <SidebarPart
          properties={active.id === 'mica.properties'}
          singleView={
            active.id === 'mica.properties'
              ? !multipleInfoViews
              : ui.contributions.views.filter(
                  (view) => view.containerId === active.id && ui.contributions.visible(view),
                ).length +
                  (active.id === 'mica.instances' || active.id === 'mica.problems' ? 1 : 0) ===
                1
          }
          title={
            active.id === 'mica.properties' ? (multipleInfoViews ? '信息' : '属性') : undefined
          }
          actions={
            active.id === 'mica.properties'
              ? multipleInfoViews
                ? floatingActions
                : propertyActions
              : undefined
          }
          container={active}
          views={ui.contributions.views.filter(
            (view) => view.containerId === active.id && ui.contributions.visible(view),
          )}
          context={ui.context}
          onClose={() => run(ui.workbench.executeCommand('workbench.closeContainer'))}
          report={ui.report}
        >
          {active.id === 'mica.instances' && (
            <InstancesView
              document={document}
              devices={ui.devices}
              selection={selection}
              onSelect={ui.reveal}
            />
          )}
          {active.id === 'mica.properties' && (
            <>
              <InspectorView
                hideHeader={!multipleInfoViews}
                fill={
                  state.mode !== 'run' ||
                  !layout?.views.some(
                    (view) =>
                      view.location === 'sidebar' &&
                      !view.collapsed &&
                      manifest?.view?.[view.viewId] !== undefined,
                  )
                }
                instance={single}
                manifest={
                  single === undefined ? undefined : ui.devices.get(single.device)?.manifest
                }
                selectionCount={selection.length}
                disabled={state.readOnly || state.mode !== 'edit' || state.busy}
                projectProvider={ui.options.firmwareProjectProvider}
                onSet={setProperty}
                onReset={(key) => {
                  if (single !== undefined)
                    run(
                      ui.workbench.executeCommand('device.removeProperty', {
                        instanceId: single.id,
                        key,
                      }),
                    );
                }}
                onImport={async (key, file) => {
                  if (single !== undefined) await ui.importResource(single.id, key, file);
                }}
                onCreate={(key) => {
                  if (single !== undefined)
                    run(
                      ui.workbench.executeCommand('firmware.createProject', {
                        instanceId: single.id,
                        propertyKey: key,
                      }),
                    );
                }}
                onOpenProject={ui.openProject}
                onError={ui.error}
                collapsed={propertyCollapsed}
                height={
                  multipleInfoViews ? (propertyHeight ?? layout?.properties.height) : undefined
                }
                onToggle={toggleProperties}
                actions={multipleInfoViews ? propertyActions : undefined}
              />
              {single !== undefined && manifest !== undefined && layout !== undefined && (
                <>
                  {multipleInfoViews && !layout.properties.collapsed && (
                    <PanelResizer
                      height={layout.properties.height}
                      onPreview={setPropertyHeight}
                      onCommit={(height) =>
                        run(
                          ui.changeViewLayout(single.id, {
                            ...layout,
                            properties: { ...layout.properties, height },
                          }),
                        )
                      }
                    />
                  )}
                  {state.mode === 'run' && (
                    <HtmlViewsPart ui={ui} instance={single} manifest={manifest} layout={layout} />
                  )}
                </>
              )}
            </>
          )}
          {active.id === 'mica.problems' && (
            <ProblemsView diagnostics={ui.diagnostics} onReveal={ui.reveal} />
          )}
        </SidebarPart>
      )}
      <ActivityBarPart
        containers={ui.contributions.containers.filter((container) =>
          ui.contributions.visible(container),
        )}
        active={active?.id}
        problemCount={ui.diagnostics.length}
        onActivate={(id) => {
          if (id === state.activeContainer)
            run(ui.workbench.executeCommand('workbench.closeContainer'));
          else run(ui.workbench.executeCommand('workbench.openContainer', { id, focus: true }));
        }}
      />
      <FloatingViewsPart ui={ui} />
    </div>
  );
}
