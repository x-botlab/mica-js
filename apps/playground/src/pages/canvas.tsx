import {
  createCanvasScene,
  DARK_CANVAS_THEME,
  type CanvasMode,
  type CanvasScene,
  type CanvasSceneDiagnostic,
} from '@mica-js/canvas-editor';
import {
  type CanvasBindingTarget,
  type CanvasCommand,
  type CanvasDocument,
} from '@mica-js/core/canvas';
import {
  createPackageWidgetProvider,
  createWidgetHost,
  type PackageFiles,
  type WidgetAssetSource,
  type WidgetDefinition,
  type WidgetHost,
  type WidgetProvider,
} from '@mica-js/widget';
import { useCallback, useEffect, useRef, useState } from 'react';
import { commandErrorMessages } from '@/canvas/panel-model';
import { CanvasInspector } from '@/components/canvas-inspector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** Endpoint `demo.cnv` binds; the simulation the scene forwards to is faked with a timer below. */
const DRIVER_TARGET: CanvasBindingTarget = { symbol: 'demo-mcu', port: 'display' };

const PACKAGE_FILES: PackageFiles = {
  label: 'demo',
  read: (path) => fetchBytes(`widgets/${path}`),
};

const ASSETS: WidgetAssetSource = {
  read: (ref) => fetchBytes(ref.src),
};

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(new URL(path, globalThis.document.baseURI));
  if (!response.ok) {
    throw new Error(`读取 ${path} 失败（HTTP ${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

interface DiagnosticEntry {
  readonly id: number;
  readonly code: string;
  readonly message: string;
}

interface PublishEntry {
  readonly id: number;
  readonly time: string;
  readonly endpoint: string;
  readonly payload: string;
  readonly simTime: number;
}

function nextId(): number {
  return Date.now() + Math.random();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    return String(payload);
  }
}

/** Definitions of every widget the document references; the demo package never changes. */
async function resolveDefinitions(
  provider: WidgetProvider,
  document: CanvasDocument,
): Promise<ReadonlyMap<string, WidgetDefinition>> {
  const definitions = new Map<string, WidgetDefinition>();
  for (const ref of new Set(document.widgets.map((widget) => widget.widget))) {
    const module = await provider.resolve(ref);
    if (module !== undefined) {
      definitions.set(ref, module.definition);
    }
  }
  return definitions;
}

export function CanvasPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CanvasScene | null>(null);
  const hostRef = useRef<WidgetHost | null>(null);
  /** Lets a mode switch stop the driver before the instances it feeds are dropped. */
  const driverActive = useRef(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<CanvasMode>('edit');
  const [switching, setSwitching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [definitions, setDefinitions] = useState<ReadonlyMap<string, WidgetDefinition>>(
    () => new Map(),
  );
  const [resolving, setResolving] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly DiagnosticEntry[]>([]);
  const [publishes, setPublishes] = useState<readonly PublishEntry[]>([]);

  const pushDiagnostic = useCallback((diagnostic: CanvasSceneDiagnostic) => {
    setDiagnostics((entries) =>
      [{ id: nextId(), code: diagnostic.code, message: diagnostic.message }, ...entries].slice(
        0,
        40,
      ),
    );
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let cancelled = false;
    let host: WidgetHost | undefined;
    let scene: CanvasScene | undefined;

    const start = async (): Promise<void> => {
      try {
        const provider = await createPackageWidgetProvider({ files: PACKAGE_FILES });
        const ownedHost = createWidgetHost({
          provider,
          assets: ASSETS,
          onDiagnostic: pushDiagnostic,
          // `WidgetHostOptions.onPublish` takes exactly one callback; the scene fans it out.
          onPublish: (publish) => scene?.receivePublish(publish),
        });
        host = ownedHost;
        const text = new TextDecoder().decode(await fetchBytes('widgets/demo.cnv'));
        const created = await createCanvasScene({
          container,
          document: text,
          host: ownedHost,
          mode: 'edit',
          theme: DARK_CANVAS_THEME,
          onChange: (next) => {
            setDocument(next);
            setRevision((value) => value + 1);
          },
          onSelectionChange: (ids) => setSelectedIds(ids),
          onDiagnostic: pushDiagnostic,
        });
        created.onPublish((target, payload, simTime) => {
          setPublishes((entries) =>
            [
              {
                id: nextId(),
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                endpoint: `${target.symbol}.${target.port}`,
                payload: describePayload(payload),
                simTime,
              },
              ...entries,
            ].slice(0, 40),
          );
        });

        const resolved = await resolveDefinitions(provider, created.document);
        if (cancelled) {
          // The effect was torn down mid-startup; release what this attempt already created.
          created.destroy();
          void ownedHost.dispose();
          return;
        }

        scene = created;
        sceneRef.current = created;
        hostRef.current = ownedHost;
        setDocument(created.document);
        setDefinitions(resolved);
        setResolving(false);
        setReady(true);
        if (import.meta.env.DEV) {
          // Console handles for poking at the mounted scene while developing the playground.
          Object.assign(globalThis, {
            micaCanvas: created,
            micaWidgetHost: ownedHost,
            micaProvider: provider,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause));
          setResolving(false);
          // Nothing will mount over this host; release its sandbox instead of leaking it.
          void host?.dispose();
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      scene?.destroy();
      scene = undefined;
      sceneRef.current = null;
      hostRef.current = null;
      // The playground owns the host, so it is the one that terminates the sandbox.
      void host?.dispose();
      host = undefined;
    };
  }, [pushDiagnostic]);

  useEffect(() => {
    if (!ready || mode !== 'run') {
      return;
    }
    const scene = sceneRef.current;
    if (scene === null) {
      return;
    }
    driverActive.current = true;
    let tick = 0;
    const drive = (): void => {
      if (!driverActive.current) {
        return;
      }
      tick += 1;
      scene.deliver(DRIVER_TARGET, (1000 + (tick % 1000) * 0.37).toFixed(3), tick);
    };
    // One value right away, so the display lights up instead of waiting for the first second.
    drive();
    const timer = globalThis.setInterval(drive, 1000);
    return () => {
      driverActive.current = false;
      globalThis.clearInterval(timer);
    };
  }, [mode, ready]);

  /** Host-side command entry point for the inspector; the scene adopts the snapshot from there. */
  const applyCommand = useCallback(
    (command: CanvasCommand): readonly string[] => {
      const host = hostRef.current;
      if (host === null) {
        return ['宿主尚未就绪。'];
      }
      try {
        host.applyCommand(command);
        return [];
      } catch (cause) {
        // `SchematicError.diagnostics` carries every problem; show them all under the control.
        const messages = commandErrorMessages(cause);
        for (const message of messages) {
          pushDiagnostic({ code: 'canvas-scene/command-failed', message });
        }
        return messages;
      }
    },
    [pushDiagnostic],
  );

  /**
   * Switching mode rebuilds every widget, so it is awaited and locked: a second click while the
   * remount runs would queue another reset for nothing.
   */
  const switchMode = async (next: CanvasMode): Promise<void> => {
    const scene = sceneRef.current;
    if (scene === null || switching || next === mode) {
      return;
    }
    // Stop feeding instances that are about to be dropped, or the host reports them as missing.
    driverActive.current = false;
    setSwitching(true);
    setError(null);
    try {
      await scene.setMode(next);
      setMode(scene.mode);
    } catch (cause) {
      setMode(scene.mode);
      setError(`切换到${next === 'run' ? '运行' : '编辑'}模式失败：${describeError(cause)}`);
    } finally {
      setSwitching(false);
    }
  };

  const selectedInstance = document?.widgets.find((widget) => widget.id === selectedIds[0]);
  const selectedDefinition =
    selectedInstance === undefined ? undefined : definitions.get(selectedInstance.widget);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          {(['edit', 'run'] as const).map((candidate) => (
            <Button
              key={candidate}
              size="xs"
              variant={mode === candidate ? 'default' : 'outline'}
              disabled={!ready || switching}
              onClick={() => void switchMode(candidate)}
            >
              {switching && mode !== candidate ? '重置中…' : candidate === 'edit' ? '编辑' : '运行'}
            </Button>
          ))}
        </div>
        <Badge variant="muted">selected {selectedIds.length}</Badge>
        <Badge variant={diagnostics.length === 0 ? 'muted' : 'outline'}>
          诊断 {diagnostics.length}
        </Badge>
        <Badge variant="muted">rev {revision}</Badge>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {error ?? '编辑模式拖动实例；运行模式点击按键，数码管每秒刷新。'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div ref={containerRef} className="absolute inset-0" />
          {ready ? null : (
            <div className="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-[11px]">
              {error === null ? '加载 widget 包与示例 .cnv…' : null}
            </div>
          )}
        </div>

        <aside className="bg-card/40 flex w-72 shrink-0 flex-col overflow-y-auto border-l">
          <CanvasInspector
            mode={mode}
            instance={selectedInstance}
            definition={selectedDefinition}
            resolving={resolving}
            revision={revision}
            onApply={applyCommand}
          />

          <section className="flex flex-col border-t">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="text-xs font-semibold">诊断</h2>
              <span className="text-muted-foreground text-[10px]">onDiagnostic</span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setDiagnostics([]);
                  setPublishes([]);
                }}
              >
                清空
              </Button>
            </header>
            <ul className="max-h-48 overflow-y-auto p-2 text-[11px]">
              {diagnostics.length === 0 ? (
                <li className="text-muted-foreground px-1">没有诊断。</li>
              ) : (
                diagnostics.map((entry) => (
                  <li key={entry.id} className="border-b py-1 last:border-b-0">
                    <span className="font-mono text-[10px] text-amber-500">{entry.code}</span>
                    <p className="text-muted-foreground break-words">{entry.message}</p>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="flex flex-col border-t">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="text-xs font-semibold">发布日志</h2>
              <span className="text-muted-foreground text-[10px]">scene.onPublish</span>
            </header>
            <ul className="max-h-48 overflow-y-auto p-2 font-mono text-[11px]">
              {publishes.length === 0 ? (
                <li className="text-muted-foreground px-1 font-sans">运行模式下点击按键试试。</li>
              ) : (
                publishes.map((entry) => (
                  <li key={entry.id} className="flex gap-2 border-b py-1 last:border-b-0">
                    <span className="text-muted-foreground shrink-0">{entry.time}</span>
                    <span className="shrink-0 text-sky-400">{entry.endpoint}</span>
                    <span className="text-foreground break-all">{entry.payload}</span>
                    <span className="text-muted-foreground ml-auto shrink-0">
                      t={entry.simTime}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
