import {
  AlertCircle,
  Download,
  Loader2,
  LocateFixed,
  Maximize,
  PanelRight,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  SkipForward,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  createCanvasEditor,
  createSchematicEditor,
  type IEditorIntegrationState,
} from '@mica-js/editor';
import '@mica-js/editor/style.css';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  demoDocument,
  demoDeviceLibrary,
  createDemoFileSystem,
  demoFileName,
  demoWidgetLibrary,
  loadDemoDocument,
  resetDemoDeviceReads,
  onDemoDeviceResolved,
  serializeDemoSnapshot,
  DEMO_DOCUMENTS,
  type IDemoLoadedDocument,
  type DemoSnapshot,
} from '@/runtime-demo';

import {
  createSimulationPrepareStore,
  prepareText,
  runSimulationPrepare,
} from '@/sim/simulation-prepare';
import { IntegrationPanel } from '@/integration-panel';
import { errorMessage, type EditorSession } from '@/host-integration';

type ToolbarAction =
  | 'undo'
  | 'redo'
  | 'run'
  | 'pause'
  | 'step'
  | 'reset'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetView'
  | 'fitView';

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorSession | undefined>(undefined);
  const [session, setSession] = useState<EditorSession>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [focusProperties, setFocusProperties] = useState(0);
  const latest = useRef<DemoSnapshot | undefined>(undefined);
  const documents = useRef<Record<string, IDemoLoadedDocument>>({});
  const [prepare] = useState(createSimulationPrepareStore);
  const prepareState = useSyncExternalStore(prepare.subscribe, prepare.get);
  const prepareStatus = prepareText(prepareState);
  const [documentId, setDocumentId] = useState(() => {
    // 深链接：`?doc=ct107d-canvas` 直接打开指定文档，方便分享预览。
    const requested = new URLSearchParams(globalThis.location.search).get('doc');
    return demoDocument(requested ?? 'example-canvas').id;
  });
  const descriptor = demoDocument(documentId);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<IEditorIntegrationState | null>(null);
  /** 每次挂载的读取窗口编号；StrictMode 里被丢弃的那次挂载不能结束新窗口。 */
  const readingEpoch = useRef(0);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    const epoch = (readingEpoch.current += 1);
    let cancelled = false;
    let instance: EditorSession | undefined;
    const subscriptions: { dispose(): void }[] = [];
    const mount = document.createElement('div');
    mount.className = 'absolute inset-0';
    container.append(mount);
    editor.current = undefined;
    setSession(undefined);
    latest.current = undefined;
    setLoading(true);
    setReady(false);
    setBusy(false);
    setStatus(null);
    setLoadError(null);
    setActionError(null);
    // 打开文档就是准备过程的第一段：读取并解析器件库，读数来自真实的器件包解析次数。
    prepare.dispatch({ type: 'reset' });
    resetDemoDeviceReads();
    prepare.dispatch({ type: 'read-start' });
    const stopReading = onDemoDeviceResolved((count) => {
      if (prepare.get().phase !== 'reading') return;
      prepare.dispatch({ type: 'device-read', count });
    });

    const start = async (): Promise<void> => {
      try {
        const fileSystem = createDemoFileSystem(() => Object.values(documents.current));
        const loaded = await loadDemoDocument(documentId, fileSystem);
        if (cancelled) return;
        latest.current = loaded.snapshot;
        documents.current[documentId] = loaded;
        const kind = descriptor.kind;
        const created: EditorSession =
          kind === 'canvas'
            ? {
                kind,
                editor: await createCanvasEditor({
                  container: mount,
                  uri: loaded.uri,
                  fileSystem,
                  deviceLibrary: demoDeviceLibrary,
                  widgetLibrary: demoWidgetLibrary,
                  voltageReferences: { VCC: 5 },
                  ...(descriptor.stepMs === undefined ? {} : { stepMs: descriptor.stepMs }),
                }),
              }
            : {
                kind,
                editor: await createSchematicEditor({
                  container: mount,
                  uri: loaded.uri,
                  fileSystem,
                  deviceLibrary: demoDeviceLibrary,
                }),
              };
        if (cancelled) {
          await created.editor.dispose();
          return;
        }
        instance = created;
        editor.current = created;
        const snapshot = () => {
          if (cancelled) return;
          latest.current =
            created.kind === 'canvas'
              ? { kind: 'canvas', document: created.editor.getDocument() }
              : { kind: 'schematic', document: created.editor.getDocument() };
          documents.current[documentId] = { uri: loaded.uri, snapshot: latest.current };
        };
        snapshot();
        subscriptions.push(
          created.editor.onDidChangeContent(snapshot),
          created.editor.onDidChangeState((state) => {
            if (!cancelled) setStatus(state);
          }),
          created.editor.onDidError(({ source, error }) => {
            if (!cancelled) setActionError(`${source}: ${errorMessage(error)}`);
          }),
          created.editor.onDidDoubleClick(() => {
            if (cancelled) return;
            setPanelOpen(true);
            setFocusProperties((value) => value + 1);
          }),
        );
        setStatus(created.editor.getState());
        setSession(created);
        setReady(true);
        setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setLoadError(errorMessage(cause));
          setLoading(false);
        }
      } finally {
        stopReading();
        if (epoch === readingEpoch.current) prepare.endReading();
      }
    };
    void start();

    return () => {
      cancelled = true;
      stopReading();
      for (const subscription of subscriptions) subscription.dispose();
      if (editor.current === instance) {
        editor.current = undefined;
      }
      latest.current = undefined;
      mount.remove();
      if (instance !== undefined) {
        void instance.editor.dispose().catch(() => undefined);
      }
    };
  }, [documentId, reloadKey]);
  const pending = useRef<EditorSession | undefined>(undefined);
  const perform = useCallback(
    async (owner: EditorSession, action: () => Promise<unknown>): Promise<void> => {
      if (editor.current !== owner || pending.current === owner) return;
      pending.current = owner;
      setBusy(true);
      setActionError(null);
      try {
        await action();
      } catch (cause) {
        if (editor.current === owner) setActionError(errorMessage(cause));
        throw cause;
      } finally {
        if (pending.current === owner) pending.current = undefined;
        if (editor.current === owner) {
          setBusy(false);
          setStatus(owner.editor.getState());
        }
      }
    },
    [],
  );

  const runCommand = (action: ToolbarAction): void => {
    const current = editor.current;
    if (!current) return;
    void perform(current, async () => {
      if (current.kind === 'canvas') return current.editor.executeCommand(`canvas.${action}`);
      if (action === 'undo') return current.editor.executeCommand('schematic.undo');
      if (action === 'redo') return current.editor.executeCommand('schematic.redo');
    }).catch(() => undefined);
  };

  const setCanvasMode = (mode: 'edit' | 'simulation'): void => {
    const current = editor.current;
    if (current?.kind !== 'canvas') return;
    if (mode === 'edit') {
      prepare.dispatch({ type: 'reset' });
      void perform(current, () => current.editor.executeCommand('canvas.setMode', { mode })).catch(
        () => undefined,
      );
      return;
    }
    // 切到仿真：装配 → 首次推进都在可见的准备状态里完成，帧循环接手时编译已经发生过。
    prepare.dispatch({ type: 'reset' });
    void perform(current, () =>
      runSimulationPrepare(
        {
          switchToSimulation: () => current.editor.executeCommand('canvas.setMode', { mode }),
          firstAdvance: () => current.editor.executeCommand('canvas.step'),
          paint: nextPaint,
        },
        prepare.dispatch,
      ),
    ).catch(() => undefined);
  };

  const download = useCallback((): void => {
    const snapshot = latest.current;
    if (snapshot === undefined) return;
    try {
      const url = URL.createObjectURL(
        new Blob([serializeDemoSnapshot(snapshot)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = demoFileName(documentId);
      document.body.append(link);
      link.click();
      link.remove();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }, [documentId]);

  const controlsDisabled = !ready || busy;
  const simulationMode = descriptor.kind === 'canvas' && status?.mode === 'simulation';
  const simulationActionsDisabled = controlsDisabled || !simulationMode;
  const canEdit = !controlsDisabled && status?.mode === 'edit' && !status.readOnly;
  const modeLabel =
    descriptor.kind === 'schematic'
      ? '原理图'
      : prepareStatus !== undefined
        ? '准备中'
        : status === null
          ? '—'
          : status.mode === 'edit'
            ? '编辑'
            : status.running
              ? '运行中'
              : '已暂停';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b px-3">
        <span className="bg-primary text-primary-foreground grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold">
          M
        </span>
        <select
          aria-label="示例文档"
          value={documentId}
          disabled={busy}
          onChange={(event) => setDocumentId(event.target.value)}
          className="border-input bg-background focus-visible:ring-ring/50 h-7 shrink-0 rounded-md border px-2 text-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
        >
          {DEMO_DOCUMENTS.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>

        {descriptor.kind === 'canvas' ? (
          <div
            role="group"
            aria-label="画布模式"
            className="border-input bg-background inline-flex shrink-0 items-center rounded-md border p-0.5"
          >
            {(['edit', 'simulation'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={status?.mode === mode}
                disabled={!ready || busy}
                onClick={() => setCanvasMode(mode)}
                className={cn(
                  'h-6 rounded px-2 text-[11px] transition-colors disabled:opacity-50',
                  status?.mode === mode
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode === 'edit' ? '编辑' : '仿真'}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <span className="text-muted-foreground mr-1 hidden text-[11px] tabular-nums sm:inline">
            {modeLabel}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="撤销"
            aria-label="撤销"
            disabled={!canEdit || !status?.canUndo}
            onClick={() => runCommand('undo')}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="重做"
            aria-label="重做"
            disabled={!canEdit || !status?.canRedo}
            onClick={() => runCommand('redo')}
          >
            <Redo2 />
          </Button>

          {descriptor.kind === 'canvas' ? (
            <>
              <span className="bg-border mx-1 h-4 w-px" aria-hidden />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="缩小视图"
                aria-label="缩小视图"
                disabled={controlsDisabled}
                onClick={() => runCommand('zoomOut')}
              >
                <ZoomOut />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="放大视图"
                aria-label="放大视图"
                disabled={controlsDisabled}
                onClick={() => runCommand('zoomIn')}
              >
                <ZoomIn />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="适应内容"
                aria-label="适应内容"
                disabled={controlsDisabled}
                onClick={() => runCommand('fitView')}
              >
                <Maximize />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="重置视图"
                aria-label="重置视图"
                disabled={controlsDisabled}
                onClick={() => runCommand('resetView')}
              >
                <LocateFixed />
              </Button>
              <span className="bg-border mx-1 h-4 w-px" aria-hidden />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="运行仿真"
                aria-label="运行仿真"
                disabled={simulationActionsDisabled || status?.running === true}
                onClick={() => runCommand('run')}
              >
                <Play />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="暂停仿真"
                aria-label="暂停仿真"
                disabled={simulationActionsDisabled || status?.running !== true}
                onClick={() => runCommand('pause')}
              >
                <Pause />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="单步仿真"
                aria-label="单步仿真"
                disabled={simulationActionsDisabled || status?.running === true}
                onClick={() => runCommand('step')}
              >
                <SkipForward />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="复位仿真"
                aria-label="复位仿真"
                disabled={simulationActionsDisabled}
                onClick={() => runCommand('reset')}
              >
                <RotateCcw />
              </Button>
            </>
          ) : null}

          <span className="bg-border mx-1 h-4 w-px" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="文档属性"
            aria-label="切换属性侧栏"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((value) => !value)}
          >
            <PanelRight />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="下载当前文档"
            aria-label="下载当前文档"
            disabled={controlsDisabled}
            onClick={download}
          >
            <Download />
          </Button>
        </div>
      </header>

      {actionError === null ? null : (
        <div
          role="alert"
          className="bg-destructive/5 text-destructive flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11px]"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <button
            type="button"
            aria-label="关闭错误"
            title="关闭"
            onClick={() => setActionError(null)}
            className="hover:text-foreground rounded p-0.5"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 pb-6">
        <main className="relative min-h-0 min-w-0 flex-1">
          <div ref={host} className="absolute inset-0" />
          {loading ? (
            <div className="bg-background/70 text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-xs">
              <div role="status" aria-live="polite" className="text-center">
                <p>正在打开示例…</p>
                {prepareStatus === undefined ? null : (
                  <p className="mt-1 text-[11px]">{prepareStatus}</p>
                )}
              </div>
            </div>
          ) : prepareStatus === undefined ? null : (
            <div className="bg-background/70 absolute inset-0 grid place-items-center p-6">
              <div
                role="status"
                aria-live="polite"
                className="flex max-w-sm flex-col items-center gap-2 text-center"
              >
                <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />
                <p className="text-xs font-medium">{prepareStatus}</p>
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  首次进入仿真要先翻译器件程序并编译一次，之后每帧直接复用编译结果。
                </p>
              </div>
            </div>
          )}
          {loadError === null ? null : (
            <div className="bg-background absolute inset-0 grid place-items-center p-6">
              <div className="max-w-sm text-center">
                <AlertCircle className="text-destructive mx-auto size-5" />
                <p className="text-destructive mt-2 text-xs leading-relaxed">{loadError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  重新加载
                </Button>
              </div>
            </div>
          )}
        </main>
        {session ? (
          <IntegrationPanel
            key={`${documentId}:${reloadKey}`}
            session={session}
            open={panelOpen}
            focusProperties={focusProperties}
            busy={busy}
            perform={perform}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * 等宿主把当前状态真正画到屏幕上。
 *
 * 两帧 rAF 保证第一次回调里的状态更新已经提交并绘制；后台标签页里 rAF 不触发，用定时器
 * 兜底，避免准备流程在不可见的页面上永远挂住。
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(finish));
    globalThis.setTimeout(finish, 100);
  });
}
