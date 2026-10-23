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
  parseCanvas,
  serializeCanvas,
} from '@mica-js/core/canvas';
import {
  createPackageWidgetProvider,
  createWidgetHost,
  loadWidgetPackage,
  type PackageFiles,
  type WidgetAssetProvider,
  type WidgetDefinition,
  type WidgetHost,
  type WidgetProvider,
} from '@mica-js/widget';
import { useCallback, useEffect, useRef, useState } from 'react';
import { layerRows, zForDrop } from '@/canvas/layers';
import { createPaletteInstance, paletteEntries, type PaletteEntry } from '@/canvas/palette';
import { commandErrorMessages } from '@/canvas/panel-model';
import { createCanvasDraft, createDraftStore, createMemoryStorage } from '@/canvas/persist';
import {
  DRAFT_STORAGE_KEY,
  type CanvasDraft,
  type DraftStorage,
  type SaveState,
} from '@/canvas/persist';
import { CanvasInspector } from '@/components/canvas-inspector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Endpoints `demo.cnv` binds; the simulation the scene forwards to is faked with a timer below.
 * The board carries two 4-digit modules, so each one gets its own value.
 */
const DRIVER_TARGETS: readonly {
  readonly target: CanvasBindingTarget;
  readonly value: (tick: number) => string;
}[] = [
  {
    target: { symbol: 'demo-mcu', port: 'display' },
    value: (tick) => (5 + (tick % 50) * 0.01).toFixed(2),
  },
  {
    target: { symbol: 'demo-mcu', port: 'display2' },
    value: (tick) => String(1000 + (tick % 1000)),
  },
];

const PACKAGE_FILES: PackageFiles = {
  label: 'demo',
  read: (path) => fetchBytes(`widgets/${path}`),
};

/** What the save badge says; the draft store reports the state, the page only renders it. */
const SAVE_LABELS: Readonly<Record<SaveState, string>> = {
  clean: '已保存',
  dirty: '未保存',
  failed: '保存失败',
};

const ASSETS: WidgetAssetProvider = {
  resolve: (ref) => fetchBytes(ref.src),
};

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(new URL(path, globalThis.document.baseURI));
  if (!response.ok) {
    throw new Error(`读取 ${path} 失败（HTTP ${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** `localStorage`, or a per-tab fallback when the browser refuses it. */
function draftStorage(): DraftStorage {
  try {
    const storage = globalThis.localStorage;
    storage.getItem(DRAFT_STORAGE_KEY); // Safari throws from the property itself in some modes.
    return storage;
  } catch {
    return createMemoryStorage();
  }
}

/** Hands the serialized document to the browser as a file; there is no workspace to write to. */
function downloadDocument(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  try {
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
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
  const [palette, setPalette] = useState<readonly PaletteEntry[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef<CanvasDraft | null>(null);
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
        // The list comes from `widgets/package.json`, so adding a widget there is enough.
        const demoPackage = await loadWidgetPackage(PACKAGE_FILES);
        const ownedHost = createWidgetHost({
          provider,
          assets: ASSETS,
          onDiagnostic: pushDiagnostic,
          // `WidgetHostOptions.onPublish` takes exactly one callback; the scene fans it out.
          onPublish: (publish) => scene?.receivePublish(publish),
        });
        host = ownedHost;

        const store = createDraftStore(draftStorage());
        const draft = createCanvasDraft({
          store,
          onStateChange: setSaveState,
          onError: (cause) => setSaveError(describeError(cause)),
        });
        draftRef.current = draft;
        const restored = store.read();

        const text = restored ?? new TextDecoder().decode(await fetchBytes('widgets/demo.cnv'));
        const created = await createCanvasScene({
          container,
          document: parseCanvas(text),
          host: ownedHost,
          mode: 'edit',
          theme: DARK_CANVAS_THEME,
          onChange: (next) => {
            setDocument(next);
            setRevision((value) => value + 1);
            draft.record(next);
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
        // The loaded document is the baseline: a fresh page is not "unsaved changes".
        draft.seed(created.document);
        setDocument(created.document);
        setDefinitions(resolved);
        setPalette(paletteEntries(demoPackage.id, demoPackage.modules));
        if (restored !== null) {
          setSaveError(null);
        }
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
      draftRef.current?.destroy();
      draftRef.current = null;
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
      for (const { target, value } of DRIVER_TARGETS) {
        scene.deliver(target, value(tick), tick);
      }
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
  const rows = layerRows(document, definitions);

  /** Adds one palette entry on top of the stack, cascading so clicks do not pile up. */
  const addFromPalette = (entry: PaletteEntry): void => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const current = host.getDocument();
    const messages = applyCommand({
      type: 'add-instance',
      instance: createPaletteInstance(entry, current.widgets.length, crypto.randomUUID()),
      z: current.widgets.length,
    });
    setError(messages.length === 0 ? null : messages.join('；'));
  };

  const exportDocument = (): void => {
    const scene = sceneRef.current;
    if (scene === null) {
      return;
    }
    downloadDocument(serializeCanvas(scene.document), 'demo.cnv');
  };

  /** A list row selects its instance, so the inspector follows the list. */
  const selectLayer = (instanceId: string): void => {
    sceneRef.current?.setSelection([instanceId]);
  };

  /** Dropping a row commits one `set-z`; the list is topmost-first, the document is bottom-first. */
  const dropLayer = (instanceId: string, displayIndex: number): void => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const z = zForDrop(host.getDocument().widgets.length, displayIndex);
    if (z === undefined) {
      return;
    }
    const messages = applyCommand({ type: 'set-z', instanceId, z });
    setError(messages.length === 0 ? null : messages.join('；'));
  };

  /**
   * Drops the stored draft and reloads the sample. `loadDocument` goes through the host, so the
   * scene adopts the fresh snapshot the same way it adopts a command.
   */
  const resetDraft = (): void => {
    const host = hostRef.current;
    const draft = draftRef.current;
    draft?.reset();
    setSaveError(null);
    if (host === null) {
      return;
    }
    void (async () => {
      try {
        const text = new TextDecoder().decode(await fetchBytes('widgets/demo.cnv'));
        await host.loadDocument(parseCanvas(text));
        // The sample is the baseline again, so reloading it does not count as unsaved work.
        draft?.seed(host.getDocument());
      } catch (cause) {
        setError(`重置草稿失败：${describeError(cause)}`);
      }
    })();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        draftRef.current?.flush();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, []);

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
        <Badge variant={saveState === 'failed' ? 'outline' : 'muted'}>
          {SAVE_LABELS[saveState]}
        </Badge>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={!ready || saveState === 'clean'}
            onClick={() => draftRef.current?.flush()}
            title="写入本地草稿（Ctrl+S）"
          >
            保存
          </Button>
          <Button size="xs" variant="ghost" disabled={!ready} onClick={exportDocument}>
            导出
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!ready}
            onClick={resetDraft}
            title="清掉本地草稿并回到示例 .cnv"
          >
            重置草稿
          </Button>
        </div>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {error ?? saveError ?? '编辑模式拖动实例；运行模式点击按键，数码管每秒刷新。'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="bg-card/40 flex w-52 shrink-0 flex-col overflow-y-auto border-r">
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <h2 className="text-xs font-semibold">组件</h2>
            <span className="text-muted-foreground truncate text-[10px]">
              {palette.length} 个 · package.json
            </span>
          </header>
          <ul className="flex flex-col gap-1 p-2">
            {palette.length === 0 ? (
              <li className="text-muted-foreground px-1 text-[11px]">正在读取 widget 包…</li>
            ) : (
              palette.map((entry) => (
                <li key={entry.ref}>
                  <Button
                    size="xs"
                    variant="outline"
                    className="w-full justify-between"
                    disabled={!ready || mode === 'run'}
                    title={`${entry.ref} · ${entry.width}×${entry.height}`}
                    onClick={() => addFromPalette(entry)}
                  >
                    <span className="truncate">{entry.title}</span>
                    <span className="text-muted-foreground ml-2 shrink-0 font-mono text-[10px]">
                      {entry.width}×{entry.height}
                    </span>
                  </Button>
                </li>
              ))
            )}
          </ul>
          <p className="text-muted-foreground px-3 pb-2 text-[10px]">
            点击添加到画布；运行模式不可用。
          </p>

          <header className="flex items-center gap-2 border-y px-3 py-2">
            <h2 className="text-xs font-semibold">图层</h2>
            <span className="text-muted-foreground truncate text-[10px]">
              {rows.length} 个 · 拖动排序
            </span>
          </header>
          <ul className="flex flex-col gap-0.5 p-2" data-layers>
            {rows.length === 0 ? (
              <li className="text-muted-foreground px-1 text-[11px]">画布上没有实例。</li>
            ) : (
              rows.map((row) => {
                const selected = selectedIds.includes(row.id);
                const dragged = dragId === row.id;
                const target = dragId !== null && dropIndex === row.displayIndex && !dragged;
                return (
                  <li
                    key={row.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', row.id);
                      setDragId(row.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropIndex(null);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (dropIndex !== row.displayIndex) {
                        setDropIndex(row.displayIndex);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedId = dragId ?? event.dataTransfer.getData('text/plain');
                      setDragId(null);
                      setDropIndex(null);
                      if (draggedId.length > 0) {
                        dropLayer(draggedId, row.displayIndex);
                      }
                    }}
                    onClick={() => selectLayer(row.id)}
                    title={`${row.id} · z ${row.z}`}
                    className={cn(
                      'flex cursor-grab items-center gap-1 rounded border px-1.5 py-1 text-[11px] select-none',
                      selected
                        ? 'border-sky-500/60 bg-sky-500/10'
                        : 'hover:bg-accent/40 border-transparent',
                      dragged && 'opacity-40',
                      target && 'border-sky-400 border-dashed',
                    )}
                  >
                    <span className="truncate">{row.title}</span>
                    <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                      z{row.z}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
          <p className="text-muted-foreground px-3 pb-2 text-[10px]">
            列表自上而下是绘制顺序；拖动即发一条 `set-z`。
          </p>
        </aside>

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
