import {
  createCanvasScene,
  DARK_CANVAS_THEME,
  type CanvasMode,
  type CanvasScene,
} from '@mica-js/canvas-editor';
import { timePs } from '@mica-js/core';
import {
  type CanvasCommand,
  type CanvasDocument,
  parseCanvas,
  serializeCanvas,
} from '@mica-js/core/canvas';
import { parseSchematic } from '@mica-js/core/schematic';
import { parseDeviceDescription, type IDeviceProvider } from '@mica-js/device';
import {
  createCircuitHost,
  createDeviceSimExecutor,
  type DeviceSimExecutor,
} from '@mica-js/simulator';
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
import { commandErrorMessages, describeTarget, type TopicCandidate } from '@/canvas/panel-model';
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

/** Device package the canvas demo runs: `demo:<name>` resolves to `devices/<name>.json` + `.js`. */
const DEVICE_PACKAGE = 'demo';
/** Virtual time one run-mode tick advances; equals the demo device's own period (0.1 s). */
const DRIVER_STEP_PS = timePs(100_000_000_000);
const DRIVER_INTERVAL_MS = 100;

/**
 * Device source for the demo schematic. The provider owns id resolution and file layout; the
 * simulator only asks for `demo:<name>`.
 */
const DEVICES: IDeviceProvider = {
  async resolve(deviceId) {
    const separator = deviceId.indexOf(':');
    const name = separator < 0 ? '' : deviceId.slice(separator + 1);
    if (deviceId.slice(0, separator) !== DEVICE_PACKAGE || name.length === 0) {
      return undefined;
    }
    const [description, code] = await Promise.all([
      fetchBytes(`devices/${name}.json`),
      fetchBytes(`devices/${name}.js`),
    ]);
    const raw: unknown = JSON.parse(new TextDecoder().decode(description));
    return {
      definition: parseDeviceDescription(raw as Readonly<Record<string, unknown>>, {
        name: deviceId,
      }),
      code: new TextDecoder().decode(code),
    };
  },
};

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
  /** `'widget'` is widget → device, `'device'` is device → widgets. */
  readonly direction: 'widget' | 'device';
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
  const executorRef = useRef<DeviceSimExecutor | null>(null);
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
  const [topics, setTopics] = useState<readonly TopicCandidate[]>([]);
  /** Same list for the publish log, which is written from callbacks that must stay stable. */
  const topicsRef = useRef<readonly TopicCandidate[]>([]);
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

  const pushDiagnostic = useCallback(
    (diagnostic: { readonly code: string; readonly message: string }) => {
      setDiagnostics((entries) =>
        [{ id: nextId(), code: diagnostic.code, message: diagnostic.message }, ...entries].slice(
          0,
          40,
        ),
      );
    },
    [],
  );

  /** One log row per publish, whichever direction it travelled; labels use designators. */
  const recordPublish = useCallback(
    (
      direction: 'widget' | 'device',
      target: { readonly symbol: string; readonly port: string },
      payload: unknown,
      simTime: number,
    ) => {
      const designator = describeTarget(target, topicsRef.current);
      setPublishes((entries) =>
        [
          {
            id: nextId(),
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            direction,
            endpoint: designator,
            payload: describePayload(payload),
            simTime,
          },
          ...entries,
        ].slice(0, 40),
      );
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let cancelled = false;
    let host: WidgetHost | undefined;
    let scene: CanvasScene | undefined;
    let executor: DeviceSimExecutor | undefined;

    const start = async (): Promise<void> => {
      try {
        const provider = await createPackageWidgetProvider({ files: PACKAGE_FILES });
        // The list comes from `widgets/package.json`, so adding a widget there is enough.
        const demoPackage = await loadWidgetPackage(PACKAGE_FILES);
        const ownedExecutor = createDeviceSimExecutor({
          devices: DEVICES,
          // The sheet's wires are the circuit: `createCircuitHost` derives the nets per runtime.
          host: createCircuitHost(),
          onDiagnostic: pushDiagnostic,
        });
        executor = ownedExecutor;
        const ownedHost = createWidgetHost({
          provider,
          assets: ASSETS,
          // The host routes publishes both ways; no forwarding code lives in this page.
          simulation: ownedExecutor,
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
          recordPublish('widget', target, payload, simTime);
        });
        // Device publishes never enter the scene (the host routes them straight to the widgets),
        // so the log listens on the executor for the other direction.
        ownedExecutor.onPublish(({ target, payload, simTime }) => {
          recordPublish('device', target, payload, simTime);
        });

        const resolved = await resolveDefinitions(provider, created.getDocument());
        // The canvas names its schematic; without one the demo runs without a simulation.
        const schematicPath = created.getDocument().schematic;
        if (schematicPath !== undefined) {
          try {
            const schematicText = new TextDecoder().decode(await fetchBytes(schematicPath));
            await ownedExecutor.loadSchematic(parseSchematic(schematicText));
            topicsRef.current = ownedExecutor.getTopics();
            setTopics(topicsRef.current);
          } catch (cause) {
            // A broken schematic must not blank the canvas: report it and keep editing.
            pushDiagnostic({
              code: 'simulator/load-failed',
              message: `原理图 ${schematicPath} 加载失败：${describeError(cause)}`,
            });
          }
        }

        if (cancelled) {
          // The effect was torn down mid-startup; release what this attempt already created.
          created.destroy();
          ownedExecutor.dispose();
          void ownedHost.dispose();
          return;
        }

        scene = created;
        sceneRef.current = created;
        hostRef.current = ownedHost;
        executorRef.current = ownedExecutor;
        // The loaded document is the baseline: a fresh page is not "unsaved changes".
        draft.seed(created.getDocument());
        setDocument(created.getDocument());
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
            micaSimulator: ownedExecutor,
            micaProvider: provider,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause));
          setResolving(false);
          // Nothing will mount over this host; release its sandbox instead of leaking it.
          executor?.dispose();
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
      executorRef.current = null;
      // The playground owns the host, so it is the one that terminates the sandbox.
      executor?.dispose();
      void host?.dispose();
      executor = undefined;
      host = undefined;
    };
  }, [pushDiagnostic, recordPublish]);

  useEffect(() => {
    if (!ready || mode !== 'run') {
      return;
    }
    const executor = executorRef.current;
    if (executor === null || executor.getState() !== 'ready') {
      return;
    }
    driverActive.current = true;
    const drive = (): void => {
      if (!driverActive.current) {
        return;
      }
      try {
        executor.advance(DRIVER_STEP_PS);
      } catch (cause) {
        // The executor is 'faulted' now; stop feeding it and surface the failure.
        driverActive.current = false;
        setError(`仿真推进失败：${describeError(cause)}`);
      }
    };
    // One step right away, so the displays light up instead of waiting for the first interval.
    drive();
    const timer = globalThis.setInterval(drive, DRIVER_INTERVAL_MS);
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
      // The widgets were rebuilt, so the simulation restarts from t = 0 as well: both sides of the
      // bridge always describe the same run. `reset()` is synchronous, so the mode switch still
      // resolves in one go.
      executorRef.current?.reset();
      setMode(scene.getMode());
    } catch (cause) {
      setMode(scene.getMode());
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
    downloadDocument(serializeCanvas(scene.getDocument()), 'demo.cnv');
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
          {error ?? saveError ?? '编辑模式拖动实例；运行模式点一下按键，计数器加一。'}
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
            targets={topics}
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
              <span className="text-muted-foreground text-[10px]">→ widget · ← 器件</span>
            </header>
            <ul className="max-h-48 overflow-y-auto p-2 font-mono text-[11px]">
              {publishes.length === 0 ? (
                <li className="text-muted-foreground px-1 font-sans">运行模式下点击按键试试。</li>
              ) : (
                publishes.map((entry) => (
                  <li key={entry.id} className="flex gap-2 border-b py-1 last:border-b-0">
                    <span className="text-muted-foreground shrink-0">{entry.time}</span>
                    <span className="shrink-0 text-sky-400">
                      {entry.direction === 'widget' ? '→' : '←'} {entry.endpoint}
                    </span>
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
