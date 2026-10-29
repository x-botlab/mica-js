import {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  createSchematicEditor,
  type EditorState,
  type SchematicEditor,
} from '@mica-js/schematic-editor';
import {
  parseSchematic,
  type DeviceSymbolProvider,
  type PropertyValue,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PropertyPanel } from '@/components/property-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { loadPlaygroundDeviceLibrary } from '@/sim/library';
import {
  canvasExamplesFor,
  canvasRoute,
  schematicExampleById,
  type SchematicExampleId,
} from '@/examples/registry';
import { navigate, readHashParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { DEVICE_LIBRARY, SAMPLE_MCU_SYMBOL_ID, devices as sampleDevices } from '@/schematic/sample';
import type { DeviceLibrary } from '@/sim/device-library';

/** Host-side guard: model edits still throw, but the error already reached `onError`. */
function run(edit: () => void): void {
  try {
    edit();
  } catch {
    // Surface through `state.lastError`; the reference host keeps the page alive.
  }
}

export interface SchematicPageProps {
  readonly dark: boolean;
  /** Sheet this sidebar entry opens; the route decided it before the page mounted. */
  readonly exampleId: SchematicExampleId;
}

export function SchematicPage({ dark, exampleId }: SchematicPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SchematicEditor | null>(null);
  // `#/schematic/<example>?readonly` mounts a viewer: the editor refuses every edit and the host
  // hides its own editing affordances.
  const [readOnly, setReadOnly] = useState(() => readHashParams().has('readonly'));
  const [state, setState] = useState<EditorState | null>(null);
  const example = schematicExampleById(exampleId);
  const [library, setLibrary] = useState<DeviceLibrary | null>(null);
  const [sheet, setSheet] = useState<SchematicDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const sync = (): void => setReadOnly(readHashParams().has('readonly'));
    globalThis.addEventListener('hashchange', sync);
    return () => globalThis.removeEventListener('hashchange', sync);
  }, []);

  // The example registry owns the asset path; the canvas documents name the same `.sch`, so the
  // editor and the canvas device host always open one document.
  useEffect(() => {
    let cancelled = false;
    setSheet(null);
    setLoadError(null);
    void (async () => {
      try {
        const [loaded, response] = await Promise.all([
          loadPlaygroundDeviceLibrary(),
          fetch(new URL(example.document, globalThis.document.baseURI)),
        ]);
        if (!response.ok) {
          throw new Error(`读取 ${example.document} 失败（HTTP ${response.status}）`);
        }
        const parsed = parseSchematic(await response.text());
        if (cancelled) return;
        setLibrary(loaded);
        setSheet(parsed);
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [example.document]);

  /** Both symbol sources are registered: sample devices for example 1, the demo library for example 2. */
  const devices = useMemo<DeviceSymbolProvider>(
    () => ({
      getDeviceSymbol: (reference) =>
        library?.symbols.getDeviceSymbol(reference) ?? sampleDevices.getDeviceSymbol(reference),
      getDeviceName: (reference) =>
        library?.symbols.getDeviceName(reference) ?? sampleDevices.getDeviceName(reference),
      getDeviceDesignatorPrefix: (reference) =>
        library?.symbols.getDeviceDesignatorPrefix?.(reference) ??
        sampleDevices.getDeviceDesignatorPrefix?.(reference),
      getDevicePropertyDescriptors: (reference) =>
        library?.symbols.getDevicePropertyDescriptors?.(reference) ??
        sampleDevices.getDevicePropertyDescriptors?.(reference),
    }),
    [library],
  );

  const palette = useMemo(() => {
    if (example.library === 'sample') {
      return DEVICE_LIBRARY;
    }
    return (library?.entries ?? []).map((entry) => ({
      device: entry.reference,
      name: entry.displayName,
    }));
  }, [example.library, library]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || sheet === null) {
      return;
    }
    const editor = createSchematicEditor({
      container: host,
      value: sheet,
      devices,
      theme: dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME,
      readOnly,
    });
    editor.onDidChangeState(setState);
    editorRef.current = editor;
    setState(editor.getState());
    // Example 1 preselects the MCU so the host property panel opens on a device with properties;
    // the demo sheet has no per-device properties, so the first symbol is enough there.
    const preselect =
      example.library === 'sample' ? SAMPLE_MCU_SYMBOL_ID : sheet.sheet.symbols[0]?.id;
    if (preselect !== undefined) {
      editor.setSelection([{ kind: 'symbol', id: preselect }]);
    }
    if (import.meta.env.DEV) {
      // Console handle for poking at the mounted editor while developing the playground.
      Object.assign(globalThis, { mica: editor });
    }

    return () => {
      editor.dispose();
      editorRef.current = null;
      if (import.meta.env.DEV && (globalThis as { mica?: unknown }).mica === editor) {
        delete (globalThis as { mica?: unknown }).mica;
      }
    };
    // The theme updates through its own effect below; `readOnly` and the example document remount
    // the editor, because the mode and the sheet are fixed at mount time.
  }, [readOnly, sheet, devices, example.library]);

  useEffect(() => {
    editorRef.current?.setTheme(dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME);
  }, [dark]);

  const placeDevice = (device: string): void => {
    run(() => editorRef.current?.placeDevice(device));
  };

  const setDisplay = (patch: {
    grid?: boolean;
    snap?: boolean;
    labels?: boolean;
    gridSubdivisions?: number;
  }): void => {
    editorRef.current?.setDisplayOptions(patch);
  };

  const updateProperty = (symbolId: string, key: string, value: PropertyValue): void => {
    run(() => editorRef.current?.getModel().setSymbolProperty(symbolId, key, value));
  };

  const resetProperty = (symbolId: string, key: string): void => {
    run(() => editorRef.current?.getModel().removeSymbolProperty(symbolId, key));
  };

  const renameDesignator = (symbolId: string, next: string): void => {
    run(() => editorRef.current?.getModel().renameDesignator(symbolId, next));
  };

  const renameNet = (symbolId: string, next: string): void => {
    run(() => editorRef.current?.getModel().renameNet(symbolId, next));
  };

  const placingDevice = state?.placingDevice;
  const canvasExamples = canvasExamplesFor(example.id);

  return (
    <div className="grid h-full min-h-0 grid-cols-[204px_minmax(0,1fr)_324px] grid-rows-[minmax(0,1fr)] gap-3 p-3">
      {loadError === null ? null : (
        <p className="border-destructive/40 bg-destructive/10 text-destructive col-span-3 rounded-md border px-3 py-2 text-xs">
          {loadError}
        </p>
      )}
      {sheet === null ? (
        <p className="text-muted-foreground col-span-3 grid place-items-center text-xs">加载中…</p>
      ) : (
        <>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <Card className="gap-2 py-3">
              <CardHeader>
                <CardTitle>器件</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {palette.map((entry) => (
                  <button
                    key={entry.device}
                    type="button"
                    onClick={() => placeDevice(entry.device)}
                    disabled={readOnly}
                    aria-pressed={placingDevice === entry.device}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      placingDevice === entry.device && 'border-primary bg-accent',
                    )}
                  >
                    {entry.name}
                  </button>
                ))}
              </CardContent>
            </Card>

            <Card className="gap-2 py-3">
              <CardHeader>
                <CardTitle>显示</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {(
                  [
                    ['grid', '网格'],
                    ['snap', '吸附'],
                    ['labels', '引脚名'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-primary size-3.5"
                      checked={state?.display[key] ?? true}
                      onChange={(event) => {
                        const value = event.target.checked;
                        setDisplay(
                          key === 'grid'
                            ? { grid: value }
                            : key === 'snap'
                              ? { snap: value }
                              : { labels: value },
                        );
                      }}
                    />
                    {label}
                  </label>
                ))}
                <label className="mt-1 flex items-center justify-between gap-2 text-xs">
                  网格细分
                  <select
                    className="bg-background rounded-md border px-1.5 py-0.5 text-[11px]"
                    value={state?.display.gridSubdivisions ?? 2}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setDisplay({ gridSubdivisions: value });
                    }}
                  >
                    {[1, 2, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        ×{value}
                      </option>
                    ))}
                  </select>
                </label>
              </CardContent>
            </Card>

            {canvasExamples.length === 0 ? null : (
              <Card className="gap-2 py-3">
                <CardHeader>
                  <CardTitle>画布</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1">
                  {canvasExamples.map((canvas) => (
                    <button
                      key={canvas.id}
                      type="button"
                      onClick={() => navigate(canvasRoute(canvas.id))}
                      className="hover:bg-accent hover:text-accent-foreground rounded-md border px-2 py-1.5 text-left text-xs transition-colors"
                    >
                      {canvas.title}
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="xs" variant="outline" onClick={() => editorRef.current?.fitToContent()}>
                适应内容
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={state?.canUndo !== true}
                onClick={() => editorRef.current?.undo()}
              >
                撤销
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={state?.canRedo !== true}
                onClick={() => editorRef.current?.redo()}
              >
                重做
              </Button>
              {readOnly ? <Badge variant="muted">只读</Badge> : null}
            </div>
            <div
              ref={hostRef}
              className="bg-card min-h-0 flex-1 overflow-hidden rounded-xl border"
            />
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pl-1">
            <PropertyPanel
              inspector={state?.inspector}
              readOnly={readOnly}
              onPropertyChange={updateProperty}
              onPropertyReset={resetProperty}
              onDesignatorChange={renameDesignator}
              onNetChange={renameNet}
            />
          </div>
        </>
      )}

      {state?.lastError === undefined ? null : (
        <div className="bg-card pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow-lg">
          {state.lastError.message}
        </div>
      )}
    </div>
  );
}
