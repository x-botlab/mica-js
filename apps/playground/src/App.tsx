import type { CanvasDocument } from '@mica-js/document/canvas';
import type { SchematicDocument } from '@mica-js/document/schematic';
import {
  AlertCircle,
  Download,
  LocateFixed,
  Maximize,
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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createCanvasEditor,
  createSchematicEditor,
  type ICanvasEditor,
  type ISchematicEditor,
} from '@mica-js/editor';
import '@mica-js/editor/style.css';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  demoDeviceLibrary,
  demoFileSystem,
  demoFileName,
  demoWidgetLibrary,
  loadDemoDocument,
  serializeDemoSnapshot,
  type DemoDocumentKind,
  type DemoSnapshot,
} from '@/runtime-demo';

type EditorInstance = ISchematicEditor | ICanvasEditor;

interface CanvasStatus {
  readonly mode: 'edit' | 'simulation';
  readonly running: boolean;
  readonly simTime: number;
}

const DOCUMENT_LABELS: Readonly<Record<DemoDocumentKind, string>> = {
  canvas: '画布 · example.cnv',
  schematic: '原理图 · example.sch',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCanvasStatus(value: unknown): CanvasStatus {
  if (typeof value !== 'object' || value === null) {
    throw new Error('画布状态不可用。');
  }
  const { mode, running, simTime } = value as Record<string, unknown>;
  if (
    (mode !== 'edit' && mode !== 'simulation') ||
    typeof running !== 'boolean' ||
    typeof simTime !== 'number'
  ) {
    throw new Error('画布状态不可用。');
  }
  return { mode, running, simTime };
}

function formatSimTime(value: number): string {
  const milliseconds = value / 1e9;
  return `${milliseconds >= 100 ? milliseconds.toFixed(0) : milliseconds.toFixed(1)} ms`;
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorInstance | undefined>(undefined);
  const latest = useRef<DemoSnapshot | undefined>(undefined);
  const [kind, setKind] = useState<DemoDocumentKind>('canvas');
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<CanvasStatus | null>(null);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    let cancelled = false;
    let instance: EditorInstance | undefined;
    let unsubscribe: (() => void) | undefined;
    const mount = document.createElement('div');
    mount.className = 'absolute inset-0';
    container.append(mount);
    editor.current = undefined;
    latest.current = undefined;
    setLoading(true);
    setReady(false);
    setBusy(false);
    setStatus(null);
    setLoadError(null);
    setActionError(null);

    const start = async (): Promise<void> => {
      try {
        const loaded = await loadDemoDocument(kind);
        if (cancelled) return;
        latest.current = loaded.snapshot;
        const created =
          kind === 'canvas'
            ? await createCanvasEditor({
                container: mount,
                uri: loaded.uri,
                fileSystem: demoFileSystem,
                deviceLibrary: demoDeviceLibrary,
                widgetLibrary: demoWidgetLibrary,
              })
            : await createSchematicEditor({
                container: mount,
                uri: loaded.uri,
                fileSystem: demoFileSystem,
                deviceLibrary: demoDeviceLibrary,
              });
        if (cancelled) {
          await created.dispose();
          return;
        }
        instance = created;
        editor.current = created;
        const subscription = created.onDidChangeContent((content) => {
          latest.current =
            kind === 'canvas'
              ? { kind, document: content as CanvasDocument }
              : { kind, document: content as SchematicDocument };
        });
        unsubscribe = () => subscription.dispose();
        setReady(true);
        setLoading(false);
        if (kind === 'canvas') {
          try {
            setStatus(readCanvasStatus(await created.executeCommand('canvas.status')));
          } catch (cause) {
            if (!cancelled) setActionError(errorMessage(cause));
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadError(errorMessage(cause));
          setLoading(false);
        }
      }
    };
    void start();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (editor.current === instance) {
        editor.current = undefined;
      }
      latest.current = undefined;
      mount.remove();
      if (instance !== undefined) {
        void instance.dispose().catch(() => undefined);
      }
    };
  }, [kind, reloadKey]);

  useEffect(() => {
    if (kind !== 'canvas' || !ready) return;
    let stopped = false;
    let pending = false;
    const update = async (): Promise<void> => {
      const current = editor.current as ICanvasEditor | undefined;
      if (pending || current === undefined) return;
      pending = true;
      try {
        const next = readCanvasStatus(await current.executeCommand('canvas.status'));
        if (!stopped && editor.current === current) setStatus(next);
      } catch {
        // A switch disposes the editor mid-flight; the mount effect owns fatal errors.
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = globalThis.setInterval(() => void update(), 250);
    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [kind, ready, reloadKey]);

  const readStatus = useCallback(async (current: ICanvasEditor): Promise<void> => {
    try {
      const next = readCanvasStatus(await current.executeCommand('canvas.status'));
      if (editor.current === current) setStatus(next);
    } catch {
      // The next command or the polling effect reports a real failure.
    }
  }, []);

  const runCommand = useCallback(
    (id: string, ...args: readonly unknown[]): void => {
      const current = editor.current;
      if (current === undefined) return;
      setBusy(true);
      void (async () => {
        try {
          await current.executeCommand(id, ...args);
          if (editor.current !== current) return;
          setActionError(null);
          if (kind === 'canvas') {
            await readStatus(current as ICanvasEditor);
          }
        } catch (cause) {
          if (editor.current === current) setActionError(errorMessage(cause));
        } finally {
          if (editor.current === current) setBusy(false);
        }
      })();
    },
    [kind, readStatus],
  );

  const setCanvasMode = useCallback(
    (mode: 'edit' | 'simulation'): void => {
      const current = editor.current as ICanvasEditor | undefined;
      if (current === undefined) return;
      setBusy(true);
      void (async () => {
        try {
          await current.executeCommand('canvas.setMode', mode);
          if (editor.current !== current) return;
          await readStatus(current);
          setActionError(null);
        } catch (cause) {
          if (editor.current === current) setActionError(errorMessage(cause));
        } finally {
          if (editor.current === current) setBusy(false);
        }
      })();
    },
    [readStatus],
  );

  const download = useCallback((): void => {
    const snapshot = latest.current;
    if (snapshot === undefined) return;
    try {
      const url = URL.createObjectURL(
        new Blob([serializeDemoSnapshot(snapshot)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = demoFileName(snapshot);
      document.body.append(link);
      link.click();
      link.remove();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }, []);

  const controlsDisabled = !ready || busy;
  const simulationMode = kind === 'canvas' && status?.mode === 'simulation';
  const simulationActionsDisabled = controlsDisabled || !simulationMode;
  const canEdit = !controlsDisabled && (kind !== 'canvas' || status?.mode === 'edit');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b px-3">
        <span className="bg-primary text-primary-foreground grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold">
          M
        </span>
        <select
          aria-label="示例文档"
          value={kind}
          disabled={busy}
          onChange={(event) => setKind(event.target.value as DemoDocumentKind)}
          className="border-input bg-background focus-visible:ring-ring/50 h-7 shrink-0 rounded-md border px-2 text-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
        >
          {(Object.keys(DOCUMENT_LABELS) as DemoDocumentKind[]).map((candidate) => (
            <option key={candidate} value={candidate}>
              {DOCUMENT_LABELS[candidate]}
            </option>
          ))}
        </select>

        {kind === 'canvas' ? (
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
            {kind === 'schematic'
              ? '原理图'
              : status === null
                ? '—'
                : status.mode === 'edit'
                  ? '编辑'
                  : status.running
                    ? `运行中 · ${formatSimTime(status.simTime)}`
                    : `已暂停 · ${formatSimTime(status.simTime)}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="撤销"
            aria-label="撤销"
            disabled={!canEdit}
            onClick={() => runCommand(kind === 'canvas' ? 'canvas.undo' : 'schematic.undo')}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="重做"
            aria-label="重做"
            disabled={!canEdit}
            onClick={() => runCommand(kind === 'canvas' ? 'canvas.redo' : 'schematic.redo')}
          >
            <Redo2 />
          </Button>

          {kind === 'canvas' ? (
            <>
              <span className="bg-border mx-1 h-4 w-px" aria-hidden />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="缩小视图"
                aria-label="缩小视图"
                disabled={controlsDisabled}
                onClick={() => runCommand('canvas.zoomOut')}
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
                onClick={() => runCommand('canvas.zoomIn')}
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
                onClick={() => runCommand('canvas.fitView')}
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
                onClick={() => runCommand('canvas.resetView')}
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
                onClick={() => runCommand('canvas.run')}
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
                onClick={() => runCommand('canvas.pause')}
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
                onClick={() => runCommand('canvas.step')}
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
                onClick={() => runCommand('canvas.reset')}
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

      <main className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {loading ? (
          <div className="bg-background/70 text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-xs">
            正在打开示例…
          </div>
        ) : null}
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
    </div>
  );
}
