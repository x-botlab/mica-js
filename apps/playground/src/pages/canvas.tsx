import {
  createCanvasEditor,
  DARK_CANVAS_THEME,
  deviceSimulationGuest,
  SandboxHostProvider,
  type CanvasEditor,
  type CanvasMode,
  widgetGuest,
} from '@mica-js/canvas-editor';
import { type CanvasCommand, type CanvasDocument, parseCanvas } from '@mica-js/core/canvas';
import {
  createPackageWidgetProvider,
  createWidgetHostGuestSandbox,
  loadWidgetPackage,
  type PackageFiles,
  type WidgetDefinition,
  type WidgetProvider,
} from '@mica-js/widget';
import DeviceSimulationHostGuestSandbox from '@/sim/device-simulation-host.sandbox.ts?sandbox-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { layerRows, zForDrop } from '@/canvas/layers';
import { createPaletteInstance, paletteEntries, type PaletteEntry } from '@/canvas/palette';
import { commandErrorMessages, type TopicCandidate } from '@/canvas/panel-model';
import { createCanvasDraft, createDraftStore, createMemoryStorage } from '@/canvas/persist';
import {
  DRAFT_STORAGE_KEY,
  type CanvasDraft,
  type DraftStorage,
  type SaveState,
} from '@/canvas/persist';
import { CanvasInspector } from '@/components/canvas-inspector';
import { Button } from '@/components/ui/button';
import {
  canvasExampleById,
  schematicExampleById,
  schematicRoute,
  type CanvasExampleId,
} from '@/examples/registry';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';

const PACKAGE_FILES: PackageFiles = {
  label: 'demo',
  read: (path) => fetchBytes(`widgets/${path}`),
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Definitions of every widget the document references; the demo package never changes. */
async function resolveDefinitions(
  provider: WidgetProvider,
  document: CanvasDocument,
): Promise<Map<string, WidgetDefinition>> {
  const definitions = new Map<string, WidgetDefinition>();
  for (const ref of new Set(document.widgets.map((widget) => widget.widget))) {
    const module = await provider.resolve(ref);
    if (module !== undefined) {
      definitions.set(ref, module.definition);
    }
  }
  return definitions;
}

export interface CanvasPageProps {
  /** Canvas document this sidebar entry opens; the route decided it before the page mounted. */
  readonly exampleId: CanvasExampleId;
}

export function CanvasPage({ exampleId }: CanvasPageProps) {
  const example = canvasExampleById(exampleId);
  const schematicExample = schematicExampleById(example.schematic);
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CanvasEditor | null>(null);
  const widgetTitles = useRef(new Map<string, string>());
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
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [topics, setTopics] = useState<readonly TopicCandidate[]>([]);

  useEffect(() => {
    const titles = new Map<string, string>();
    for (const widget of document?.widgets ?? []) {
      titles.set(widget.id, definitions.get(widget.widget)?.displayName ?? widget.widget);
    }
    widgetTitles.current = titles;
  }, [document, definitions]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let cancelled = false;
    let hostProvider: SandboxHostProvider | undefined;
    let scene: CanvasEditor | undefined;
    // Switching examples rebuilds the scene in edit mode; drop the previous run's UI state.
    setMode('edit');
    setReady(false);
    setResolving(true);
    setSelectedIds([]);
    setFatalError(null);
    setError(null);
    setSaveError(null);

    const start = async (): Promise<void> => {
      try {
        const provider = await createPackageWidgetProvider({ files: PACKAGE_FILES });
        // The list comes from `widgets/package.json`, so adding a widget there is enough.
        const demoPackage = await loadWidgetPackage(PACKAGE_FILES);
        const providerInstance = new SandboxHostProvider({
          // Only the device guest is app-specific: the Playground owns its device library. The
          // widget guest comes from `@mica-js/widget`, which inlines it into its own entry.
          getSandboxWorker: (label) => {
            if (label === deviceSimulationGuest) {
              return new DeviceSimulationHostGuestSandbox({
                name: `playground-${label}`,
                container,
              });
            }
            if (label === widgetGuest) {
              return createWidgetHostGuestSandbox({ name: `playground-${label}`, container });
            }
            throw new Error(`Unknown sandbox label: ${label}`);
          },
          fs: {
            read: (uri) => fetchBytes(uri),
          },
          widgetProvider: provider,
        });
        hostProvider = providerInstance;

        // The draft key carries the example id: two canvases on one origin never share a draft.
        const store = createDraftStore(draftStorage(), `${DRAFT_STORAGE_KEY}:${example.id}`);
        const draft = createCanvasDraft({
          store,
          onStateChange: setSaveState,
          onError: (cause) => setSaveError(describeError(cause)),
        });
        draftRef.current = draft;
        const restored = store.read();

        const text = restored ?? new TextDecoder().decode(await fetchBytes(example.document));
        const created = await createCanvasEditor({
          container,
          document: parseCanvas(text),
          hostProvider: providerInstance,
          mode: 'edit',
          theme: DARK_CANVAS_THEME,
          onChange: (next) => {
            setDocument(next);
            setRevision((value) => value + 1);
            draft.record(next);
          },
          onSelectionChange: (ids) => setSelectedIds(ids),
        });
        const resolved = await resolveDefinitions(provider, created.getDocument());
        // The palette can add any widget declared by the package, so keep definitions for all
        // palette entries available even when the initial document does not reference them.
        for (const [widgetId, module] of Object.entries(demoPackage.modules)) {
          resolved.set(`${demoPackage.id}:${widgetId}`, module.definition);
        }
        const bindingTargets = await created.getBindingTargets();

        if (cancelled) {
          // The effect was torn down mid-startup; release what this attempt already created.
          await created.dispose();
          return;
        }

        scene = created;
        sceneRef.current = created;
        // The loaded document is the baseline: a fresh page is not "unsaved changes".
        draft.seed(created.getDocument());
        setDocument(created.getDocument());
        setDefinitions(resolved);
        setTopics(bindingTargets);
        setPalette(paletteEntries(demoPackage.id, demoPackage.modules));
        if (restored !== null) {
          setSaveError(null);
        }
        setResolving(false);
        setReady(true);
        if (import.meta.env.DEV) {
          // Console handle for poking at the mounted scene while developing the playground.
          Object.assign(globalThis, { micaCanvas: created });
        }
      } catch (cause) {
        if (!cancelled) {
          const message = describeError(cause);
          setFatalError(message);
          setError(message);
          setResolving(false);
          // Nothing will mount over this host; release its sandboxes instead of leaking them.
          void hostProvider?.dispose();
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      draftRef.current?.destroy();
      draftRef.current = null;
      const activeScene = scene ?? sceneRef.current;
      if (activeScene === undefined || activeScene === null) {
        void hostProvider?.dispose();
      } else {
        void activeScene.dispose();
      }
      scene = undefined;
      sceneRef.current = null;
      hostProvider = undefined;
      if (import.meta.env.DEV) {
        delete (globalThis as { micaCanvas?: unknown }).micaCanvas;
      }
    };
  }, [example]);

  /** Editor command entry point for the inspector; the editor adopts the committed snapshot. */
  const applyCommand = useCallback((command: CanvasCommand): readonly string[] => {
    const editor = sceneRef.current;
    if (editor === null) {
      return ['画布尚未就绪。'];
    }
    try {
      editor.applyCommand(command);
      return [];
    } catch (cause) {
      // `SchematicError.diagnostics` carries every problem; the inspector shows them all.
      return commandErrorMessages(cause);
    }
  }, []);

  /**
   * Switching mode rebuilds every widget, so it is awaited and locked: a second click while the
   * remount runs would queue another reset for nothing.
   */
  const switchMode = async (next: CanvasMode): Promise<void> => {
    const scene = sceneRef.current;
    if (scene === null || switching || next === mode) {
      return;
    }
    setSwitching(true);
    setError(null);
    // Every instance is rebuilt and the devices reset, so the simulation starts from a clean run.
    try {
      await scene.setMode(next);
      // The widgets were rebuilt, so the simulation restarts from t = 0 as well: both sides of the
      // bridge always describe the same run.
      setMode(scene.getMode());
    } catch (cause) {
      setMode(scene.getMode());
      setError(`切换到${next === 'simulation' ? '仿真' : '编辑'}模式失败：${describeError(cause)}`);
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
    const editor = sceneRef.current;
    if (editor === null) {
      return;
    }
    const current = editor.getDocument();
    const messages = applyCommand({
      type: 'add-instance',
      instance: createPaletteInstance(entry, current.widgets.length, crypto.randomUUID()),
      z: current.widgets.length,
    });
    setError(messages.length === 0 ? null : messages.join('；'));
  };

  /** A list row selects its instance, so the inspector follows the list. */
  const selectLayer = (instanceId: string): void => {
    sceneRef.current?.setSelection([instanceId]);
  };

  /** Dropping a row commits one `set-z`; the list is topmost-first, the document is bottom-first. */
  const dropLayer = (instanceId: string, displayIndex: number): void => {
    const editor = sceneRef.current;
    if (editor === null) {
      return;
    }
    const z = zForDrop(editor.getDocument().widgets.length, displayIndex);
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
    const editor = sceneRef.current;
    const draft = draftRef.current;
    draft?.reset();
    setSaveError(null);
    if (editor === null) {
      return;
    }
    void (async () => {
      try {
        const text = new TextDecoder().decode(await fetchBytes(example.document));
        await editor.loadDocument(parseCanvas(text));
        // The sample is the baseline again, so reloading it does not count as unsaved work.
        draft?.seed(editor.getDocument());
      } catch (cause) {
        setError(`重置失败：${describeError(cause)}`);
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
    <div className="relative flex h-full min-h-0 flex-col">
      {fatalError === null ? null : (
        <div
          className="bg-background/80 fixed inset-0 z-50 grid place-items-center p-6 backdrop-blur-sm"
          role="presentation"
        >
          <div
            className="bg-card w-full max-w-xl rounded-lg border p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="canvas-fatal-error-title"
          >
            <h2 id="canvas-fatal-error-title" className="text-lg font-semibold text-red-400">
              画布加载失败
            </h2>
            <pre className="bg-muted/40 mt-4 max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
              {fatalError}
            </pre>
            <div className="mt-5 flex justify-end">
              <Button onClick={() => globalThis.location.reload()}>重新加载</Button>
            </div>
          </div>
        </div>
      )}
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-1">
            {(['edit', 'simulation'] as const).map((candidate) => (
              <Button
                key={candidate}
                size="xs"
                variant={mode === candidate ? 'default' : 'outline'}
                disabled={!ready || switching}
                onClick={() => void switchMode(candidate)}
              >
                {switching && mode !== candidate
                  ? '重置中…'
                  : candidate === 'edit'
                    ? '编辑'
                    : '仿真'}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={!ready || saveState === 'clean'}
              onClick={() => draftRef.current?.flush()}
            >
              保存
            </Button>
            <Button size="xs" variant="ghost" disabled={!ready} onClick={resetDraft}>
              重置
            </Button>
          </div>
          {error === null && saveError === null ? null : (
            <span className="text-destructive ml-auto text-[11px]">{error ?? saveError}</span>
          )}
          <Button
            size="xs"
            variant="ghost"
            className={error === null && saveError === null ? 'ml-auto' : undefined}
            onClick={() => navigate(schematicRoute(schematicExample.id))}
          >
            原理图
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="bg-card/40 flex w-52 shrink-0 flex-col overflow-y-auto border-r">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="text-xs font-semibold">组件</h2>
            </header>
            <ul className="flex flex-col gap-1 p-2">
              {palette.length === 0
                ? null
                : palette.map((entry) => (
                    <li key={entry.ref}>
                      <Button
                        size="xs"
                        variant="outline"
                        className="w-full justify-between"
                        disabled={!ready || mode === 'simulation'}
                        onClick={() => addFromPalette(entry)}
                      >
                        <span className="truncate">{entry.title}</span>
                      </Button>
                    </li>
                  ))}
            </ul>

            <header className="flex items-center gap-2 border-y px-3 py-2">
              <h2 className="text-xs font-semibold">图层</h2>
            </header>
            <ul className="flex flex-col gap-0.5 p-2">
              {rows.map((row) => {
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
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="relative min-h-0 min-w-0 flex-1">
            <div ref={containerRef} className="absolute inset-0" />
            {ready ? null : (
              <div className="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-[11px]">
                {error === null ? '加载中…' : null}
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
          </aside>
        </div>
      </div>
    </div>
  );
}
