import {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  mountSchematicEditor,
  type EditorSelection,
  type EditorState,
  type EditorTool,
  type MountedSchematicEditor,
} from '@mica-js/schematic-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DEVICE_LIBRARY, createDesignator, devices, schematic, view } from '@/schematic/sample';
import { USAGE_SNIPPETS } from '@/schematic/snippets';

const BUILTIN_TOOLS: readonly { readonly tool: EditorTool; readonly label: string }[] = [
  { tool: 'select', label: '选择' },
  { tool: 'wire', label: '导线' },
  { tool: 'label', label: '网络标签' },
  { tool: 'power', label: '电源' },
  { tool: 'ground', label: '地' },
  { tool: 'text', label: '文本' },
];

const SELECTION_LABELS: Readonly<Record<EditorSelection['kind'], string>> = {
  symbol: '器件',
  reference: '位号',
  wire: '导线',
  junction: '交点',
  vertex: '顶点',
};

interface LogEntry {
  readonly id: number;
  readonly time: string;
  readonly text: string;
}

function describeSelection(selection: readonly EditorSelection[]): string {
  if (selection.length === 0) {
    return '空';
  }
  const counts = new Map<EditorSelection['kind'], number>();
  for (const item of selection) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => `${SELECTION_LABELS[kind]} ×${count}`).join(' · ');
}

export interface SchematicPageProps {
  readonly dark: boolean;
}

export function SchematicPage({ dark }: SchematicPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MountedSchematicEditor | null>(null);
  const mountLogged = useRef(false);
  const [state, setState] = useState<EditorState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);

  const pushLog = useCallback((text: string) => {
    setLog((entries) =>
      [
        {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          text,
        },
        ...entries,
      ].slice(0, 40),
    );
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const editor = mountSchematicEditor({
      container: host,
      schematic,
      view,
      devices,
      createDesignator,
      theme: dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME,
      onChange: (next) => {
        setState(next);
        pushLog(`onChange · ${next.tool} · ${describeSelection(next.selection)}`);
      },
      onSelectionChange: (selection) =>
        pushLog(`onSelectionChange · ${describeSelection(selection)}`),
      onToolChange: (tool) => pushLog(`onToolChange · ${tool}`),
      onError: (error) => pushLog(`onError · ${error?.message ?? 'cleared'}`),
      onViewportChange: (viewport) => setZoom(viewport.scale),
    });
    editorRef.current = editor;
    setState(editor.controller.state);
    setZoom(editor.getViewport().scale);
    if (import.meta.env.DEV) {
      // Console handle for poking at the mounted editor while developing the playground.
      Object.assign(globalThis, { mica: editor });
    }
    if (!mountLogged.current) {
      mountLogged.current = true;
      pushLog('mountSchematicEditor() · 已挂载');
    }

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // Mount once: `pushLog` is a stable callback, and the theme has its own effect below.
  }, [pushLog]);

  useEffect(() => {
    editorRef.current?.setTheme(dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME);
  }, [dark]);

  const placeDevice = (device: string): void => {
    editorRef.current?.placeDevice(device);
    pushLog(`placeDevice('${device}')`);
  };

  const selectTool = (tool: EditorTool): void => {
    const editor = editorRef.current;
    if (editor === null) {
      return;
    }
    const idle = editor.controller.placingDevice === undefined;
    const next = idle && editor.controller.tool === tool ? 'select' : tool;
    editor.cancelPlacement();
    editor.setTool(next);
    pushLog(`setTool('${next}')`);
  };

  const setDisplay = (patch: {
    grid?: boolean;
    snap?: boolean;
    labels?: boolean;
    gridSubdivisions?: number;
  }): void => {
    editorRef.current?.setDisplayOptions(patch);
    pushLog(`setDisplayOptions(${JSON.stringify(patch)})`);
  };

  const exportJson = (): void => {
    const editor = editorRef.current;
    if (editor === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([editor.toJSON()], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'schematic.sch';
    anchor.click();
    URL.revokeObjectURL(url);
    pushLog('toJSON() → schematic.sch');
  };

  const placingDevice = state?.placingDevice;
  const activeTool = placingDevice === undefined ? state?.tool : undefined;

  return (
    <div
      className={cn(
        'grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3 p-3',
        infoOpen ? 'grid-cols-[204px_minmax(0,1fr)_324px]' : 'grid-cols-[204px_minmax(0,1fr)]',
      )}
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        <Card className="gap-2 py-3">
          <CardHeader>
            <CardTitle>器件库</CardTitle>
            <CardDescription>宿主自己的列表，点击抓取后在画布上单击放置</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {DEVICE_LIBRARY.map((entry) => (
              <button
                key={entry.device}
                type="button"
                onClick={() => placeDevice(entry.device)}
                title={entry.device}
                aria-pressed={placingDevice === entry.device}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  placingDevice === entry.device && 'border-primary bg-accent',
                )}
              >
                <span className="text-xs font-medium">{entry.name}</span>
                <span className="text-muted-foreground font-mono text-[10px]">
                  {entry.prefix} · {entry.note}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="gap-2 py-3">
          <CardHeader>
            <CardTitle>内置符号</CardTitle>
            <CardDescription>只是 setTool 的另一种入口</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1">
            {BUILTIN_TOOLS.map(({ tool, label }) => (
              <Button
                key={tool}
                size="xs"
                variant={activeTool === tool ? 'default' : 'outline'}
                onClick={() => selectTool(tool)}
              >
                {label}
              </Button>
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
      </div>

      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-1.5">
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
          <Button size="xs" variant="outline" onClick={exportJson}>
            导出 .sch
          </Button>
          <Button
            size="xs"
            variant={infoOpen ? 'default' : 'outline'}
            onClick={() => setInfoOpen((open) => !open)}
          >
            用法与事件
          </Button>
          <div className="text-muted-foreground ml-auto flex items-center gap-2 text-[11px]">
            <span className="font-mono">{zoom.toFixed(2)}×</span>
            <span>拖动导线段 · 空格旋转 · Esc 取消 · 滚轮缩放</span>
          </div>
        </div>
        <div ref={hostRef} className="bg-card min-h-0 flex-1 overflow-hidden rounded-xl border" />
      </div>

      {infoOpen ? (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pl-1">
          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle>用法</CardTitle>
              <CardDescription>这段代码就是本页做的事</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {USAGE_SNIPPETS.map((snippet, index) => (
                <details
                  key={snippet.title}
                  open={index === 0}
                  className="group rounded-md border px-2 py-1.5"
                >
                  <summary className="cursor-pointer text-xs font-medium">{snippet.title}</summary>
                  <p className="text-muted-foreground mt-1 text-[11px]">{snippet.note}</p>
                  <pre className="mt-1.5 overflow-x-auto font-mono text-[10.5px] leading-[1.6]">
                    {snippet.code}
                  </pre>
                </details>
              ))}
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle>状态</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
              <span className="text-muted-foreground">工具</span>
              <span className="font-mono">{state?.tool ?? '—'}</span>
              <span className="text-muted-foreground">抓取</span>
              <span className="truncate font-mono">{placingDevice ?? '—'}</span>
              <span className="text-muted-foreground">选中</span>
              <span>{state === null ? '—' : describeSelection(state.selection)}</span>
              <span className="text-muted-foreground">图元</span>
              <span className="font-mono">
                {state === null
                  ? '—'
                  : `${state.document.sheet.symbols.length} 器件 · ${state.document.sheet.wires.length} 导线`}
              </span>
              <span className="text-muted-foreground">错误</span>
              <span className="truncate">{state?.lastError?.message ?? '—'}</span>
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                事件
                <Badge variant="muted">{log.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-[10.5px]">
              {log.length === 0 ? (
                <span className="text-muted-foreground">等待交互…</span>
              ) : (
                log.map((entry) => (
                  <div key={entry.id} className="flex gap-2">
                    <span className="text-muted-foreground/70 shrink-0">{entry.time}</span>
                    <span className="break-all">{entry.text}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
