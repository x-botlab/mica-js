import {
  createCanvasEditor,
  DARK_CANVAS_THEME,
  LIGHT_CANVAS_THEME,
  type CanvasEditor,
  type CanvasMode,
} from '@mica-js/canvas-editor';
import { timePs } from '@mica-js/core';
import { serializeCanvas, type CanvasCommand, type CanvasDocument } from '@mica-js/core/canvas';
import { createCircuitExecutor, type DeviceSimExecutor } from '@mica-js/simulator';
import {
  createWidgetHost,
  type WidgetAssetProvider,
  type WidgetDefinition,
  type WidgetHost,
  type WidgetProvider,
} from '@mica-js/widget';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPaletteInstance, paletteEntries, type PaletteEntry } from '@/canvas/palette';
import { commandErrorMessages, describeTarget, type TopicCandidate } from '@/canvas/panel-model';
import type { CanvasExampleDefinition } from '@/examples/types';
import { CanvasInspector } from '@/components/canvas-inspector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getSimulationDevices, getWidgetRegistry } from '@/lib/registry';
import { resolvePlaygroundDevice } from '@/devices';

/** Virtual time one run-mode tick advances (30 ms). */
const DRIVER_STEP_PS = timePs(30_000_000);
const DRIVER_INTERVAL_MS = 30;

const ASSETS: WidgetAssetProvider = {
  async resolve(ref) {
    const response = await fetch(new URL(ref.src, globalThis.document.baseURI));
    if (!response.ok) {
      throw new Error(`读取 ${ref.src} 失败（HTTP ${response.status}）`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

interface DiagnosticEntry {
  readonly id: number;
  readonly code: string;
  readonly message: string;
}

interface PublishEntry {
  readonly id: number;
  readonly direction: 'widget' | 'device';
  readonly endpoint: string;
  readonly payload: string;
  readonly simTime: number;
}

/** Monotonic entry id: Date.now() + random collided often enough to duplicate React keys. */
let nextEntryId = 0;

function nextId(): number {
  nextEntryId += 1;
  return nextEntryId;
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

export interface CanvasExampleViewProps {
  readonly dark: boolean;
  readonly example: CanvasExampleDefinition;
}

/**
 * Shared host for every canvas example: it owns the widget host, the simulation
 * bridge and the 30 ms driver, so pages only describe a `.cnv` document.
 */
export function CanvasExampleView({ dark, example }: CanvasExampleViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CanvasEditor | null>(null);
  const hostRef = useRef<WidgetHost | null>(null);
  const executorRef = useRef<DeviceSimExecutor | null>(null);
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
  const topicsRef = useRef<readonly TopicCandidate[]>([]);
  const [palette, setPalette] = useState<readonly PaletteEntry[]>([]);
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

  const recordPublish = useCallback(
    (
      direction: 'widget' | 'device',
      target: { readonly symbol: string; readonly port: string },
      payload: unknown,
      simTime: number,
    ) => {
      setPublishes((entries) => {
        const endpoint = describeTarget(target, topicsRef.current);
        const text = describePayload(payload);
        const last = entries[0];
        // Devices re-publish unchanged values every tick; showing each one buries the transitions.
        if (last !== undefined && last.direction === direction && last.endpoint === endpoint) {
          if (last.payload === text) {
            return entries;
          }
        }
        return [{ id: nextId(), direction, endpoint, payload: text, simTime }, ...entries].slice(
          0,
          40,
        );
      });
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
    let scene: CanvasEditor | undefined;
    let executor: DeviceSimExecutor | undefined;

    const start = async (): Promise<void> => {
      try {
        const registry = await getWidgetRegistry();
        const ownedExecutor = createCircuitExecutor({
          devices: getSimulationDevices(),
          resolveDevice: resolvePlaygroundDevice,
          onDiagnostic: pushDiagnostic,
        });
        executor = ownedExecutor;

        if (example.schematic !== undefined) {
          await ownedExecutor.loadSchematic(example.schematic);
        }
        topicsRef.current = ownedExecutor.getTopics();
        setTopics(topicsRef.current);

        const ownedHost = createWidgetHost({
          provider: registry.provider,
          assets: ASSETS,
          simulation: ownedExecutor,
          onDiagnostic: pushDiagnostic,
          onPublish: (publish) => scene?.receivePublish(publish),
        });
        host = ownedHost;

        const created = await createCanvasEditor({
          container,
          document: example.document,
          host: ownedHost,
          mode: 'edit',
          theme: dark ? DARK_CANVAS_THEME : LIGHT_CANVAS_THEME,
          onChange: (next) => {
            setDocument(next);
            setRevision((value) => value + 1);
          },
          onSelectionChange: (ids) => setSelectedIds(ids),
          onDiagnostic: pushDiagnostic,
        });
        created.onPublish((target, payload, simTime) => {
          recordPublish('widget', target, payload, simTime);
        });
        ownedExecutor.onPublish(({ target, payload, simTime }) => {
          recordPublish('device', target, payload, simTime);
        });

        const resolved = await resolveDefinitions(registry.provider, created.getDocument());
        if (cancelled) {
          created.destroy();
          ownedExecutor.dispose();
          void ownedHost.dispose();
          return;
        }

        scene = created;
        sceneRef.current = created;
        hostRef.current = ownedHost;
        executorRef.current = ownedExecutor;
        setDocument(created.getDocument());
        setDefinitions(resolved);
        setPalette(registry.packages.flatMap((entry) => paletteEntries(entry.id, entry.modules)));
        setReady(true);
        if (import.meta.env.DEV) {
          // Console handles the e2e suite reads the mounted scene through.
          Object.assign(globalThis, {
            micaCanvas: created,
            micaWidgetHost: ownedHost,
            micaSimulator: ownedExecutor,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause));
          executor?.dispose();
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
      executorRef.current = null;
      executor?.dispose();
      void host?.dispose();
      executor = undefined;
      host = undefined;
    };
    // A canvas editor has no `setTheme`, so a theme flip remounts it with its host.
  }, [dark, example, pushDiagnostic, recordPublish]);

  useEffect(() => {
    if (!ready || mode !== 'run') {
      return;
    }
    const executor = executorRef.current;
    if (executor === null || executor.getState() !== 'ready') {
      // No schematic in this example: the widget host still ticks on its own.
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
        driverActive.current = false;
        setError(`仿真推进失败：${describeError(cause)}`);
      }
    };
    // One step right away, so bindings light up instead of waiting for the interval.
    drive();
    const timer = globalThis.setInterval(drive, DRIVER_INTERVAL_MS);
    return () => {
      driverActive.current = false;
      globalThis.clearInterval(timer);
    };
  }, [mode, ready]);

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
        const messages = commandErrorMessages(cause);
        for (const message of messages) {
          pushDiagnostic({ code: 'canvas-editor/command-failed', message });
        }
        return messages;
      }
    },
    [pushDiagnostic],
  );

  const switchMode = async (next: CanvasMode): Promise<void> => {
    const scene = sceneRef.current;
    if (scene === null || switching || next === mode) {
      return;
    }
    driverActive.current = false;
    setSwitching(true);
    setError(null);
    try {
      await scene.setMode(next);
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
    const text = serializeCanvas(scene.getDocument());
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    try {
      const anchor = globalThis.document.createElement('a');
      anchor.href = url;
      anchor.download = `${example.id}.cnv`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-example={example.id}>
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
        <Button size="xs" variant="ghost" disabled={!ready} onClick={exportDocument}>
          导出 .cnv
        </Button>
        <p className="text-muted-foreground ml-auto min-w-0 truncate text-[11px]">
          {error ?? example.summary}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {example.showPalette === true ? (
          <aside className="bg-card/40 flex w-52 shrink-0 flex-col overflow-y-auto border-r">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="text-xs font-semibold">组件</h2>
              <span className="text-muted-foreground truncate text-[10px]">
                {palette.length} 个
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
                      title={entry.ref}
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
          </aside>
        ) : null}

        <div className="relative min-h-0 min-w-0 flex-1">
          <div ref={containerRef} className="absolute inset-0" data-editor={example.id} />
          {ready ? null : (
            <div className="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-[11px]">
              {error === null ? '加载 widget 包…' : null}
            </div>
          )}
        </div>

        <aside className="bg-card/40 flex w-80 shrink-0 flex-col overflow-y-auto border-l">
          <CanvasInspector
            mode={mode}
            instance={selectedInstance}
            definition={selectedDefinition}
            resolving={!ready}
            revision={revision}
            targets={topics}
            onApply={applyCommand}
          />

          <section className="flex flex-col border-t">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="text-xs font-semibold">诊断</h2>
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
            <ul className="max-h-40 overflow-y-auto p-2 text-[11px]">
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
            <ul className="max-h-40 overflow-y-auto p-2 font-mono text-[11px]">
              {publishes.length === 0 ? (
                <li className="text-muted-foreground px-1 font-sans">运行模式下点击控件试试。</li>
              ) : (
                publishes.map((entry) => (
                  <li key={entry.id} className="flex gap-2 border-b py-1 last:border-b-0">
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
